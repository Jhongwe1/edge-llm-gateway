// /api/playground/conversations/<編號> — 只能動自己的對話。
//   GET    對話＋全部訊息（畫歷史對話用）
//   PUT    { title } 改名
//   DELETE 刪除對話（連同訊息，不可復原）
import { json } from "../../../../lib/site.js";
import { pgUser, dumbCfg } from "../../../../lib/playground.js";
import { isAdminUser } from "../../../../lib/auth.js";
import { deleteFiles } from "../../../../lib/filestore.js";
import type { FileRow } from "../../../../lib/filestore.js";
import type { Env, Row, RouteCtx, UserRow } from "../../../../types.js";

async function ownConv(env: Env, user: UserRow, params: RouteCtx["params"]): Promise<Row | null> {
  const id = parseInt(String(params.id), 10);
  if (!(id > 0)) return null;
  return await env.DB.prepare("SELECT * FROM pg_conversations WHERE id=?1 AND user_id=?2")
    .bind(id, user.id)
    .first<Row>();
}

export async function onRequestGet({ request, env, params }: RouteCtx): Promise<Response> {
  const url = new URL(request.url);
  if (!env.DB) return json({ error: "no-db" }, 500);
  const who = await pgUser(request, env, url);
  if (who.err) return who.err;
  const conv = await ownConv(env, who.user, params);
  if (!conv) return json({ error: "not-found", hint: "找不到這個對話" }, 404);
  try {
    const res = await env.DB.prepare(
      "SELECT id,role,content,model,created_at FROM pg_messages WHERE conv_id=?1 ORDER BY id LIMIT 500"
    )
      .bind(conv.id)
      .all();
    const messages = (res.results || []) as Row[];
    // Dumb mode（v2.2）：會員從回讀也不能得知正在用的模型 — channel/model 一律遮空
    if (!isAdminUser(who.user, env) && (await dumbCfg(env)).on) {
      (conv as Row).channel = "";
      (conv as Row).model = "";
      for (const m of messages) m.model = "";
    }
    // 附件（v2.3）：一次撈完整串對話的檔案，前端自己按 msg_id 分組掛回訊息上。
    // 只回中繼資料，內容要另外打 /api/playground/files/<id>（那條路徑才有 atob 的成本，
    // 而且瀏覽器會快取住 —— 翻同一則舊對話第二次就不必再下載）。
    // purged=1 的照樣回，前端據此畫「檔案已刪除」而不是憑空少一格。
    let files: Row[] = [];
    try {
      const fr = await env.DB.prepare(
        "SELECT id,msg_id,mime,name,bytes,w,h,purged FROM pg_files WHERE conv_id=?1 ORDER BY id LIMIT 200"
      )
        .bind(conv.id)
        .all();
      files = (fr.results || []) as Row[];
    } catch (e) {}
    return json({ conv: conv, messages: messages, files: files });
  } catch (e: any) {
    return json({ error: "query-failed", detail: String((e && e.message) || e) }, 500);
  }
}

export async function onRequestPut({ request, env, params }: RouteCtx): Promise<Response> {
  const url = new URL(request.url);
  if (!env.DB) return json({ error: "no-db" }, 500);
  const who = await pgUser(request, env, url);
  if (who.err) return who.err;
  const conv = await ownConv(env, who.user, params);
  if (!conv) return json({ error: "not-found", hint: "找不到這個對話" }, 404);
  let b: any = null;
  try {
    b = await request.json();
  } catch (e) {}
  const title = String((b && b.title) || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  if (!title) return json({ error: "bad-input", hint: "title 不能是空的" }, 400);
  try {
    await env.DB.prepare("UPDATE pg_conversations SET title=?1 WHERE id=?2").bind(title, conv.id).run();
    return json({ ok: true, title: title });
  } catch (e: any) {
    return json({ error: "save-failed", detail: String((e && e.message) || e) }, 500);
  }
}

export async function onRequestDelete({ request, env, params }: RouteCtx): Promise<Response> {
  const url = new URL(request.url);
  if (!env.DB) return json({ error: "no-db" }, 500);
  const who = await pgUser(request, env, url);
  if (who.err) return who.err;
  const conv = await ownConv(env, who.user, params);
  if (!conv) return json({ error: "not-found", hint: "找不到這個對話" }, 404);
  try {
    // 附件先刪（v2.3）：deleteFiles 會順手清掉 R2 物件 —— 只 DELETE D1 的話，
    // R2 那邊會留下永遠沒人引用、也永遠不會被發現的垃圾物件（照樣佔 10GB 額度）。
    // 撈不到或刪不掉都不擋住刪對話：孤兒檔案還有每日 cron 那道保險。
    try {
      const fr = await env.DB.prepare("SELECT * FROM pg_files WHERE conv_id=?1").bind(conv.id).all();
      await deleteFiles(env, (fr.results || []) as FileRow[]);
    } catch (e) {}
    await env.DB.batch([
      env.DB.prepare("DELETE FROM pg_messages WHERE conv_id=?1").bind(conv.id),
      env.DB.prepare("DELETE FROM pg_conversations WHERE id=?1").bind(conv.id)
    ]);
    return json({ ok: true });
  } catch (e: any) {
    return json({ error: "delete-failed", detail: String((e && e.message) || e) }, 500);
  }
}
