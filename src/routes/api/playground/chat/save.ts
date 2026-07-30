// POST /api/playground/chat/save — 直通模式的「回覆落地」（v2.5，2026-07-31）。
//
// 為什麼需要這支：v2.5 的直通把上游串流原樣轉推給瀏覽器（CPU 626ms → 6ms，見
// lib/pgstream.ts），代價是 **Worker 看不到回覆內容** —— 所以由瀏覽器串完之後把
// 內容交回來寫進 D1。轉譯路徑（anthropic／gemini／dumb mode／嗅探沒過）不走這裡，
// 那條路仍然是伺服器自己存。
//
// 本體：{ conv_id, log_id?, content, tokens_in?, tokens_out?, dur_ms?, status? }
//   content  這一則 assistant 回覆的完整文字（思考過程不存，跟轉譯路徑一致）
//   log_id   /chat 回應標頭 x-pg-log 給的那一列 req_log；用來補 token 用量與總耗時
//   status   前端回報的收尾狀態（只收固定幾個值，見 STATUS）
//
// 冪等：前端會呼叫兩次（正常串完一次、pagehide 用 sendBeacon 再一次），所以這裡
// 「同一則對話的最後一列已經是 assistant」就改寫那一列，而且**只有變長才覆寫** ——
// 遲到的 sendBeacon 帶的是半截內容，不能把已經存好的完整回覆蓋掉。
import { json } from "../../../../lib/site.js";
import { PG_LIMITS, pgUser } from "../../../../lib/playground.js";
import { reportError } from "../../../../lib/observe.js";
import type { RouteCtx } from "../../../../types.js";

// 前端能回報的收尾狀態。**刻意做成固定清單而不是自由字串** —— 這條路徑上的內容
// 完全由瀏覽器決定，開放任意文字等於讓會員往 errlog 裡寫東西。
const STATUS = ["ok", "empty-output", "upstream-error", "aborted"];

export async function onRequestPost(context: RouteCtx): Promise<Response> {
  const { request, env } = context;
  const url = new URL(request.url);
  if (!env.DB) return json({ error: "no-db" }, 500);
  const who = await pgUser(request, env, url);
  if (who.err) return who.err;
  const user = who.user;

  let b: any = null;
  try {
    b = await request.json();
  } catch (e) {}
  if (!b || typeof b !== "object") return json({ error: "bad-input", hint: "需要 JSON 本體" }, 400);

  const convId = parseInt(String(b.conv_id), 10);
  if (!(convId > 0)) return json({ error: "bad-input", hint: "要帶 conv_id" }, 400);
  const conv = await env.DB.prepare("SELECT id,model FROM pg_conversations WHERE id=?1 AND user_id=?2")
    .bind(convId, user.id)
    .first<{ id: number; model: string }>();
  if (!conv) return json({ error: "not-found", hint: "找不到這個對話" }, 404);

  // 控制字元一律剝掉（跟 cleanChat 同一套規則：U+0001 是組上游 body 的圖片佔位符）
  const content = String(b.content == null ? "" : b.content)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .slice(0, PG_LIMITS.maxChars);
  const status = STATUS.indexOf(String(b.status || "ok")) >= 0 ? String(b.status || "ok") : "ok";
  const now = new Date().toISOString();

  let saved: "insert" | "update" | "skip" = "skip";
  try {
    if (content) {
      const last = await env.DB.prepare(
        "SELECT id,role,length(content) AS n FROM pg_messages WHERE conv_id=?1 ORDER BY id DESC LIMIT 1"
      )
        .bind(convId)
        .first<{ id: number; role: string; n: number }>();
      if (last && last.role === "assistant") {
        // 遲到的半截內容不准蓋掉已經存好的完整回覆
        if (content.length > Number(last.n || 0)) {
          await env.DB.prepare("UPDATE pg_messages SET content=?1 WHERE id=?2").bind(content, last.id).run();
          saved = "update";
        }
      } else {
        await env.DB.prepare(
          "INSERT INTO pg_messages (conv_id,role,content,model,created_at) VALUES (?1,'assistant',?2,?3,?4)"
        )
          .bind(convId, content, conv.model || "", now)
          .run();
        saved = "insert";
      }
    }
    if (saved !== "skip") {
      await env.DB.prepare("UPDATE pg_conversations SET updated_at=?1 WHERE id=?2").bind(now, convId).run();
    }
  } catch (e) {
    // 存不進去＝會員的回覆消失了，一定要留痕跡
    reportError(
      env,
      function (p) {
        context.waitUntil(p);
      },
      "pg.save",
      e,
      { user_id: user.id, path: "/playground/save" }
    );
    return json({ error: "save-failed" }, 500);
  }

  // req_log 補齊：token 用量與總耗時。
  //   AND user_id  → 別人的計量列改不動
  //   AND tokens_out IS NULL → **只補得了一次**（重送的 beacon 不會把數字再改一遍）
  // ⚠ 這裡的 token 數是**瀏覽器回報**的（直通模式伺服器看不到 usage 訊框）。
  //   配額執法算的是「請求次數」、不是 token，所以少報 token 佔不到便宜；
  //   受影響的只有成本報表的精確度，記在 DEBT。
  const logId = parseInt(String(b.log_id), 10);
  if (logId > 0) {
    const ti = parseInt(String(b.tokens_in), 10);
    const to = parseInt(String(b.tokens_out), 10);
    const dur = parseInt(String(b.dur_ms), 10);
    try {
      await env.DB.prepare(
        "UPDATE req_log SET tokens_in=?1, tokens_out=?2, dur_ms=?3 WHERE id=?4 AND user_id=?5 AND svc='pg' AND tokens_out IS NULL"
      )
        .bind(ti >= 0 ? ti : null, to >= 0 ? to : null, dur >= 0 ? dur : null, logId, user.id)
        .run();
    } catch (e) {}
  }

  // 沒有正文（模型只吐思考、或上游中途壞掉）也要留痕跡 —— 轉譯路徑本來就會記，
  // 直通模式下伺服器看不到，只能靠前端回報，否則這種故障會完全隱形。
  if (status !== "ok" && status !== "aborted") {
    reportError(
      env,
      function (p) {
        context.waitUntil(p);
      },
      "pg.passthrough",
      "前端回報串流異常：" + status,
      { user_id: user.id, path: "/playground/save", detail: "conv=" + convId + " chars=" + content.length }
    );
  }
  return json({ ok: true, saved: saved });
}
