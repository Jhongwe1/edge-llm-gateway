// GET /api/playground/files/<編號> — 把附件還原成真正的圖片給 <img> 用（翻歷史對話時）。
//
// 這是整個附件功能裡**唯一**會做 base64 解碼的地方（atob，1MB 約 2.4ms）。之所以安全：
// 這個請求除了解這一張圖之外什麼都不做，不像 chat.ts 那條路上還要跑串流迴圈 ——
// 2.4ms 放在 10ms 預算裡綽綽有餘。前端顯示「剛上傳、還沒送出」的圖時用本地的 data URL，
// 根本不會打到這裡；只有重新打開舊對話才需要。
//
// 歸屬：只能讀自己的檔案，管理員例外。demo（匿名）上傳的檔案一律只有管理員讀得到 ——
// 那些檔案全掛在 demo:public 這一列名下，若開放匿名讀取，訪客只要把 id 加一
// 就能翻到別的訪客傳了什麼（id 是連續整數，猜起來毫無難度）。體驗模式沒有歷史對話，
// 訪客本來就不需要回讀，所以這條限制不影響任何正常使用。
import { json } from "../../../../lib/site.js";
import { isAdminUser } from "../../../../lib/auth.js";
import { pgUser } from "../../../../lib/playground.js";
import { getB64 } from "../../../../lib/filestore.js";
import type { FileRow } from "../../../../lib/filestore.js";
import type { RouteCtx } from "../../../../types.js";

export async function onRequestGet({ request, env, params }: RouteCtx): Promise<Response> {
  const url = new URL(request.url);
  if (!env.DB) return json({ error: "no-db" }, 500);
  const who = await pgUser(request, env, url);
  if (who.err) return who.err;
  const id = parseInt(String(params.id), 10);
  if (!(id > 0)) return json({ error: "not-found" }, 404);

  let row: FileRow | null = null;
  try {
    row = await env.DB.prepare("SELECT * FROM pg_files WHERE id=?1").bind(id).first<FileRow>();
  } catch (e) {}
  if (!row) return json({ error: "not-found" }, 404);
  // 不是自己的就當成不存在（回 403 等於告訴對方「這個編號有東西」）
  if (row.user_id !== who.user.id && !isAdminUser(who.user, env)) {
    return json({ error: "not-found" }, 404);
  }
  // 內容被淘汰／過期清掉了。410 Gone 而不是 404 —— 語意是「確實有過、現在沒了」，
  // 前端據此畫「檔案已刪除」佔位（中繼資料還在，檔名大小都顯示得出來）。
  if (row.purged) {
    return json({ error: "purged", hint: "這個檔案的內容已被清除", name: row.name, bytes: row.bytes }, 410);
  }

  const b64 = await getB64(env, row);
  if (!b64) return json({ error: "not-found" }, 404);

  let body: Uint8Array;
  try {
    const bin = atob(b64);
    body = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) body[i] = bin.charCodeAt(i);
  } catch (e) {
    return json({ error: "decode-failed" }, 500);
  }

  return new Response(body, {
    headers: {
      "content-type": row.mime,
      // 內容不可變（同一個 id 永遠是同一張圖）→ 讓瀏覽器狠狠快取，翻舊對話不必重下載。
      // private：這是會員的私人檔案，中間的快取層不准存。
      "cache-control": "private, max-age=604800, immutable",
      // 就算 mime 被繞過，也不准瀏覽器自己「猜」成別的型別去執行
      "x-content-type-options": "nosniff",
      // 這條路徑只服務 <img>；真的被人直接開啟網址時強制下載而不是在同源頁面裡渲染
      "content-disposition": 'inline; filename="' + String(row.id) + '"'
    }
  });
}
