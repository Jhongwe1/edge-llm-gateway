// GET /api/playground/files/<編號> — 把附件還原成真正的圖片給 <img> 用（翻歷史對話時）。
//
// 這是整個附件功能裡**唯一**會做 base64 解碼的地方。前端顯示「剛上傳、還沒送出」的圖時
// 用本地的 data URL，根本不會打到這裡；只有重新打開舊對話才需要。
//
// ## 解碼方式在 R2 上線時換過（2026-07-29）
//
// 舊寫法是 atob() 再用迴圈逐字元填 Uint8Array。單檔上限還是 1400KB 時那樣沒問題，
// 但放寬到 5MB 之後就會撞牆 —— 實測（V8 基準，同一台機器）：
//   atob＋迴圈          1MB 2.93ms ｜ 2MB 5.53ms ｜ 5MB 11.31ms ← 超過免費方案 10ms CPU
//   Uint8Array.fromBase64  1MB 0.48ms ｜ 2MB 1.15ms ｜ 5MB 2.96ms
// 貴的不是 atob 本身，是那個逐字元 charCodeAt 迴圈；改用原生解碼等於把工作交還給 C++。
// 沒有這一步，「單檔放寬到 5MB」換來的會是翻舊對話時整批圖片變成 1102（isolate 被砍），
// 死法跟 ADR-0011 一模一樣 —— 上限放寬與解碼成本必須一起改，不能只改一邊。
//
// fromBase64 是新一點的 runtime 才有的（compatibility_date 2026-07-01 的 workerd 已內建），
// 保留舊迴圈當後備：萬一在沒有它的環境跑（舊 workerd、某些測試環境），功能照樣可用，
// 只是大檔會比較燒 CPU。
//
// 歸屬：只能讀自己的檔案，管理員例外。demo（匿名）上傳的檔案一律只有管理員讀得到 ——
// 那些檔案全掛在 demo:public 這一列名下，若開放匿名讀取，訪客只要把 id 加一
// 就能翻到別的訪客傳了什麼（id 是連續整數，猜起來毫無難度）。體驗模式沒有歷史對話，
// 訪客本來就不需要回讀，所以這條限制不影響任何正常使用。
import { json } from "../../../../lib/site.js";
import { isAdminUser } from "../../../../lib/auth.js";
import { pgUser } from "../../../../lib/playground.js";
import { getB64, countR2Reads } from "../../../../lib/filestore.js";
import type { FileRow } from "../../../../lib/filestore.js";
import type { RouteCtx } from "../../../../types.js";

// base64 → 二進位。原生 Uint8Array.fromBase64 優先，沒有才退回舊迴圈（見檔頭實測數字）。
// 型別上 fromBase64 還不在 TS 的 lib 裡，所以走 any 探測。
const nativeFromB64 = (Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array }).fromBase64;

function decodeB64(b64: string): Uint8Array {
  if (typeof nativeFromB64 === "function") return nativeFromB64(b64);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function onRequestGet({ request, env, params, waitUntil }: RouteCtx): Promise<Response> {
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
  // R2 讀取要計入本月 Class B 額度。丟 waitUntil：計數是我們的帳，不該讓使用者多等。
  waitUntil(countR2Reads(env, [row]));

  let body: Uint8Array;
  try {
    body = decodeB64(b64);
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
