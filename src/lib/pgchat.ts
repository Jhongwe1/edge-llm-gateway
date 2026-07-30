// src/lib/pgchat.ts — Playground 聊天的「引擎」：打上游、轉成統一 SSE、存回 D1。
//
// 這個檔案是 v2.5_DO 的核心搬遷（ADR-0015）。內容幾乎原封不動來自
// routes/api/playground/chat.ts —— 差別只在「它在哪裡跑」：
//
//   Worker（免費方案 10ms CPU）  ← 以前住這裡，長回覆必爆
//   Durable Object（30s CPU）    ← 現在住這裡
//
// 為什麼要抽成獨立模組而不是直接寫進 DO 類別：**同一份程式要能在兩個宿主跑**。
//   * 正常路徑：routes 交棒給 PgStream DO（env.PG_STREAM 綁著、settings.pg_do≠'0'）
//   * 退路：DO 沒綁定或被一鍵關掉 → routes 直接在 Worker 裡呼叫這支
//     （＝v2.4 的行為，CPU 問題原樣回來，但站台不會掛）
// 兩條路跑的是同一份程式，所以既有測試涵蓋的就是正式路徑的邏輯本身，
// 不會出現「測到的是 Worker 版、上線跑的是 DO 版」這種假涵蓋率。
//
// 宿主差異只有一處，用 bg() 參數吸收 ——「背景工作要怎樣才不會被砍」兩邊規則不同：
//   Worker：一定要掛 ctx.waitUntil，否則回應一送出就被砍。
//   DO：waitUntil **沒有作用**（官方文件明講）。規則改成「只要還有 pending I/O 就活著」，
//     所以串流路徑什麼都不用做（pump 自己握著上游 reader），但**錯誤路徑要自己 await**
//     —— 那條路上沒有串流撐著，浮著的 errlog 寫入會被當成閒置回收。細節見 do/pg-stream.ts。
//   這也順帶把 v2.4「背景續跑最多 30 秒」的天花板拆了，見 BG 的註解。
import { json } from "./site.js";
import {
  buildUpstream,
  pgDefaultSystem,
  extractDelta,
  extractReasoning,
  extractFull,
  extractUsage,
  loadImages,
  imgBytesBudget
} from "./playground.js";
import { maxImagesFor, seesImagesFor, imgLimitFromError, learnImgLimit } from "./modelcaps.js";
import { fastDelta } from "./fastsse.js";
import { reportError, reportErrorNow } from "./observe.js";
import type { ChatMsg, UsageAcc } from "./playground.js";
import type { ChannelRow, Env } from "../types.js";

// 會員看的上游錯誤一律用「安全分類字」— 上游的原始錯誤內容（格式、文件連結、專案編號）
// 會洩漏真實提供商身分，只有管理員能看原文（除錯用）。
//
// ⚠️ 這支函式就是 v2.5_DO 存在的理由。v2.5 的原生直通把上游 SSE 位元組原樣送給瀏覽器，
// 每一筆 chunk 都帶著 "model":"<真名>"（OpenRouter 還帶 provider、Groq 帶 x_groq），
// 等於繞過了這裡所有的淨化 —— 隱藏上游的初衷被架構本身取消掉。
// DO 版把轉譯留著、只換執行的地方，所以淨化完整保留。
export function safeHint(status: number): string {
  if (status === 401 || status === 403) return "渠道憑證可能失效，請聯絡管理員";
  if (status === 429) return "上游流量限制，請稍後再試";
  if (status >= 500) return "上游暫時故障，請稍後再試";
  return "上游回應異常（HTTP " + status + "）";
}

// ── 斷線後的「背景續跑」預算（2026-07-21）──
// 舊行為是瀏覽器一斷線就掐斷上游，只存得到已生成的半截；會員若在模型「還在思考」時
// 關掉網頁，正文一個字都還沒出來，D1 連 assistant 那一列都不會有 —— 回來看是空的。
// 現在改成背景繼續讀完再存，但必須有上限：
//
// 三個常數都是線上實測定出來的（2026-07-21，wrangler tail 加臨時探針），不是估的。
// 時間軸以「使用者關掉分頁」那一刻為 D：
//
//   D+0     客戶端離線。Cloudflare 不通知，串流也不會被取消（見 send() 的註解）
//   D+5s    hangMs 逾時 → 判定斷線，開始算續跑預算
//   D+25s   budgetMs 到期 → 主動收工
//   D+27s   收尾 batch 寫完（assistant 內容＋conversation＋req_log）
//
// ⚠️ v2.5_DO 起，上面那條時間軸**少了最後一格**。以前還有一行：
//     D+30s   ← 天花板：waitUntil 被砍
//   budgetMs 訂在 20 秒就是為了替它留 3 秒收尾餘裕。搬進 DO 之後 waitUntil 不再參與
//   （DO 只要有 pending I/O 就活著、沒有 invocation end 這回事），那個天花板消失了。
//   **但這一版刻意不動這三個數字** —— 放寬續跑預算是行為改變（會多花 DO 的 GB-s
//   計費時間、也會讓「按停止」之後上游繼續跑更久），值得單獨決定，不該搭這班車偷渡。
//   要放寬的話這裡是唯一的旋鈕，且不再有 30 秒硬上限（見 DEBT #15/#16）。
//
// budgetMs — 20 秒（從判定斷線起算）。
// ckMs — 3 秒存一次已生成內容（同一列 UPDATE）。這是被拔電源時的保命索：
//   實測過一次 120 秒被砍，收尾沒跑，但**靠階段性存檔留住了 1798 字**。沒有它就是全丟。
//   間隔＝被砍時最多損失幾秒的字，所以壓到 3 秒。
// hangMs — 5 秒。刻意不再壓低：真正連著的客戶端若讓單次 flush 卡超過 5 秒（爛網路、
//   手機切換基地台）會被誤判成離線，代價是畫面停止更新、要重新整理才看得到後續。
//
// 用可變物件而不是 const：測試要能改小值驗證這幾條路徑（見 playground-chat.test.ts）。
export const BG = { budgetMs: 20000, ckMs: 3000, hangMs: 5000 };

/**
 * 交棒給 Durable Object 的總開關（settings.pg_do）。'0'＝關掉，其他值／沒設＝開。
 *
 * 跟 quota_do='0'（ADR-0007）、relay_meter 同一套慣例：**免部署就能一鍵退回舊行為**。
 * 這很重要 —— DO 那一側出問題時（部署漂移、Cloudflare 區域故障、我們自己寫壞了），
 * 站長不必等一次 deploy 才能讓 Playground 恢復能用。代價是長回覆會再撞 10ms 上限，
 * 那是「退化」不是「壞掉」，比整個服務不能用好。
 *
 * 查不到／D1 壞掉一律回 true（fail-open 到新路徑）：正常運作的環境本來就沒有這一列。
 */
export async function pgDoOn(env: Env): Promise<boolean> {
  try {
    const r = await env.DB.prepare("SELECT v FROM settings WHERE k='pg_do'").first<{ v: string }>();
    return String((r && r.v) || "") !== "0";
  } catch (e) {
    return true;
  }
}

/**
 * 交給引擎的一趟聊天。routes 已經做完的事（驗身分、配額、驗輸入、開對話、存 user 訊息、
 * 綁附件）不會在這裡重做 —— 這裡拿到的每個欄位都是**已經驗過的結果**。
 *
 * 為什麼 messages 不放在這個介面裡：見 do/pg-stream.ts 的信封格式註解 ——
 * 交棒給 DO 時 messages 是原始請求本體「原樣轉送」的，不經過第二次序列化。
 */
export interface ChatJob {
  userId: number; // req_log／errlog 的記帳身分（demo 走 demo:public 那一列）
  isAdm: boolean; // 管理員看得到上游錯誤原文，會員只看 safeHint()
  convId: number;
  newTitle: string | null; // 這趟開了新對話才有（前端要拿去更新列表）
  channel: string; // 渠道 slug（req_log 用；ch.slug 同值）
  model: string;
  ch: ChannelRow;
  demo: boolean; // 體驗模式：前端靠這個旗標知道別去動對話列表
  demoMaxTokens: number; // 0＝不限（buildUpstream 收到 0 就不設 max_tokens）
}

/**
 * 跑完一趟聊天，回傳要給瀏覽器的 Response。
 *
 * 回傳的兩種形狀跟 v2.4 完全一致（對外契約沒有改變）：
 *   * 上游一開始就失敗 → JSON 錯誤（帶 conv，前端才不會重複開對話）
 *   * 上游 OK → text/event-stream，事件見 routes/api/playground/chat.ts 檔頭
 *
 * @param bg  背景排程器。Worker 宿主傳 ctx.waitUntil；DO 宿主收集起來自己處理（見檔頭）。
 * @param signal 客戶端斷線訊號。實測不會觸發（見下方註解），備而不用。
 */
export async function runChat(
  env: Env,
  job: ChatJob,
  messages: ChatMsg[],
  bg: (p: Promise<unknown>) => void,
  signal?: AbortSignal | null
): Promise<Response> {
  const ch = job.ch;
  const convId = job.convId;

  // 檔案編號 → 實際 base64 內容（含總量預算與降級，見 loadImages）。
  // 張數上限來自「上游自己回報的模型能力」快取（migration 0009，見 lib/modelcaps.ts）——
  // 有些模型單次只吃 1 張，照站上寫死的 4 張送過去就是一發 400（2026-07-30 事故）。
  //
  // ⚠️ 這一段就是 ADR-0015 量到的「請求側 59ms」：讀 R2 物件＋把 5.75MB base64 拼進
  // 上游 body。v2.5 的原生直通完全沒有解決它（直通只砍掉「回應側」隨長度成長的成本），
  // 它在 Worker 裡是 10ms 預算的 6 倍；搬進 DO 之後是 30s 預算的 0.2%。
  const sees = seesImagesFor(ch, job.model);
  const imgLoad = await loadImages(
    env,
    job.userId,
    messages,
    sees,
    maxImagesFor(ch, job.model),
    await imgBytesBudget(env)
  );
  if (imgLoad.err) return json({ error: "no-vision", hint: imgLoad.err, conv: convId }, 400);

  // 打上游（demo 有填 demo_max_tokens 才壓回覆長度；留空＝0＝跟會員路徑一樣不設限）
  // 站台預設系統提示詞只在「這個管道自己沒填」時才需要查 — 有填的話那一查是純浪費。
  const defSys = String(ch.system_prompt || "").trim() ? "" : await pgDefaultSystem(env);
  // ⚠️ 這裡**量不到** buildUpstream 的 CPU 時間，不要再試（2026-07-30 實測踩過）。
  // Workers 為了防時序攻擊，Date.now()／performance.now() **只在 I/O 之後才前進**；
  // buildUpstream 全程沒有 I/O，所以前後兩次讀到的是同一個值，差值**恆為 0**。
  // 想知道真正的 CPU 時間只有 wrangler tail 與 dashboard 兩條路，都在程式外面。
  const up = buildUpstream(ch, job.model, messages, job.demoMaxTokens || undefined, defSys);
  const t0 = Date.now();
  let resp: Response;
  try {
    resp = await fetch(up.url, { method: "POST", headers: up.headers, body: up.body });
  } catch (e: any) {
    // fetch 例外訊息可能含主機名 → 只有管理員看得到；站內 errlog 留完整一筆
    reportError(env, bg, "pg.upstream", e, { user_id: job.userId, path: "/playground/" + job.channel });
    return json(
      {
        error: "upstream-unreachable",
        hint: "連不上上游（" + ch.name + "）",
        conv: convId,
        detail: job.isAdm ? String((e && e.message) || e) : undefined
      },
      502
    );
  }
  if (!resp.ok) {
    const detail = String(
      await resp.text().catch(function () {
        return "";
      })
    ).slice(0, 2000);
    reportError(env, bg, "pg.upstream", "上游回應 HTTP " + resp.status, {
      user_id: job.userId,
      path: "/playground/" + job.channel,
      detail: detail
    });
    // ── 從失敗裡學回真正的張數上限（2026-07-29）──
    // 上游宣稱的 maxImages 會騙人（google-gemma-4-31b-it 說 10、實際只吃 1），
    // 但它回錯誤時會把真正的數字寫在訊息裡。記進 seen，下一次就會在送出前先砍好。
    const learned = imgLimitFromError(detail);
    if (learned !== null) {
      bg(learnImgLimit(env, ch, job.model, learned));
      // 這句不含上游身分（沒有提供商名稱、網址、原始錯誤），會員看得到全文
      return json(
        {
          error: "too-many-images",
          hint:
            "這個模型一次只看得懂 " + learned + " 張圖（已自動記住）— 請移除多餘的圖片再送一次，或換一個模型",
          conv: convId
        },
        400
      );
    }
    if (!job.isAdm) return json({ error: "upstream-error", hint: safeHint(resp.status), conv: convId }, 502);
    return json(
      { error: "upstream-error", hint: "上游回應 " + resp.status, conv: convId, detail: detail },
      502
    );
  }

  // 統一 SSE 輸出；上游讀取與 D1 寫入在背景跑，回應先開始流
  const ts = new TransformStream();
  const writer = ts.writable.getWriter();
  const enc = new TextEncoder();
  // ── 斷線偵測（2026-07-21 線上實測後改寫，這段的前身是錯的）──
  // 原本寫成「瀏覽器一斷線，往串流寫入就會失敗 → catch 裡設 gone」。實測推翻：
  // 客戶端離線時 Cloudflare **不會**取消這條回應串流，沒有人讀 → 背壓永遠不解除 →
  // writer.write() 既不 resolve 也不 reject，就是永遠不回來。程式卡在 await，最後被
  // 判定 "code had hung and would never generate a response" 整個請求 canceled。
  // 所以偵測改成靠**寫入逾時**當死鎖斷路器：單次寫入卡超過 BG.hangMs 就判定對面不在。
  //
  // v2.5_DO 的差異：現在中間多了一段 DO → Worker。客戶端斷線時 Worker 的回應被取消，
  // 連帶取消它對 DO 的子請求 → 這裡的 write 有機會**真的被 reject**（reason=write-rejected），
  // 比枯等 5 秒逾時快。兩條偵測路徑本來就都在，不必改；只是快路徑變得可能會走到了。
  let gone = false,
    goneAt = 0; // 斷線時刻 — 續跑預算從這裡起算
  // 記一筆 errlog（2026-07-22）：hangMs 分不出「使用者關了網頁」與「手機網路卡了 5 秒」。
  // 誤判時會員的串流會無聲停住，而在這之前**沒有任何方式能知道誤判率**。
  // 記下判定原因與發生時間點之後，BG 那幾個常數的調校就從猜測變成量測。
  function markGone(reason: string) {
    if (gone) return;
    gone = true;
    goneAt = Date.now();
    reportError(env, bg, "pg.hang", "客戶端判定離線（" + reason + "）", {
      user_id: job.userId,
      path: "/playground/" + job.channel,
      detail: "reason=" + reason + " elapsed_ms=" + (goneAt - t0)
    });
  }
  function send(obj: unknown): Promise<void> {
    if (gone) return Promise.resolve();
    let timer: ReturnType<typeof setTimeout> | null = null;
    // 注意不能寫成 .catch(markGone)：那會把 rejection 的理由當成 reason 參數傳進去。
    const wrote = writer.write(enc.encode("data: " + JSON.stringify(obj) + "\n\n")).catch(function () {
      markGone("write-rejected");
    });
    const guard = new Promise<void>(function (res) {
      timer = setTimeout(function () {
        markGone("hang"); // 卡這麼久＝對面已經不在了
        res();
      }, BG.hangMs);
    });
    return Promise.race([wrote, guard]).then(function () {
      if (timer) clearTimeout(timer);
    });
  }
  // ⚠️ signal：**實測（2026-07-21）它不會觸發**。屬性存在（TS 型別有、執行期也不是
  // undefined），但客戶端關掉分頁後 abort 事件從來沒有送達。所以真正在偵測的是上面的
  // hangMs，這段等於備而不用：留著是因為成本趨近於零，哪天 Cloudflare 補上就自動變快路徑。
  // 不要把它當成有效的偵測手段拿掉 hangMs —— 那會讓死鎖原封不動回來。
  if (signal) {
    if (signal.aborted) markGone("abort-signal");
    else
      signal.addEventListener("abort", function () {
        markGone("abort-signal");
        // 順手把卡住的那次 write 弄斷，否則它會一直掛著（不 await，避免又是一次可能卡住的等待）
        try {
          void writer.abort();
        } catch (e) {}
      });
  }
  const ct = String(resp.headers.get("content-type") || "");
  const ttfb = Date.now() - t0; // 上游回應標頭到手的時間
  const usage: UsageAcc = { tokens_in: null, tokens_out: null }; // 上游回報的 token 用量（掃不到＝NULL）

  const pump = (async function () {
    let full = "",
      errMsg: string | null = null,
      sawReasoning = false, // 這趟有沒有收到思考增量（決定空回覆時的提示怎麼寫）
      emptyOut = false; // 上游有回應、但整趟沒給出任何正式內容

    // ── 增量批次送出（2026-07-21）──
    // 以前每收到一筆上游增量就 JSON.stringify＋編碼＋寫一次串流。ADR-0015 的線上量測
    // 已經證明**這不是 CPU 的大頭**（放寬 flush 門檻對 CPU 毫無幫助），真正的成本是
    // 「JS 有沒有碰到那些位元組」。但批次合併仍然留著，理由改成它原本就成立的那個：
    // 691 筆增量合併成幾十次寫入，對瀏覽器與中間每一層都比較便宜，而畫面看起來一樣。
    // 註：Workers 的 Date.now() 只在 I/O 後前進，而每次 reader.read() 都是 I/O，
    //     所以時間門檻會照常生效；字數門檻是保險。
    let pend = "",
      pendKind: "r" | "d" | null = null,
      lastFlush = Date.now();
    async function flush() {
      if (!pend || !pendKind) return;
      const payload = pendKind === "r" ? { r: pend } : { d: pend };
      pend = "";
      lastFlush = Date.now();
      await send(payload);
    }
    // 思考與正文分開累積，型別一換就先送出 — 兩者的先後順序不會被打亂
    async function push(kind: "r" | "d", text: string) {
      // 斷線後沒有人在看：輸出側（stringify＋編碼＋寫串流）整個省掉。
      if (gone) return;
      if (pendKind !== kind) {
        await flush();
        pendKind = kind;
      }
      pend += text;
      // 100ms／1000 字：約每秒 10 次更新，肉眼仍是流暢的逐字浮現。
      if (pend.length >= 1000 || Date.now() - lastFlush >= 100) await flush();
    }

    // ── 斷線後的續跑控制 ──
    let asstId: number | null = null, // 續跑期間存下的 assistant 列（之後都改 UPDATE 同一列）
      // 上次階段性存檔時距離斷線過了多久。初值取負的一個間隔＝斷線後只要有內容就「立刻」
      // 先存一次，之後才進入每 ckMs 一次的節奏。這一步是「最壞情況不比舊行為差」的關鍵。
      lastCk = -BG.ckMs;
    // 續跑期間把已生成內容存一次；失敗就算了（收尾時還會再存一次，這裡只是保險）
    async function checkpoint() {
      try {
        if (asstId) {
          await env.DB.prepare("UPDATE pg_messages SET content=?1 WHERE id=?2").bind(full, asstId).run();
        } else {
          const r = await env.DB.prepare(
            "INSERT INTO pg_messages (conv_id,role,content,model,created_at) VALUES (?1,'assistant',?2,?3,?4)"
          )
            .bind(convId, full, job.model, new Date().toISOString())
            .run();
          asstId = r.meta.last_row_id as number;
        }
      } catch (e) {}
    }
    // 回 true＝該收工了（預算用完）。呼叫端一律寫成 `gone && (await bgStop())`：
    // 沒斷線時被 && 短路，連 promise 都不會配置 —— 串流迴圈裡的每一行都會跑上千次。
    async function bgStop(): Promise<boolean> {
      if (!gone) return false;
      const el = Date.now() - goneAt;
      if (el >= BG.budgetMs) return true;
      if (full && el - lastCk >= BG.ckMs) {
        lastCk = el;
        await checkpoint();
      }
      return false;
    }
    try {
      // demo 也拿得到對話編號（前端靠它把同一頁的後續訊息串成同一則對話），
      // 額外標 demo:true 讓前端知道別去動對話列表 —— 體驗模式根本沒有列表。
      const first: Record<string, unknown> = { conv: convId };
      if (job.newTitle) first.title = job.newTitle;
      if (job.demo) first.demo = true;
      await send(first);
      if (ct.indexOf("json") >= 0 && ct.indexOf("event-stream") < 0) {
        // 上游不理 stream:true、直接回整包 JSON → 一次送完（相容便宜渠道的怪行為）
        const j: any = await resp.json();
        extractUsage(ch.kind, j, usage);
        full = extractFull(ch.kind, j) || "";
        if (full) await send({ d: full });
        else errMsg = "上游沒有回覆內容";
      } else {
        const reader = resp.body!.getReader();
        const dec = new TextDecoder();
        let buf = "";
        // anthropic／gemini 的增量形狀跟 OpenAI 完全不同，套不上快速路徑的正則 —
        // 這兩種一律走完整解析（gemini 的 chunk 數量本來就比 OpenAI 少一個量級）
        const slowKind = ch.kind === "anthropic" || ch.kind === "gemini";
        readLoop: while (true) {
          const step = await reader.read();
          if (step.done) break;
          buf += dec.decode(step.value, { stream: true });
          let idx;
          while ((idx = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, idx).replace(/\r$/, "");
            buf = buf.slice(idx + 1);
            if (line.indexOf("data:") !== 0) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            // ── 快速路徑（2026-07-21，lib/fastsse.ts）──
            // 佔絕大多數的「純文字增量」不做完整 JSON.parse — V8 為每一筆建出整棵
            // 物件樹（外加上萬個短命物件觸發 GC）才是解析側的成本大頭。
            // 實測 5982 個增量：完整解析 9.01ms → 快速路徑約 4.2ms。
            // 回傳 null＝形狀不符或帶 error／usage，照原路完整解析，正確性優先。
            //
            // DO 的 30s 預算下這個最佳化不再是生死線，但留著沒有壞處：它省的是
            // 真金白銀的 GB-s 計費時間，而且已經有測試釘住兩條路徑的等價性。
            if (!slowKind) {
              const fast = fastDelta(payload);
              if (fast) {
                if (fast.r) {
                  sawReasoning = true;
                  await push("r", fast.r);
                }
                if (fast.d) {
                  full += fast.d;
                  await push("d", fast.d);
                }
                if (gone && (await bgStop())) break readLoop;
                continue;
              }
            }
            let j: any = null;
            try {
              j = JSON.parse(payload);
            } catch (e) {
              continue;
            }
            extractUsage(ch.kind, j, usage);
            let t = "";
            try {
              t = extractDelta(ch.kind, j);
            } catch (e: any) {
              errMsg = String((e && e.message) || e);
              break readLoop;
            }
            // 思考增量走獨立事件（前端畫成可摺疊的「思考中…」區塊）。
            // 不併進 full — 存進 D1 的只有正式回覆，思考過程不落地。
            const rd = extractReasoning(ch.kind, j);
            if (rd) {
              sawReasoning = true;
              await push("r", rd);
            }
            if (t) {
              full += t;
              await push("d", t);
            }
            if (gone && (await bgStop())) break readLoop;
          }
        }
        await flush(); // 收尾：把還沒滿門檻的殘量送出去
        if (gone || errMsg) {
          try {
            reader.cancel();
          } catch (e) {}
        }
      }
    } catch (e: any) {
      errMsg = errMsg || String((e && e.message) || e);
    }
    // 例外路徑會跳過迴圈尾端的 flush — 這裡再保險一次（沒殘量就是 no-op）
    try {
      await flush();
    } catch (e) {}
    // 上游正常結束、卻連一個字的正文都沒有 → 不能靜默收場。
    // 會員自己按停止（gone）不算異常。
    if (!full && !errMsg && !gone) emptyOut = true;
    // 存回 D1（部分回應也存 — 續跑預算用完、或上游中途出錯時，已生成的內容都留著）。
    // demo 的對話同樣落地：管理員要在 /logs 看得到匿名試聊聊了什麼。
    //
    // ⚠️ 這一批**一定要在 done 事件之前寫完**（測試靠這個性質：讀完串流就代表 D1 已落地）。
    try {
      const t2 = new Date().toISOString();
      const stmts: D1PreparedStatement[] = [];
      if (asstId) {
        // 續跑期間已經存過 → 補成最終內容（同一列，不會變成兩則回覆）
        stmts.push(env.DB.prepare("UPDATE pg_messages SET content=?1 WHERE id=?2").bind(full, asstId));
      } else if (full) {
        stmts.push(
          env.DB.prepare(
            "INSERT INTO pg_messages (conv_id,role,content,model,created_at) VALUES (?1,'assistant',?2,?3,?4)"
          ).bind(convId, full, job.model, t2)
        );
      }
      stmts.push(
        env.DB.prepare("UPDATE pg_conversations SET updated_at=?1, channel=?2, model=?3 WHERE id=?4").bind(
          t2,
          job.channel,
          job.model,
          convId
        )
      );
      // 計量：req_log 併進同一個 batch（配額計數與延遲/成本研究數據共用）
      stmts.push(
        env.DB.prepare(
          "INSERT INTO req_log (ts,user_id,svc,channel,model,status,dur_ms,ttfb_ms,tokens_in,tokens_out,img_bytes,build_ms) " +
            "VALUES (?1,?2,'pg',?3,?4,?5,?6,?7,?8,?9,?10,?11)"
        ).bind(
          t2,
          job.userId,
          job.channel,
          job.model,
          resp.status,
          Date.now() - t0,
          ttfb,
          usage.tokens_in,
          usage.tokens_out,
          // 沒帶圖的請求留 NULL —— 之後查分佈時 WHERE img_bytes IS NOT NULL
          // 就直接把純文字那些濾掉了
          imgLoad.imgBytes == null ? null : imgLoad.imgBytes,
          // build_ms 永遠是 NULL：量不到 CPU 時間（理由見上面 buildUpstream 前的註解）。
          // 欄位留著不刪，是為了讓「已經試過、此路不通」這件事留在 schema 上。
          null
        )
      );
      await env.DB.batch(stmts);
    } catch (e) {
      // 持久化失敗＝會員的回覆沒存進去 — 一定要留痕跡（直接 await，不靠背景排程）
      await reportErrorNow(env, "pg.persist", e, {
        user_id: job.userId,
        path: "/playground/" + job.channel
      });
    }
    // 串流中途的錯誤訊息是上游原文（會露出提供商身分）→ 會員只看安全字，管理員看原文
    if (errMsg) {
      await reportErrorNow(env, "pg.stream", errMsg, {
        user_id: job.userId,
        path: "/playground/" + job.channel
      });
      await send({ error: "upstream-error", hint: job.isAdm ? errMsg : "上游發生錯誤，請稍後再試" });
    } else if (emptyOut) {
      // 這兩句都不含上游身分（沒有提供商名稱、網址、原始錯誤），會員看得到全文
      const hint = sawReasoning
        ? "模型只輸出了思考過程，沒有給出正式回覆 — 請再問一次，或換一個模型"
        : "上游沒有回覆內容，請再試一次";
      await reportErrorNow(
        env,
        "pg.empty",
        sawReasoning ? "只有思考內容、沒有正式回覆" : "上游沒有回覆內容",
        {
          user_id: job.userId,
          path: "/playground/" + job.channel
        }
      );
      await send({ error: "empty-output", hint: hint });
    }
    await send({ done: true });
    // 斷線後絕對不能 await close()：串流已經沒人讀，close 會跟 write 卡在同一個
    // 死鎖上，那正是整個請求被 canceled 的原因。改成不等待的 abort。
    if (gone) {
      try {
        void writer.abort();
      } catch (e) {}
    } else {
      try {
        await writer.close();
      } catch (e) {}
    }
  })();
  // Worker 宿主：一定要掛 waitUntil，否則回應一送出背景工作就被砍。
  // DO 宿主：收下但不會 await —— pump 自己持有上游的 reader（pending I/O），DO 就活著。
  bg(pump);

  return new Response(ts.readable, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no"
    }
  });
}
