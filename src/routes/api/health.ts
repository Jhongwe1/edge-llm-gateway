// GET /api/health — 公開健康檢查：{ ok, version, db, db_error? }。
// db=false 表示 D1 連不上（網站殼還活著、資料功能故障）— 部署後 smoke 測試第一站。
//
// ## db_error：為什麼要分類，而不是只回一個布林（2026-08，DEBT #35）
//
// D1 免費額度是每日 10 萬列寫入／500 萬列讀取，而**額度爆掉時 Cloudflare 讓所有查詢都失敗**，
// 不只寫入。那個狀態長得跟「資料庫掛了」一模一樣，但處置完全不同：
//   quota  → 等 UTC 午夜重置，或升 Workers Paid（幾分鐘生效）。查 DEBT #35。
//   其他   → 真的是 D1 故障或綁定掉了，看 Cloudflare 狀態頁。
//
// 而這支端點的特殊之處在於：**額度爆掉時它是全站唯一還講得出話的地方**。
// 站內錯誤日誌（errlog）是 D1 的表、Telegram 告警要從 D1 讀它 —— 兩條路都斷了。
// 所以這裡刻意不依賴任何 D1 寫入，只做一次讀取並把錯誤**分類**後回報。
//
// 錯誤訊息本身不外流（可能含內部細節），只回一個分類字。
import { json, VERSION } from "../../lib/site.js";
import type { RouteCtx } from "../../types.js";

/** D1 錯誤 → 分類字。認不出來一律 "error"，絕不把原始訊息吐給公開端點。 */
export function classifyDbError(err: unknown): string {
  const m = String((err as { message?: unknown })?.message || err || "").toLowerCase();
  if (!m) return "error";
  // Cloudflare 的措辭是 "exceeded ... daily limits"／"limit exceeded"，各版本用字有變動過，
  // 所以比對兩個關鍵詞的共現而不是整句 —— 漏判會退回 "error"，不會誤導。
  if (m.indexOf("limit") >= 0 && (m.indexOf("exceed") >= 0 || m.indexOf("daily") >= 0)) return "quota";
  if (m.indexOf("quota") >= 0) return "quota";
  return "error";
}

export async function onRequestGet({ env }: RouteCtx): Promise<Response> {
  let db = false;
  let dbError: string | undefined;
  try {
    if (env.DB) {
      await env.DB.prepare("SELECT 1").first();
      db = true;
    } else {
      dbError = "unbound";
    }
  } catch (e) {
    dbError = classifyDbError(e);
  }
  return json({ ok: true, version: VERSION, db: db, db_error: dbError });
}
