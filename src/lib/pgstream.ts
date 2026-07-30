// src/lib/pgstream.ts — Playground 串流的「直通」判斷與組裝（v2.5，2026-07-31）。
//
// ── 為什麼有這個檔案 ──
//
// 免費方案每次呼叫 10ms CPU。v2.4 之前的做法是「Worker 把上游的每一個 chunk 讀進 JS、
// 解析、合併、再寫回瀏覽器」，於是 CPU 跟串流長度成正比 —— 回覆一長（尤其多圖多輪的
// 重請求）就撞上限，isolate 直接被殺，瀏覽器看到的是無聲截斷（見 ADR-0011／0014）。
//
// v2.5 改成：**先看幾個 chunk 確認形狀乾淨，之後整條交給 runtime 原生轉推**，
// JS 一個 chunk 都不再碰。線上實測（2026-07-31，wrangler tail，同一個 prompt）：
//
//   現行轉譯路徑   182 次 flush ／ 20.3 秒 → CPU **626 ms**
//   直通路徑     7895 個 chunk ／ 51.5 秒 → CPU **6 ms**   ← 而且在 10ms 之內
//
// 關鍵是 CPU **不再跟串流長度成正比**：直通那趟送的 chunk 多了 43 倍、時間長了 2.5 倍，
// CPU 反而只有百分之一。這個數字是先上線量出來的，不是推理出來的 —— 整個 v2.5 押在
// 「不帶 transform 函式的 identity 管線是原生實作」這句話上，所以它必須被量過。
//
// ── 直通的代價（誠實列出，別假裝沒有）──
//
// Worker 看不到內容，於是這三件事必須換地方做：
//   1. 回覆落地   → 由瀏覽器串完之後回報（POST /api/playground/chat/save）
//   2. token 用量 → 同上（上游的 usage 訊框直通給前端，前端轉交）
//   3. 斷線續跑   → **做不到了**。原本「關掉網頁也會在背景把回覆跑完」（ADR-0012）
//      在直通模式下不存在，改成前端 pagehide 時用 sendBeacon 送出「已收到的部分」。
// 換來的是「這種請求本來會被 CPU 殺掉、什麼都留不下」變成「活著跑完」。見 ADR-0014。
import type { ChannelRow, Env } from "../types.js";

/** 直通只支援 OpenAI 相容的串流形狀（前端要看得懂原始 chunk）。 */
export const PASSTHROUGH_KINDS = ["openai", "custom"];

// 嗅探最多讀幾個 chunk。1 個通常就夠（上游第一個封包幾乎都含完整的第一筆訊框），
// 3 是留給「第一個封包剛好切在訊框中間」。讀不出結論就退回轉譯 —— 讀越多，
// 「萬一要退回」時白花的 CPU 就越多，而退回本來就是少數情況。
export const SNIFF_READS = 3;

// OpenAI 相容串流 chunk **允許出現**的頂層鍵。白名單以外的鍵出現 → 一律退回轉譯路徑。
//
// 這是白名單而不是黑名單，理由跟 fastsse.ts 一樣：有疑慮就放棄，正確性優先於速度。
// 直通等於把上游的原始位元組直接送到會員瀏覽器，而整站的架構前提是**會員永遠看不到
// 上游是誰**（lib/playground.ts 檔頭）。實際會踩到的例子：
//   OpenRouter 每一筆都帶 "provider":"DeepInfra"  ← 直接寫著上游是誰
//   Groq       每一筆都帶 "x_groq":{...}          ← 廠商名就在鍵名裡
// 這兩種一被認出來就退回轉譯路徑，寧可花 CPU 也不洩漏。
//
// prompt_token_ids／prompt_logprobs：2026-07-31 實際抓線上流量看到的（vLLM 系上游每一筆
// 都帶，值是 null）。不含任何身分資訊，但**沒有它就沒有任何一個真實渠道通得過嗅探**——
// 白名單是要照真實流量校準的，不是照規格書想像的。
const ALLOWED_TOP_KEYS = [
  "id",
  "object",
  "created",
  "model",
  "choices",
  "usage",
  "system_fingerprint",
  "service_tier",
  "obfuscation", // OpenAI 2026 起夾帶的隨機填充字串，無語意、不含身分
  "prompt_token_ids",
  "prompt_logprobs"
];

/**
 * ok    ＝ 形狀乾淨，可以直通
 * more  ＝ 讀到的還不夠判（chunk 邊界切在訊框中間），呼叫端該再讀一個
 * reject＝ 明確不能直通（原因在 why）
 */
export type SniffVerdict = { verdict: "ok" | "more" | "reject"; why: string };

/**
 * 判斷「這段上游 SSE 開頭」能不能原樣送給瀏覽器。
 * text＝已解碼的前幾個 chunk（呼叫端負責保留原始位元組以便重播）。
 *
 * 回 reject 的每一種情況，呼叫端都必須退回原本的轉譯路徑 —— 那條路 CPU 貴，
 * 但語意完整（錯誤淨化、usage、續跑），所以「不確定就走貴的那條」永遠是安全的。
 *
 * ⚠ 這個判斷只看得到**開頭**。上游在串流尾端追加的欄位（例：跟 usage 同一筆送出的
 * cost）攔不到 —— 那時位元組早就流出去了。這是直通架構本身的邊界，不是這支函式的疏漏，
 * 詳見 ADR-0014「殘留的曝光面」。
 */
export function sniffPassthrough(text: string): SniffVerdict {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, "");
    if (line.indexOf("data:") !== 0) continue;
    // 最後一行可能只有半截（chunk 邊界切在中間）—— 半截的不判，請呼叫端多讀一點
    if (i === lines.length - 1) return { verdict: "more", why: "" };
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let j: any;
    try {
      j = JSON.parse(payload);
    } catch (e) {
      return { verdict: "reject", why: "chunk 不是合法 JSON" };
    }
    if (!j || typeof j !== "object" || Array.isArray(j)) {
      return { verdict: "reject", why: "chunk 不是物件" };
    }
    // 上游一開頭就報錯 → 轉譯路徑才有錯誤淨化（會員不該看到上游原文）
    if (j.error) return { verdict: "reject", why: "上游在串流裡回報 error" };
    const keys = Object.keys(j);
    for (let k = 0; k < keys.length; k++) {
      if (ALLOWED_TOP_KEYS.indexOf(keys[k]) < 0) {
        return { verdict: "reject", why: "出現未知的頂層欄位「" + keys[k] + "」（可能洩漏上游身分）" };
      }
    }
    // choices 一定要是陣列（不是的話前端解不出來，寧可走轉譯）
    if (j.choices !== undefined && !Array.isArray(j.choices)) {
      return { verdict: "reject", why: "choices 不是陣列" };
    }
    return { verdict: "ok", why: "" };
  }
  return { verdict: "more", why: "" };
}

/**
 * 站台開關 settings.pg_passthrough：只有明確設成 '0' 才關閉。
 * 沒設過／讀不到一律當開啟 —— 這是 v2.5 的預設路徑，D1 出問題不該讓它靜默退回
 * 那條「會把 CPU 燒穿」的舊路徑（那才是真正會出事的方向）。
 */
export async function passthroughOn(env: Env): Promise<boolean> {
  try {
    const r = await env.DB.prepare("SELECT v FROM settings WHERE k='pg_passthrough'").first<{
      v: string;
    }>();
    if (r && String(r.v) === "0") return false;
  } catch (e) {}
  return true;
}

export interface StartLogRec {
  user_id: number;
  channel: string;
  model: string;
  status: number;
  ttfb_ms: number;
  img_bytes: number | null;
}

/**
 * 直通開始前先寫一列 req_log，回傳 rowid（寫不進去回 null，聊天照跑）。
 *
 * 為什麼是「先寫」而不是等結束才寫：直通之後伺服器再也看不到這趟的任何東西 ——
 * 沒有結束事件、沒有內容、也不知道客戶端會不會回來。這一列是「這個請求存在過」
 * 的唯一憑據，配額的 D1 降級路徑（lib/quota.ts 第二層）就是數它。
 * dur_ms／token 先留 NULL，前端串完再回頭補（見 routes/api/playground/chat/save.ts）。
 */
export async function startReqLog(env: Env, rec: StartLogRec): Promise<number | null> {
  try {
    const r = await env.DB.prepare(
      "INSERT INTO req_log (ts,user_id,svc,channel,model,status,dur_ms,ttfb_ms,tokens_in,tokens_out,img_bytes,build_ms) " +
        "VALUES (?1,?2,'pg',?3,?4,?5,NULL,?6,NULL,NULL,?7,NULL)"
    )
      .bind(
        new Date().toISOString(),
        rec.user_id,
        rec.channel,
        rec.model,
        rec.status,
        rec.ttfb_ms,
        rec.img_bytes
      )
      .run();
    const id = Number(r.meta.last_row_id);
    return id > 0 ? id : null;
  } catch (e) {
    return null;
  }
}

export interface GateInput {
  ch: ChannelRow;
  contentType: string;
  /** 站台開關 settings.pg_passthrough（'0'＝關）。 */
  enabled: boolean;
  /** dumb mode 對這個人生效中（會員不該知道模型是誰）。 */
  dumb: boolean;
  /** 體驗模式（匿名訪客，模型同樣是被鎖住、不該曝光的）。 */
  demo: boolean;
}

/**
 * 還沒讀任何位元組之前就能判掉的條件（省下嗅探本身的成本）。
 * 回空字串＝可以進入嗅探；回字串＝不能直通的原因。
 */
export function passthroughBlocked(g: GateInput): string {
  if (!g.enabled) return "站台設定關閉直通（pg_passthrough=0）";
  if (PASSTHROUGH_KINDS.indexOf(String(g.ch.kind || "")) < 0) {
    return "渠道類型「" + g.ch.kind + "」不是 OpenAI 相容串流";
  }
  if (g.contentType.indexOf("event-stream") < 0) return "上游回的不是 SSE";
  // dumb／demo：原始 chunk 每一筆都帶 "model":"真名"，直通等於把刻意隱藏的東西送出去。
  // 這兩種模式的整個重點就是「會員不知道自己在用什麼」，不能為了省 CPU 破功。
  if (g.dumb) return "dumb mode 生效中（原始 chunk 會洩漏模型名稱）";
  if (g.demo) return "體驗模式（原始 chunk 會洩漏模型名稱）";
  return "";
}

/** 直通回應的標頭。上游的標頭一個都不轉 —— set-cookie、廠商自訂標頭全部留在這一側。 */
export function passthroughHeaders(convId: number | string, logId: number | null): Record<string, string> {
  const h: Record<string, string> = {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    "x-accel-buffering": "no",
    // 前端靠這兩個標頭知道「對話編號」與「這趟的計量列」，不必等 SSE 第一筆事件。
    "x-pg-conv": String(convId),
    "x-pg-mode": "passthrough"
  };
  if (logId != null) h["x-pg-log"] = String(logId);
  return h;
}

/**
 * 組出直通回應：先寫我們自己的前綴事件與嗅探時吃掉的原始位元組，其餘交給原生管線。
 *
 * ⚠ 這裡的每一行都有實測過的理由（2026-07-31 本機 workerd 各踩一次）：
 *   * 一定要 IdentityTransformStream。標準 `new TransformStream()` 上用不 await 的
 *     write() 會把那一筆**靜默吃掉** —— 串流其他內容完全正常、不報錯，只有前綴事件
 *     人間蒸發。那是最難查的一種壞法。
 *   * 前綴 write() **不能 await**：此時 Response 都還沒回傳、沒有人在讀，
 *     背壓永遠不解除 → 死鎖（本機實測直接卡到逾時）。
 *     不 await 也保證順序：write() 是同步入佇列的。
 *   * pipeTo 之前 writer 必須 releaseLock，否則 writable 被鎖住、pipeTo 直接拋。
 */
export function buildPassthrough(
  body: ReadableStream<Uint8Array>,
  prefix: Uint8Array,
  replay: Uint8Array[],
  headers: Record<string, string>,
  waitUntil: (p: Promise<unknown>) => void
): Response {
  const ts = new IdentityTransformStream();
  const w = ts.writable.getWriter();
  void w.write(prefix);
  for (let i = 0; i < replay.length; i++) void w.write(replay[i]);
  w.releaseLock();
  // pipeTo 會在上游結束時把 writable 一起關掉 → 瀏覽器自然看到串流結束。
  // 客戶端中途離線時這個 promise 會一直不 resolve，但它卡在 runtime 裡、**不燒 CPU**
  // （這正是舊路徑那個「寫入卡住 → 整個請求 canceled」死鎖的反面）。
  waitUntil(body.pipeTo(ts.writable).catch(function () {}));
  return new Response(ts.readable, { headers: headers });
}
