// 上游模型能力快取（v2.4.1，migration 0009）。目前只快取一件事：
// **這個模型單次請求最多吃幾張圖**。
//
// 起因（2026-07-30 線上事故）：會員一次丟 4 張圖，上游回
//   {"error":"At most 1 image(s) may be provided in one prompt. (parameter=image)"}
// 而站上寫死「單則 4 張」（PG_LIMITS.maxImgPerMsg），跟模型能吃幾張沒有任何關係。
// 這是**逐模型**的差異：同一個上游底下，有的模型吃 1 張、有的吃 10 張、有的 20 張。
// 靠管理員手動維護一份對照表是行不通的（模型清單會變、數字只有上游知道），
// 所以改成直接去問上游。
//
// ── 三條設計原則 ───────────────────────────────────────────────
//
// 1. **聊天路徑永遠不去問上游。** 能力快取進 relay_channels.model_caps，
//    而 chat.ts 本來就要撈整列渠道 —— 等於零額外查詢、零額外子請求。
//    免費方案每請求只有 10ms CPU，這條路上多一次 fetch 是不能接受的（ADR-0011）。
//    真正去問的時機只有兩個：每日 cron、管理員存檔管道。
//
// 2. **問不到就沿用舊值，絕不覆寫成空的。** 大多數 OpenAI 相容上游的 /v1/models
//    只回 {id, object, created, owned_by}，沒有任何能力欄位。那種情況要跟
//    「上游暫時掛掉」一樣視為「這次沒學到東西」，不能把既有快取洗掉 ——
//    否則一次網路抖動就會讓已知的 1 張限制退回預設 4 張，事故立刻重演。
//
// 3. **上游的數字只用來往下砍，不用來往上開。** 站上自己的 maxImgPerMsg（4）與
//    maxImgBytesTotal（1.5MB）是從 CPU 預算反推出來的（見 PG_LIMITS 的實測數字），
//    跟上游肯收幾張是兩回事。上游說 20 張不代表我們的 10ms CPU 扛得住 20 張，
//    所以一律取 min(自己的上限, 上游的上限)。
//
// ── 目前已知會回報能力的上游 ──────────────────────────────────
// Venice（api.venice.ai，OpenAI 相容）：GET /v1/models 的每一列有
//   model_spec.capabilities.{supportsVision, supportsMultipleImages, maxImages}
// 且該端點**不需要金鑰**。解析寫成「有就讀、沒有就跳過」，其他家哪天加上同樣的欄位
// 就自動生效；欄位名不同的家則維持退回預設值，不會出錯。
// 相依方向只有 modelcaps → playground 這一條（playground.ts 不反過來 import 這裡），
// 免得為了「吃不吃圖」這個小判斷在兩個模組之間繞出一個循環相依。
import { PG_LIMITS, chModels, modelSeesImages } from "./playground.js";
import type { ChannelRow, Env } from "../types.js";

/**
 * 快取內容：模型名 → 單次請求最多幾張圖。
 * **0 是有意義的值**，代表「上游說這個模型看不了圖」，跟「沒這個鍵」（沒問到）不一樣。
 */
export type ModelCaps = Record<string, number>;

/**
 * 兩份數字，可信度不同 —— 這是 2026-07-29 晚上用真實請求打出來的教訓：
 *
 *   adv （advertised）：上游 /v1/models **自己宣稱**的能力。
 *   seen（observed）  ：上游**實際回 400 時吐出來**的真實上限。
 *
 * 為什麼要分兩份：**Venice 宣稱的數字會騙人。** 實測（2026-07-29）
 *   google-gemma-4-31b-it  宣稱 maxImages:10 → 實際送 2 張就 400「At most 1 image(s)」
 *   google-gemma-4-26b-a4b-it／venice-uncensored-1-2／qwen3-5-9b／gemma-3-27b 宣稱 10 → 真的吃 2 張
 * 也就是說 metadata 大致可信但不是全部可信，而「哪個會騙」事前無從得知。
 *
 * seen 永遠壓過 adv，而且**每日 cron 重抓時不會被覆寫** —— 這點是必要的：
 * cron 在 19:17:49 跑完會把宣稱的 10 原封不動寫回去，如果 seen 不獨立存放，
 * 我們今天學到的「其實只有 1 張」明天就會被洗掉，事故無限循環。
 */
interface CapsBlob {
  adv: ModelCaps;
  seen: ModelCaps;
}

function toMap(o: unknown): ModelCaps {
  const out: ModelCaps = {};
  if (!o || typeof o !== "object" || Array.isArray(o)) return out;
  for (const k of Object.keys(o as Record<string, unknown>)) {
    const n = Math.floor(Number((o as Record<string, unknown>)[k]));
    if (n >= 0) out[k] = n; // 0＝上游明說看不了圖，要保留
  }
  return out;
}

/**
 * 把 relay_channels.model_caps 解析成 { adv, seen }。
 * 壞掉／空的一律回兩個空物件 —— 呼叫端因此永遠拿得到可用的值，不必自己 try。
 *
 * **相容 v2.4.1 初版的扁平格式**（`{"model":n}`）：那時只有宣稱值，整包當成 adv 讀。
 * 線上已經有這種資料，不能因為換格式就把它當壞資料丟掉。
 */
export function parseCapsBlob(ch: { model_caps?: unknown } | null | undefined): CapsBlob {
  const raw = String((ch && ch.model_caps) || "").trim();
  if (!raw) return { adv: {}, seen: {} };
  try {
    const j = JSON.parse(raw);
    if (!j || typeof j !== "object" || Array.isArray(j)) return { adv: {}, seen: {} };
    const o = j as Record<string, unknown>;
    // 新格式一定有 adv 這個鍵；沒有就是舊的扁平格式
    if (o.adv || o.seen) return { adv: toMap(o.adv), seen: toMap(o.seen) };
    return { adv: toMap(o), seen: {} };
  } catch (e) {
    return { adv: {}, seen: {} };
  }
}

/** 只要宣稱值那一份（refresh 與 vision 判斷用）。 */
export function parseCaps(ch: { model_caps?: unknown } | null | undefined): ModelCaps {
  return parseCapsBlob(ch).adv;
}

/**
 * 上游有沒有明說這個模型吃不吃圖。
 *   true／false＝上游說了；null＝沒問到（呼叫端退回管理員填的 vision_models）
 *
 * 有上游的說法時就以它為準，不再看 vision_models —— 那份清單是人工維護的，
 * 而人工維護的清單一定會過期（新增模型、上游改能力），過期的下場就是會員送出後
 * 吃一發看不懂的 400。上游自己報的能力永遠比管理員記得更新更準。
 *
 * 實際打成功過（seen ≥ 1）也算數：上游肯收圖就是會看圖，比它宣稱的更有說服力。
 */
export function capVision(ch: { model_caps?: unknown } | null | undefined, model: string): boolean | null {
  const { adv, seen } = parseCapsBlob(ch);
  if (seen[model] >= 1) return true;
  if (!Object.prototype.hasOwnProperty.call(adv, model)) return null;
  return adv[model] > 0;
}

/**
 * 這個管道的這個模型，單則訊息最多送幾張圖。
 *
 * 快取裡沒有（還沒問過上游／上游不回報能力）＝退回站上的預設值，也就是這次改動之前的行為。
 * 有的話取 min(站上上限, 上游上限) —— 上游只能把數字往下拉，理由見檔頭第 3 點。
 */
export function maxImagesFor(ch: { model_caps?: unknown } | null | undefined, model: string): number {
  const { adv, seen } = parseCapsBlob(ch);
  // 實際撞出來的上限最可信，直接壓過宣稱值（google-gemma-4-31b-it 宣稱 10、實際 1）
  const n = seen[model] || adv[model];
  if (!n) return PG_LIMITS.maxImgPerMsg; // 沒問到（undefined）與看不了圖（0）都不必給張數
  return Math.min(PG_LIMITS.maxImgPerMsg, n);
}

/**
 * 從上游的錯誤訊息裡把「真正的張數上限」讀出來。
 * 回 null＝這則錯誤跟圖片張數無關（絕大多數 400 都是別的原因，不能亂學）。
 *
 * 目前認得 Venice 的講法：`At most 1 image(s) may be provided in one prompt.`
 * 寫成寬鬆的正則而不是整句比對 —— 其他家的用字不會一樣，但「at most N image」
 * 這個骨架相當通用；認不出來就是不學，沒有副作用。
 */
export function imgLimitFromError(detail: unknown): number | null {
  const m = /at\s+most\s+(\d+)\s+image/i.exec(String(detail || ""));
  if (!m) return null;
  const n = parseInt(m[1], 10);
  // 上限 0 不合理（那是「不支援圖片」，會走另一條錯誤訊息）；過大的數字當雜訊
  return n >= 1 && n <= 1000 ? n : null;
}

/**
 * 把「實際撞出來的張數上限」記進 seen，宣稱值那一份原封不動。
 * 下一次同一個模型就會在**送出之前**被砍到正確張數，不會再吃第二發 400。
 *
 * 靜默失敗：這是從錯誤路徑上長出來的學習動作，學不起來頂多是下次再撞一次，
 * 絕不能因為寫入失敗而讓原本要回給會員的錯誤訊息也跟著掉。
 */
export async function learnImgLimit(
  env: Env,
  ch: ChannelRow,
  model: string,
  limit: number
): Promise<boolean> {
  try {
    const blob = parseCapsBlob(ch);
    if (blob.seen[model] === limit) return false; // 已經學過了，省一次 D1 寫入
    blob.seen[model] = limit;
    await env.DB.prepare("UPDATE relay_channels SET model_caps=?1 WHERE id=?2")
      .bind(JSON.stringify({ adv: blob.adv, seen: blob.seen }), ch.id)
      .run();
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 這個管道的這個模型到底吃不吃圖 —— 全站唯一的判斷入口（v2.4.1 起）。
 *
 * 兩個資訊來源，上游優先：
 *   1. 上游自己回報的能力（model_caps）—— 有就聽它的，管理員不必維護任何東西。
 *   2. 管理員填的 vision_models —— 只在上游不回報能力時才用得到（多數 OpenAI
 *      相容上游的 /v1/models 只回模型名，那種渠道就只剩這份人工清單）。
 *
 * 兩邊都沒有＝不吃圖。維持原本的安全預設：寧可擋下來叫人換模型，
 * 也不要送出去讓上游回一句會員看不懂的 400。
 */
export function seesImagesFor(
  ch: { vision_models?: unknown; model_caps?: unknown } | null | undefined,
  model: string
): boolean {
  const up = capVision(ch, model);
  if (up !== null) return up;
  return modelSeesImages(ch, model);
}

/**
 * 從上游 /v1/models 的回應挑出「模型 → 最多幾張圖」。
 * 回 null＝這個上游根本不回報能力（一個欄位都沒挑到），呼叫端據此保留舊快取。
 *
 * 只收 `keep` 裡的模型（＝管理員在這個管道開出來的那幾個）：
 * 上游動輒回上百個模型，全存進 D1 只是白佔位置，我們也永遠用不到。
 */
export function pickCaps(payload: unknown, keep: string[]): ModelCaps | null {
  const rows = (payload as { data?: unknown[] } | null)?.data;
  if (!Array.isArray(rows)) return null;
  const want = new Set(keep);
  const out: ModelCaps = {};
  let sawAny = false; // 有沒有任何一列帶了能力欄位（分辨「不回報」與「回報了但沒有我們要的模型」）
  for (const r of rows) {
    const row = r as { id?: unknown; model_spec?: { capabilities?: Record<string, unknown> } };
    const caps = row && row.model_spec && row.model_spec.capabilities;
    if (!caps || typeof caps !== "object") continue;
    // supportsVision 是這家有在回報能力的證據；不看圖的模型也算數（證明欄位存在）
    if (typeof caps.supportsVision !== "boolean") continue;
    sawAny = true;
    const id = String(row.id || "");
    if (!id || !want.has(id)) continue;
    // 看不了圖的也要記（記成 0）—— 這樣管理員就不必自己維護 vision_models：
    // 「上游明說不行」跟「我們還沒問過」必須分得出來，靠的就是這個 0 有沒有寫進去。
    if (!caps.supportsVision) {
      out[id] = 0;
      continue;
    }
    // 明確說「不支援多張」＝就是 1 張。這是這次事故的那一款。
    if (caps.supportsMultipleImages === false) {
      out[id] = 1;
      continue;
    }
    const n = Math.floor(Number(caps.maxImages));
    // 支援多張但沒給數字 → 記成站上預設值（不要自己瞎猜一個更大的數）。
    // 一定要寫進去而不是留空，否則 capVision 會以為「沒問到」而退回 vision_models。
    out[id] = n > 0 ? n : PG_LIMITS.maxImgPerMsg;
  }
  return sawAny ? out : null;
}

/** 上游 /v1/models 的網址。anthropic／gemini 沒有這種形狀的端點，回 null＝不問。 */
function modelsUrl(ch: ChannelRow): string | null {
  if (ch.kind !== "openai" && ch.kind !== "custom") return null;
  const base = String(ch.base_url || "").replace(/\/+$/, "");
  return base ? base + "/v1/models" : null;
}

/**
 * 去問一個管道的上游，把能力寫回 model_caps。
 * 回傳這次學到幾個模型的數字；−1＝這個上游不回報能力（或問不到），快取原封不動。
 *
 * 全程不拋例外：這是背景維護工作，任何失敗都不該讓 cron 的其他 job 或管理員存檔失敗。
 */
export async function refreshChannelCaps(env: Env, ch: ChannelRow): Promise<number> {
  const url = modelsUrl(ch);
  if (!url) return -1;
  const models = chModels(ch);
  if (!models.length) return -1;
  try {
    const headers: Record<string, string> = { accept: "application/json" };
    // Venice 這個端點不驗證，但其他 OpenAI 相容上游多半要金鑰 —— 有就帶上。
    if (ch.api_key) headers.authorization = "Bearer " + ch.api_key;
    const resp = await fetch(url, { headers: headers });
    if (!resp.ok) return -1;
    const caps = pickCaps(await resp.json(), models);
    if (!caps) return -1; // 不回報能力 → 保留舊快取（檔頭第 2 點）
    // ⚠ seen 一定要原封不動帶過去。cron 每天會把宣稱值重寫一次，如果順手把
    // seen 也蓋掉，那「實際撞出來只有 1 張」明天就退回宣稱的 10 張，同一發 400
    // 會每天重演一次（2026-07-29 19:17:49 那趟 cron 就是這樣把 10 寫回去的）。
    const seen = parseCapsBlob(ch).seen;
    await env.DB.prepare("UPDATE relay_channels SET model_caps=?1 WHERE id=?2")
      .bind(JSON.stringify({ adv: caps, seen: seen }), ch.id)
      .run();
    return Object.keys(caps).length;
  } catch (e) {
    return -1;
  }
}

/** 每日 cron：把所有啟用中的管道問一輪。回傳給 runJob 記進 settings 的摘要字串。 */
export async function refreshAllCaps(env: Env): Promise<string> {
  if (!env.DB) return "略過（沒有 DB）";
  const res = await env.DB.prepare("SELECT * FROM relay_channels WHERE enabled=1").all();
  const rows = (res.results || []) as unknown as ChannelRow[];
  if (!rows.length) return "沒有啟用中的管道";
  const notes: string[] = [];
  for (const ch of rows) {
    const n = await refreshChannelCaps(env, ch);
    notes.push(ch.slug + (n < 0 ? "＝不回報" : "＝" + n + " 個模型"));
  }
  return notes.join("、");
}
