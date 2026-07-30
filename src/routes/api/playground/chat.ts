// POST /api/playground/chat — Playground 的聊天端點（SSE 串流）。
// 本體：{ conv_id?, channel, model, messages:[{role,content}…] }（messages＝完整上下文，最後一則是 user）。
//
// 流程：驗身分（cookie 或管理員金鑰）→ 查渠道與模型 → 沒帶 conv_id 就自動開新對話
// → 存 user 訊息 → **交棒給 PgStream Durable Object** → 由它打上游、轉成統一 SSE、存回 D1。
// 瀏覽器中途斷線（關網頁／按停止）不會中斷生成 — 背景繼續讀完再存，見 lib/pgchat.ts 的 BG。
//
// ── 為什麼要交棒（v2.5_DO，ADR-0015）──
// 免費方案的 Worker 每次呼叫只有 10ms CPU，而「把上游 SSE 讀進 JS 解析再寫出去」
// 實測一趟 20 秒的回覆要 626ms —— 這件事在 Worker 裡**做不到**，長回覆必被殺。
// Durable Object 的 CPU 上限是 30 秒（免費方案也一樣），所以昂貴的部分整段搬過去，
// 這支 handler 只留下 I/O 為主的驗證與建檔，CPU 與「回覆多長」「訊息多長」都無關：
//   * 唯一一次 JSON.parse（驗輸入用，無法避免）
//   * 交棒的信封是「job JSON ＋ 原始本體原樣接上」，不重新序列化 messages
//   * 回應是 DO 的 Response 原樣回傳 —— 位元組由 runtime 搬運，JS 碰不到
// 這個形狀就是 v2.5 直通版量到 6ms 的那個形狀，差別只在「昂貴的那段被搬走、而不是被刪掉」，
// 所以 safeHint() 的上游淨化、伺服器端落地、背景續跑全部留著。
//
// 退路：env.PG_STREAM 沒綁定，或 settings.pg_do='0'（免部署一鍵切換）→ 直接在 Worker 裡
// 跑同一支 runChat，行為與 v2.4 完全相同（CPU 問題原樣回來，但站台不會掛）。
//
// 回給瀏覽器的 SSE 事件（每筆都是 data: JSON）：
//   { conv, title? }   一開始先告訴前端對話編號（新對話附自動取的標題）
//   { r: "文字" }      推理模型的思考增量（前端畫成可摺疊區塊；不存進 D1）
//   { d: "文字" }      增量內容
//   { error, hint }    中途出錯（已生成的部分照存）；整趟沒有正文＝error:"empty-output"
//   { done: true }     結束
// r 與 d 都是「批次合併後」才送 — 逐筆轉推會燒穿免費方案 10ms CPU 上限（見下方 push/flush）。
// 上游一開始就失敗時不進 SSE，直接回 JSON 錯誤（body 會帶 conv，前端才不會重複開對話）。
import { json } from "../../../lib/site.js";
import { isAdminUser, getSessionUser, goodOrigin } from "../../../lib/auth.js";
import { pgUser, cleanChat, chModels, dumbCfg } from "../../../lib/playground.js";
import { seesImagesFor } from "../../../lib/modelcaps.js";
import { checkQuota } from "../../../lib/quota.js";
import { demoCfg, demoUser, demoCheck, demoLockedModel, DEMO_DEFAULTS } from "../../../lib/demo.js";
import { reportError } from "../../../lib/observe.js";
import { runChat, pgDoOn } from "../../../lib/pgchat.js";
import type { ChatJob } from "../../../lib/pgchat.js";
import type { DemoCfg } from "../../../lib/demo.js";
import type { ChannelRow, RouteCtx, UserRow } from "../../../types.js";

// BG（斷線後的背景續跑預算）與 safeHint（上游錯誤的安全分類字）在 v2.5_DO 搬進 lib/pgchat.ts
// —— 它們跟串流迴圈在同一個地方才有意義。這裡沿用匯出名，既有測試與 import 路徑照舊可用。
export { BG, safeHint } from "../../../lib/pgchat.js";

export async function onRequestPost(context: RouteCtx): Promise<Response> {
  const { request, env } = context;
  const url = new URL(request.url);
  if (!env.DB) return json({ error: "no-db" }, 500);
  const who = await pgUser(request, env, url);
  let user: UserRow;
  let demo: DemoCfg | null = null;
  if (who.err) {
    // Demo 體驗模式（Phase K，ADR-0009）：只接「完全沒登入」的匿名訪客 —
    // 帶了 Authorization（金鑰打錯）或有登入但沒批准的，照樣回原本的 401/403。
    if (!request.headers.get("authorization") && !(await getSessionUser(request, env))) {
      const cfg = await demoCfg(env);
      if (cfg.on) demo = cfg;
    }
    if (!demo) return who.err;
    if (!goodOrigin(request, url, env)) return json({ error: "bad-origin" }, 403);
    const gate = await demoCheck(env, demo, request); // fail-closed，在任何 D1 寫入之前
    if (!gate.ok) return gate.resp;
    user = await demoUser(env); // req_log 記帳身分（成本記帳自然涵蓋 demo）
  } else {
    user = who.user;
  }
  const isAdm = demo ? false : isAdminUser(user, env);

  if (!demo) {
    // 會員配額（fail-open）：一定要在「任何 D1 寫入之前」— 429 時連對話都不會建（管理員豁免）
    const quota = await checkQuota(env, user, "pg");
    if (!quota.ok) return quota.resp;
  }

  // 讀成文字再自己 parse（而不是 request.json()）：raw 等一下要**原樣**接在交棒信封後面
  // 送給 DO，省掉「把 messages 重新序列化一次」那筆與長度成正比的 CPU（見檔頭與 do/pg-stream.ts）。
  // 這一次 parse 無法避免 —— 驗輸入與存 user 訊息都要它。
  let raw = "";
  let body: any = null;
  try {
    raw = await request.text();
    body = JSON.parse(raw);
  } catch (e) {}
  // Dumb mode（v2.2）：在 cleanChat 之前直接蓋掉 body（前端本來就不帶；開發者工具硬塞別的也沒用）。
  //   會員（非管理員）→ 鎖到管理員指定的 dumb_channel×dumb_model。
  //   demo（匿名）→ 2026-07-22 起也一起鎖，但鎖的是**體驗模式自己的**渠道與模型：
  //     dumb 只負責「不讓人挑」，跑哪個仍歸 demo_channel 管（見 demoLockedModel 的理由）。
  if (body && typeof body === "object") {
    if (demo) {
      if ((await dumbCfg(env)).on) {
        body.channel = demo.channel;
        body.model = await demoLockedModel(env, demo);
      }
    } else if (!isAdm) {
      const dcfg = await dumbCfg(env);
      if (dcfg.on) {
        body.channel = dcfg.channel;
        body.model = dcfg.model;
      }
    }
  }
  const v = cleanChat(body);
  if (v.err !== undefined) return json({ error: "bad-input", hint: v.err }, 400);

  if (demo) {
    // demo 鎖定：渠道只能是指定那個（先擋再查 DB，匿名者探測不到其他渠道 slug）；
    // 輸入整包 4k 字上限（比會員的 300k 小兩個數量級）
    if (v.channel !== demo.channel) {
      return json({ error: "demo-locked", hint: "體驗模式只開放指定的渠道" }, 403);
    }
    let total = 0;
    for (const m of v.messages) total += m.content.length;
    if (total > DEMO_DEFAULTS.maxInputChars) {
      return json(
        {
          error: "demo-too-long",
          hint: "體驗模式輸入上限 " + DEMO_DEFAULTS.maxInputChars + " 字 — 登入後可用完整長度"
        },
        400
      );
    }
  }

  // 渠道與模型（模型一定要在渠道設定的清單裡 — 會員只能用管理員開出來的）
  let ch: ChannelRow | null = null;
  try {
    ch = await env.DB.prepare("SELECT * FROM relay_channels WHERE slug=?1 AND enabled=1")
      .bind(v.channel)
      .first<ChannelRow>();
  } catch (e) {}
  if (!ch)
    return json({ error: "unknown-channel", hint: "沒有「" + v.channel + "」這個渠道（或已停用）" }, 404);
  if (chModels(ch).indexOf(v.model) < 0) {
    return json({ error: "bad-model", hint: "渠道「" + ch.name + "」沒有開放模型「" + v.model + "」" }, 400);
  }
  if (demo && demo.models.length && demo.models.indexOf(v.model) < 0) {
    return json({ error: "demo-locked", hint: "體驗模式沒有開放這個模型" }, 403);
  }
  if (!ch.api_key)
    return json({ error: "no-upstream-key", hint: "渠道還沒設定上游金鑰，請管理員到 /relay 補上" }, 502);

  // 附件（v2.3）：模型吃不吃圖以**上游回報的能力**為準，上游不回報才看管理員標的
  // vision_models（migration 0007／0009，見 lib/modelcaps.ts）。
  // 這一則帶了圖、模型卻看不了 → 在**建立對話之前**就擋掉，不要留下一個
  // 「訊息存了、圖也綁了、但上游根本收不到圖」的半吊子狀態。
  // 前端挑圖時就會擋，走到這裡代表是直接打 API 或挑完圖才換模型。
  const sees = seesImagesFor(ch, v.model);
  const lastMsg = v.messages[v.messages.length - 1];
  if (!sees && lastMsg && lastMsg.fileIds && lastMsg.fileIds.length) {
    return json(
      { error: "no-vision", hint: "「" + v.model + "」看不了圖片 — 請換一個支援視覺的模型，或把圖片移除" },
      400
    );
  }

  // 對話：沒帶 conv_id＝開新對話（標題自動取第一句 user 訊息）。
  // demo 的對話 2026-07-21 起也落地 —— 全掛在 demo:public 這一列名下，只有管理員在
  // /logs 的對話紀錄看得到；訪客沒有列表、也讀不到（那兩支端點都要登入，見下面的歸屬檢查）。
  // 歸屬檢查照走 user_id＝demo:public：匿名者塞會員的 conv_id 進來一樣是 404。
  const now = new Date().toISOString();
  let convId = v.convId,
    newTitle: string | null = null;
  if (convId) {
    const conv = await env.DB.prepare("SELECT id FROM pg_conversations WHERE id=?1 AND user_id=?2")
      .bind(convId, user.id)
      .first();
    if (!conv) return json({ error: "not-found", hint: "找不到這個對話" }, 404);
  } else {
    const first = v.messages.filter(function (m) {
      return m.role === "user";
    })[0];
    newTitle =
      String((first && first.content) || "新對話")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 60) || "新對話";
    const r = await env.DB.prepare(
      "INSERT INTO pg_conversations (user_id,title,channel,model,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?5)"
    )
      .bind(user.id, newTitle, v.channel, v.model, now)
      .run();
    convId = r.meta.last_row_id;
  }
  // 先存 user 訊息 — 就算上游掛了，問過的問題也不會消失
  const lastUser = v.messages[v.messages.length - 1];
  const insUser = await env.DB.prepare(
    "INSERT INTO pg_messages (conv_id,role,content,model,created_at) VALUES (?1,'user',?2,?3,?4)"
  )
    .bind(convId, lastUser.content, v.model, now)
    .run();

  // 把這一則帶上來的附件從「孤兒」狀態綁到這則訊息上（v2.3）。
  //   AND user_id=?  → 別人的檔案編號綁不過來
  //   AND msg_id IS NULL → 已經屬於別則訊息的不會被搶走（同一張圖重送要重新上傳）
  // 綁定失敗不影響聊天：圖照樣送得出去，只是那筆檔案會維持孤兒狀態、24 小時後被 cron 清掉。
  if (lastUser.fileIds && lastUser.fileIds.length) {
    try {
      await env.DB.prepare(
        "UPDATE pg_files SET conv_id=?1, msg_id=?2 WHERE id IN (" +
          lastUser.fileIds.join(",") +
          ") AND user_id=?3 AND msg_id IS NULL"
      )
        .bind(convId, insUser.meta.last_row_id, user.id)
        .run();
    } catch (e) {}
  }

  // ── 交棒給 Durable Object（v2.5_DO，ADR-0015）──
  // 到這裡為止全是 I/O 為主的工作（查 D1、寫 D1），CPU 與「訊息多長、回覆多長」都無關。
  // 接下來昂貴的三段 —— 讀 R2 把圖拼進上游 body、打上游、把 SSE 讀進 JS 轉譯 ——
  // 交給 PgStream 跑：那裡的 CPU 預算是 30 秒，不是 10 毫秒。
  const job: ChatJob = {
    userId: user.id,
    isAdm: isAdm,
    convId: convId as number,
    newTitle: newTitle,
    channel: v.channel,
    model: v.model,
    ch: ch,
    demo: !!demo,
    demoMaxTokens: (demo && demo.maxTokens) || 0
  };
  function bg(p: Promise<unknown>) {
    context.waitUntil(p);
  }

  // 退路：DO 沒綁定（fork 的人沒建、或本機沒設）或 settings.pg_do='0'（免部署一鍵切回）
  // → 直接在 Worker 裡跑同一支 runChat。行為＝v2.4：長回覆會再撞 10ms 上限，
  // 但站台照樣能聊，而且短回覆本來就跑得完。
  const ns = env.PG_STREAM;
  if (!ns || !(await pgDoOn(env))) {
    return runChat(env, job, v.messages, bg, request.signal);
  }

  // 每個會員一顆實例：同一個人的第二則之後打到的是已經熱起來的那顆（見 do/pg-stream.ts）。
  const stub = ns.get(ns.idFromName("pg:u:" + user.id));
  try {
    // 信封＝job JSON 一行 ＋ 原始本體原樣接上（不重新序列化 messages，理由見檔頭）。
    // 網址只是形式（DO 不看 host），路徑留著是為了 wrangler tail 上認得出來。
    return await stub.fetch("https://pg-stream.internal/chat", {
      method: "POST",
      body: JSON.stringify(job) + "\n" + raw
    });
  } catch (e) {
    // DO 整組叫不動（部署漂移、超載、暫時性錯誤）→ 不要讓會員這一句就這樣消失，
    // 當場退回 Worker 路徑把話講完。降級一定要留痕跡（告警掃 errlog）。
    reportError(env, bg, "pg.do", e, { user_id: user.id, path: "/playground/" + v.channel });
    return runChat(env, job, v.messages, bg, request.signal);
  }
}
