// src/lib/r2budget.ts — R2 免費額度的守門員（2026-07-29，R2 開通時加）。
//
// ## 為什麼需要這個檔案
//
// R2 免費額度是三條獨立的線，任何一條踩過去都會開始計費：
//   儲存空間  10 GB／月
//   Class A（寫入類：PutObject、ListObjects）    100 萬次／月
//   Class B（讀取類：GetObject、HeadObject）    1000 萬次／月
//   （DeleteObject 免費 —— 所以刪除路徑不必計數，見 filestore.ts 的刪除函式）
//
// 「設定一個上限」不等於「不會超過」。三條線各自的失控方式不一樣，所以守法也不一樣：
//
//   儲存空間 → 會**安靜地**累積，是唯一可能在沒人注意時就開始收費的。守法是硬天花板
//     ＋每日 cron 量真實用量（附件 SUM + 備份物件大小）再往回淘汰，見 cron.ts。
//   Class A → 只有「上傳」會產生，而上傳受每人容量配額限制；但刪掉舊對話就能再傳，
//     所以長期是無界的。守法是本月計數，用完就**退回 D1 儲存**（不是拒收）——
//     每一列自己記 storage，混著存完全沒問題，這正是雙模式設計換來的好處。
//   Class B → 只有「回讀舊對話的圖」會產生。瀏覽器端有 7 天 immutable 快取，正常使用
//     一個月連 1% 都用不到；真要燒穿只可能是有人拿著登入身分寫迴圈。守法是本月計數，
//     用完就當成「讀不到」——呼叫端本來就有降級路徑（顯示「檔案已刪除」佔位）。
//
// ## 計數怎麼存
//
// D1 settings 表，鍵名帶月份（r2a_2026-07 / r2b_2026-07）：這樣就不需要「跨月重置」
// 那段邏輯 —— 換月＝換一把鍵，天然歸零。舊月份的鍵由每日 cron 清掉（留 2 個月）。
// 累加走 SQLite 的 UPSERT，是原子的，不會因為併發而少算：
//   INSERT ... ON CONFLICT(k) DO UPDATE SET v = CAST(CAST(v AS INTEGER) + ? AS TEXT)
//
// 讀取則走 isolate 內的 60 秒快取：額度檢查發生在每一次 R2 存取上，若每次都查 D1 就是
// 拿一次 D1 讀去換一次 R2 讀，毫無意義。對「每月」額度來說，慢 60 秒完全無關緊要。
import type { Env } from "../types.js";

// Cloudflare R2 免費方案的三條線（2026-07 官方數字）。這是**事實**，不是我們的設定，
// 所以不開放調整；我們自己的預算永遠訂在它下面（見 R2_PLAN）。
export const R2_FREE = { storageMb: 10240, classA: 1000000, classB: 10000000 };

// 我們實際規劃的用量。三塊空間加起來剛好等於免費額度：
//   附件 8192 ＋ 備份 1536 ＋ 安全邊際 512 ＝ 10240 MB
// 安全邊際存在的理由：R2 的用量統計不是即時的，而每日 cron 也只有一天跑一次 ——
// 兩者之間的落差要有地方吸收，不能規劃到剛好貼齊 10GB。
//
// 操作次數只用到免費額度的 90%：計數本身有誤差（cron 的備份操作、失敗重試），
// 而且「用完就降級」的體驗要發生在**還沒被收費之前**，不是剛好那一次。
export const R2_PLAN = {
  filesMb: 8192, // 附件可用的 **R2 空間**
  backupMb: 1536, // 每日備份保留 14 份的預留空間
  safetyMb: 512, // 不規劃使用的邊際
  classA: 900000, // 本月寫入預算（免費額度的 90%）
  classB: 9000000, // 本月讀取預算（免費額度的 90%）
  warnPct: 80 // 超過這個百分比就發 Telegram 告警（cron 每日檢查）
};

// ## 「8GB 空間」跟「8GB 圖片」不是同一件事 —— base64 的 4/3 膨脹
//
// R2 裡存的是 base64 字串（為什麼不存二進位見 filestore.ts 檔頭：省下的空間會被
// 每輪重編一次的 CPU 加倍奉還）。base64 把 n bytes 變成 ceil(n/3)*4 ≈ 1.334n。
// 而三層配額比對的是 pg_files.bytes ——「原始檔多大」，也就是使用者看到的那個大小。
//
// 兩者差 1/3，這件事**必須在這裡算清楚**：直接把 pgfile_total_mb 設成 8192，
// 實際佔用的 R2 空間會是 8192×4/3 ≈ 10.9GB，當月就超過免費額度開始計費 ——
// 而且是那種沒有任何錯誤訊息、只有帳單會告訴你的超法。
// 所以「8GB R2 空間」換算成配額數字是 8192×3/4 ＝ 6144MB 的原始圖片。
export function rawMbFromR2Mb(r2Mb: number): number {
  return Math.floor((Math.max(0, Number(r2Mb) || 0) * 3) / 4);
}
export function r2MbFromRawMb(rawMb: number): number {
  return Math.ceil((Math.max(0, Number(rawMb) || 0) * 4) / 3);
}

// 附件三層配額實際能用到的「原始 bytes」上限（MB）。這才是 FILE_DEFAULTS／FILE_CEILING
// 要用的數字 —— 8192MB 的 R2 空間 ＝ 6144MB 的原始圖片。
export const FILES_RAW_MB = rawMbFromR2Mb(R2_PLAN.filesMb);

/** 本月的計數鍵後綴（UTC，跟 Cloudflare 的計費週期同基準）。 */
export function monthKey(now?: Date): string {
  return (now || new Date()).toISOString().slice(0, 7); // YYYY-MM
}

export function opKeys(now?: Date): { a: string; b: string } {
  const m = monthKey(now);
  return { a: "r2a_" + m, b: "r2b_" + m };
}

export interface OpsSnap {
  month: string;
  a: number;
  b: number;
  aPct: number;
  bPct: number;
  aOk: boolean; // 還能不能寫 R2（false＝這個月的寫入預算用完了，退回 D1）
  bOk: boolean; // 還能不能讀 R2
}

// isolate 內的快取。Worker 的 isolate 隨時可能被回收，快取跟著消失 —— 那沒關係，
// 下一次就重新查一次 D1，最壞情況只是多一次讀取。
let snapCache: { at: number; snap: OpsSnap } | null = null;
const CACHE_MS = 60000;

function pct(used: number, budget: number): number {
  return budget > 0 ? Math.round((used / budget) * 100) : 0;
}

function toSnap(month: string, a: number, b: number): OpsSnap {
  return {
    month: month,
    a: a,
    b: b,
    aPct: pct(a, R2_PLAN.classA),
    bPct: pct(b, R2_PLAN.classB),
    aOk: a < R2_PLAN.classA,
    bOk: b < R2_PLAN.classB
  };
}

/**
 * 本月操作用量。fresh=true 略過快取（管理頁與 cron 用，它們要看到即時數字）。
 * 任何查詢失敗都回「用量 0」而不是擋住功能 —— 計數器壞掉不該讓附件整個不能用，
 * 真正的硬天花板是儲存空間那條（cron 會量真實用量），操作次數這條本來就有 10% 餘裕。
 */
export async function r2Ops(env: Env, fresh?: boolean): Promise<OpsSnap> {
  const month = monthKey();
  if (!fresh && snapCache && Date.now() - snapCache.at < CACHE_MS && snapCache.snap.month === month) {
    return snapCache.snap;
  }
  const k = opKeys();
  let a = 0;
  let b = 0;
  try {
    const rs = await env.DB.prepare("SELECT k,v FROM settings WHERE k IN (?1,?2)").bind(k.a, k.b).all();
    for (const r of (rs.results || []) as { k: string; v: string }[]) {
      const n = parseInt(String(r.v), 10) || 0;
      if (r.k === k.a) a = n;
      else if (r.k === k.b) b = n;
    }
  } catch (e) {}
  const snap = toSnap(month, a, b);
  snapCache = { at: Date.now(), snap: snap };
  return snap;
}

/**
 * 累加操作計數。cls='a' 寫入類、'b' 讀取類；n＝這次做了幾個操作。
 * 呼叫端負責決定要不要 await —— 有 ctx 的路徑建議丟 waitUntil（不佔回應時間）。
 * UPSERT 是原子的，併發不會少算。
 */
export async function bumpOps(env: Env, cls: "a" | "b", n: number): Promise<void> {
  if (!n || n < 1) return;
  const key = cls === "a" ? opKeys().a : opKeys().b;
  try {
    await env.DB.prepare(
      "INSERT INTO settings (k,v) VALUES (?1,?2) " +
        "ON CONFLICT(k) DO UPDATE SET v = CAST(CAST(settings.v AS INTEGER) + ?3 AS TEXT)"
    )
      .bind(key, String(n), n)
      .run();
  } catch (e) {
    return; // 計數失敗不影響本體操作
  }
  // 本地快取跟著加，否則同一個 isolate 要等 60 秒才看得到自己剛剛的用量
  if (snapCache && snapCache.snap.month === monthKey()) {
    const s = snapCache.snap;
    snapCache = {
      at: snapCache.at,
      snap: toSnap(s.month, s.a + (cls === "a" ? n : 0), s.b + (cls === "b" ? n : 0))
    };
  }
}

/** 測試用：清掉 isolate 快取（正式路徑不需要，快取本來就會自然過期）。 */
export function resetOpsCache(): void {
  snapCache = null;
}

/**
 * 附件現在實際能用到多少（回傳的是**原始 bytes 的 MB**，可直接拿去跟 SUM(bytes) 比）。
 *
 * backupMbUsed＝備份目前實際佔用的 R2 空間，由 cron 量出來傳進來（沒量到就當預留值用滿）。
 * 備份沒用滿預留額度時多出來的空間就讓附件用，不必浪費；備份異常長大時附件這邊會自動
 * 縮回去 —— 兩者搶的是同一個 10GB，只有真的量過才叫「確保不超過」。
 */
export function filesRawMbBudget(backupMbUsed?: number): number {
  const used = Number.isFinite(Number(backupMbUsed)) ? Math.max(0, Number(backupMbUsed)) : R2_PLAN.backupMb;
  const room = R2_FREE.storageMb - R2_PLAN.safetyMb - used; // 還剩多少 R2 空間給附件
  return Math.max(0, Math.min(FILES_RAW_MB, rawMbFromR2Mb(room)));
}
