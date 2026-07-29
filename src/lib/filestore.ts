// src/lib/filestore.ts — Playground 附件的儲存層（v2.3.0）。
//
// ## 一句話：內容一律是 base64 字串，Worker 全程不編碼也不解碼
//
// 為什麼（實測，2026-07-29）：三家上游都只吃 base64，所以「存二進位」等於每次對話都要
// btoa 編一次 —— 1MB 圖 8.11ms、2MB 圖 14.46ms，而免費方案每次請求只有 10ms CPU。
// 存 base64 原字串則整條路徑趨近零成本：上傳 request.text() 0.27ms、送上游純字串串接
// 0.59ms（且那 0.59ms 是 fetch 本來就要付的 TextEncoder，不是我們額外花的）。
// 詳細對照表寫在 migrations/0007。**這條規則對 R2 一樣成立** —— R2 也存 base64 字串，
// 存二進位省下的 33% 空間會被「每輪重編一次」的 CPU 加倍奉還。
//
// ## D1／R2 可切換（C 方案）
// 有 env.FILES（R2 綁定）就寫 R2、沒有就寫 D1 的 b64 欄位，跟 cron.ts 判斷 env.BACKUPS
// 是同一套寫法。關鍵在**每一列各自記自己存在哪**（storage 欄位）：所以開通 R2 之後
// 舊檔照樣讀得到，不需要搬資料、不需要停機、也不需要改任何呼叫端。
import type { Env, Row } from "../types.js";

// 三層配額的內建預設（settings 同名鍵可覆寫，管理員在 /settings 改）。
//   單檔 1400KB — D1 單值上限 2,000,000 bytes 反推：base64 會膨脹成 ceil(n/3)*4，
//     所以原始檔最大是 2,000,000 × 3/4 ≈ 1,464KB，取 1400KB 留餘裕。
//     （初版寫 1500KB 是算錯的 —— 1500×1024×4/3 = 2,048,000，剛好越過 D1 的線，
//     會在寫入時才炸，而且錯誤訊息跟大小完全無關。單元測試把這條算式釘起來了。）
//     存 R2 時不受這條限制，但預設不放寬：前端本來就壓到長邊 1568px，一般照片 200–400KB。
//   每人 30MB — 防「一個人把別人的圖擠掉」。沒有這層的話 L3 的 FIFO 淘汰是不公平的：
//     它只知道誰比較舊，不知道誰該被淘汰，單人灌爆就會清光所有人的歷史。
//   全站 300MB — 硬天花板。D1 免費庫上限 500MB，留 200MB 給對話／訪客紀錄等正職資料。
export const FILE_DEFAULTS = { pgfile_max_kb: 1400, pgfile_user_mb: 30, pgfile_total_mb: 300 };

// 只收這四種 —— 三家 vision 的交集（Anthropic 明文就這四種）。
// SVG 永遠不在名單裡：它是可以裝 <script> 的 XML，等於讓會員往站上傳可執行內容。
export const OK_IMAGE_MIME: Record<string, number> = {
  "image/jpeg": 1,
  "image/png": 1,
  "image/webp": 1,
  "image/gif": 1
};

// 檔頭魔術位元組 → 真實格式。只解 base64 的前 24 個字元（＝前 16 bytes，實測 0.00ms），
// 不必碰整個檔案。用途是「宣告的 mime 必須跟內容相符」：光信 content-type 標頭的話，
// 傳一個 .html 進來卻宣告成 image/png，之後被 <img> 以外的路徑讀到就是 XSS 入口。
export function sniffMime(b64Head: string): string {
  let u: Uint8Array;
  try {
    const bin = atob(String(b64Head || "").slice(0, 24));
    u = new Uint8Array(16);
    for (let i = 0; i < 16 && i < bin.length; i++) u[i] = bin.charCodeAt(i);
  } catch (e) {
    return "";
  }
  if (u[0] === 0xff && u[1] === 0xd8 && u[2] === 0xff) return "image/jpeg";
  if (u[0] === 0x89 && u[1] === 0x50 && u[2] === 0x4e && u[3] === 0x47) return "image/png";
  if (u[0] === 0x47 && u[1] === 0x49 && u[2] === 0x46 && u[3] === 0x38) return "image/gif";
  // WebP＝RIFF....WEBP（第 8–11 byte 才是 WEBP，中間四個是檔案長度）
  if (u[0] === 0x52 && u[1] === 0x49 && u[2] === 0x46 && u[3] === 0x46) {
    if (u[8] === 0x57 && u[9] === 0x45 && u[10] === 0x42 && u[11] === 0x50) return "image/webp";
  }
  return "";
}

// base64 字串長度 → 解碼後的真實 bytes（不必真的解碼）。
// 尾端每個 '=' 代表少一個 byte。
export function b64Bytes(b64: string): number {
  const s = String(b64 || "");
  if (!s) return 0;
  let pad = 0;
  if (s.charCodeAt(s.length - 1) === 61) pad++;
  if (s.length > 1 && s.charCodeAt(s.length - 2) === 61) pad++;
  return Math.max(0, Math.floor((s.length * 3) / 4) - pad);
}

// base64 字元集檢查（A–Z a–z 0–9 + / =）。擋掉夾帶引號／反斜線的內容 ——
// 送上游時我們是「純字串串接」進 JSON body（為了省 stringify 的 CPU），
// 所以這個驗證就是那條快路徑的安全前提：驗過了才保證串進去不會壞掉 JSON 結構。
// 不合法一律拒收，絕不試圖清洗。
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
export function isB64(s: string): boolean {
  const v = String(s || "");
  return v.length > 0 && v.length % 4 === 0 && B64_RE.test(v);
}

export interface FileRow extends Row {
  id: number;
  user_id: number;
  conv_id: number | null;
  msg_id: number | null;
  kind: string;
  mime: string;
  name: string;
  bytes: number;
  w: number | null;
  h: number | null;
  storage: string;
  b64: string | null;
  r2_key: string | null;
  purged: number;
  created_at: string;
}

/** 讀三層配額設定（settings 覆寫 → 內建預設）。任何失敗都退回內建值。 */
export async function fileLimits(env: Env): Promise<{ maxKb: number; userMb: number; totalMb: number }> {
  const out = {
    maxKb: FILE_DEFAULTS.pgfile_max_kb,
    userMb: FILE_DEFAULTS.pgfile_user_mb,
    totalMb: FILE_DEFAULTS.pgfile_total_mb
  };
  try {
    const rs = await env.DB.prepare(
      "SELECT k,v FROM settings WHERE k IN ('pgfile_max_kb','pgfile_user_mb','pgfile_total_mb')"
    ).all();
    for (const r of (rs.results || []) as { k: string; v: string }[]) {
      const n = parseInt(String(r.v), 10);
      if (!Number.isFinite(n) || n <= 0) continue; // 0／負數／空白＝誤設，用預設而不是把功能鎖死
      if (r.k === "pgfile_max_kb") out.maxKb = n;
      else if (r.k === "pgfile_user_mb") out.userMb = n;
      else if (r.k === "pgfile_total_mb") out.totalMb = n;
    }
  } catch (e) {}
  return out;
}

/** 這個站現在把附件寫到哪 —— R2 綁定在就是 r2，否則 d1。 */
export function activeStore(env: Env): "d1" | "r2" {
  return env && env.FILES ? "r2" : "d1";
}

/**
 * 寫入一個附件，回 { id }。內容 b64 必須已經驗過（isB64＋sniffMime＋大小）。
 * R2 路徑：物件鍵 pgfile/<user_id>/<時間戳>-<亂數>，D1 只留中繼資料與鍵名。
 * R2 寫入失敗就整個丟出去 —— 附件寫不進去卻回成功，會讓對話裡出現永遠讀不到的破圖。
 */
export async function putFile(
  env: Env,
  meta: {
    user_id: number;
    kind: string;
    mime: string;
    name: string;
    bytes: number;
    w: number | null;
    h: number | null;
  },
  b64: string
): Promise<number> {
  const now = new Date().toISOString();
  const store = activeStore(env);
  let r2Key: string | null = null;
  if (store === "r2") {
    r2Key = "pgfile/" + meta.user_id + "/" + Date.now() + "-" + Math.random().toString(36).slice(2, 10);
    // 存的是 base64 字串本身（見檔頭說明），contentType 標 text/plain 才不會被誤當成圖片下載
    await env.FILES!.put(r2Key, b64, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
  }
  const r = await env.DB.prepare(
    "INSERT INTO pg_files (user_id,conv_id,msg_id,kind,mime,name,bytes,w,h,storage,b64,r2_key,purged,created_at) " +
      "VALUES (?1,NULL,NULL,?2,?3,?4,?5,?6,?7,?8,?9,?10,0,?11)"
  )
    .bind(
      meta.user_id,
      meta.kind,
      meta.mime,
      meta.name,
      meta.bytes,
      meta.w,
      meta.h,
      store,
      store === "d1" ? b64 : null,
      r2Key,
      now
    )
    .run();
  return r.meta.last_row_id as number;
}

/**
 * 取回內容（base64 字串）。依「該列自己記的」storage 決定去哪讀 —— 這就是切換 R2 之後
 * 舊檔還讀得到的原因。已淘汰（purged=1）或讀不到一律回 null，呼叫端負責顯示佔位。
 */
export async function getB64(env: Env, row: FileRow): Promise<string | null> {
  if (!row || row.purged) return null;
  if (row.storage === "r2") {
    if (!env.FILES || !row.r2_key) return null;
    try {
      const obj = await env.FILES.get(row.r2_key);
      if (!obj) return null;
      return await obj.text();
    } catch (e) {
      return null;
    }
  }
  return row.b64 || null;
}

/**
 * 清除內容但**保留中繼資料**（purged=1、b64／r2_key 清空）。
 * 不整列刪掉是刻意的：對話裡那則訊息還在，前端要顯示「檔案已刪除（IMG_2891.jpg，1.2MB）」
 * 而不是一張破圖或憑空少一格 —— 使用者要看得懂發生了什麼事。
 * 真正整列刪除只發生在「對話本身被刪」的時候（見 cron.ts 與刪對話端點）。
 * R2 物件刪不掉不影響 D1 標記：下一輪孤兒掃描還會再試（最多留一份垃圾物件，不會漏標）。
 */
export async function purgeContent(env: Env, rows: FileRow[]): Promise<number> {
  const list = (rows || []).filter(function (r) {
    return r && !r.purged;
  });
  if (!list.length) return 0;
  if (env.FILES) {
    const keys = list
      .filter(function (r) {
        return r.storage === "r2" && r.r2_key;
      })
      .map(function (r) {
        return r.r2_key as string;
      });
    if (keys.length) {
      try {
        await env.FILES.delete(keys);
      } catch (e) {}
    }
  }
  const ids = list.map(function (r) {
    return r.id;
  });
  const r = await env.DB.prepare(
    "UPDATE pg_files SET purged=1, b64=NULL, r2_key=NULL WHERE id IN (" + ids.join(",") + ")"
  ).run();
  return Number(r.meta.changes) || 0;
}

/**
 * 整列刪除（連中繼資料一起）＋ 順手清掉 R2 物件。
 * 用在「對話被刪」與「孤兒檔案過期」—— 這兩種情況沒有任何訊息會再引用它們，
 * 留著中繼資料只是佔位而已。
 * ids 由呼叫端保證已經過歸屬檢查（不接受外部輸入直接進來）。
 */
export async function deleteFiles(env: Env, rows: FileRow[]): Promise<number> {
  const list = (rows || []).filter(Boolean);
  if (!list.length) return 0;
  if (env.FILES) {
    const keys = list
      .filter(function (r) {
        return r.storage === "r2" && r.r2_key;
      })
      .map(function (r) {
        return r.r2_key as string;
      });
    if (keys.length) {
      try {
        await env.FILES.delete(keys);
      } catch (e) {}
    }
  }
  const ids = list.map(function (r) {
    return r.id;
  });
  const r = await env.DB.prepare("DELETE FROM pg_files WHERE id IN (" + ids.join(",") + ")").run();
  return Number(r.meta.changes) || 0;
}

/**
 * L3 全站總量淘汰：超過上限就從最舊的開始清內容，直到降回上限以下。
 * 回傳清掉幾個。
 *
 * 刻意「只在 cron 跑」而不在上傳當下同步做：淘汰要掃全表、刪 R2 物件，成本跟超量多少
 * 成正比 —— 掛在上傳請求上會讓某一次上傳莫名其妙變得很慢（而且是誰倒楣誰付錢）。
 * 上傳當下只做 O(1) 的配額檢查（SUM 走索引），真正的清理交給每日 cron。
 * 代價是短時間內可以超出上限一點點，這對硬天花板來說完全可以接受（留了 200MB 餘裕）。
 */
export async function evictOldest(env: Env, totalMb: number): Promise<number> {
  const limit = totalMb * 1024 * 1024;
  const cur = await env.DB.prepare("SELECT COALESCE(SUM(bytes),0) AS s FROM pg_files WHERE purged=0").first<{
    s: number;
  }>();
  let over = (Number(cur && cur.s) || 0) - limit;
  if (over <= 0) return 0;
  let done = 0;
  // 一批 100 列，最多 20 批（＝單次最多清 2000 個檔）—— cron 也有時間預算，
  // 真的超量到清不完就下一輪繼續，不要讓單次 job 跑到被砍。
  for (let round = 0; round < 20 && over > 0; round++) {
    const rs = await env.DB.prepare(
      "SELECT * FROM pg_files WHERE purged=0 ORDER BY created_at LIMIT 100"
    ).all();
    const rows = (rs.results || []) as FileRow[];
    if (!rows.length) break;
    const take: FileRow[] = [];
    for (const row of rows) {
      if (over <= 0) break;
      take.push(row);
      over -= Number(row.bytes) || 0;
    }
    if (!take.length) break;
    done += await purgeContent(env, take);
  }
  return done;
}
