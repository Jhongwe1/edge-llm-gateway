// /api/admin/settings — 管理員專用：網站設定。
// GET（2026-07-17 管理員設定頁 /settings 上線時加）：回目前**存的**設定原況 —
//   數字鍵沒設過回 null（不是內建預設值），另附 defaults 物件讓前端當 placeholder；
//   demo_mode 回開關本身的儲存值、demo_active 回真正生效與否（開關＋demo_channel 都要有）。
// PUT — 改網站設定。**本體帶哪個鍵就改哪個鍵**（沒帶的不動）：
//   brand:   新站名（最長 60 字）；空字串＝刪掉自訂站名＝還原預設（正式網址主機名）。
//   contact_url: 管理員對外聯絡連結（http/https，最長 300 字；顯示在會員頁登入閘門的「聯絡我」鈕）。
//            空字串或 null＝刪鍵＝不顯示聯絡鈕。
//   pg_open: true/false — Playground 對所有登入會員開放（不必逐人批准；封鎖者照擋）。
//            存 settings 表 pg_open='1'；false＝刪鍵＝回到逐人批准。
//   pg_default_system（2026-07-21）：Playground 的**預設**系統提示詞 — 所有「沒自己填」的
//            管道共用這一段（改一次全部換，不必逐個管道開視窗）。管道自己填了就以管道為準。
//            最長 4000 字；空字串或 null＝刪鍵＝回到程式內建那段（PG_DEFAULT_SYSTEM）。
//            只作用在 /playground；/relay API 中轉是透明代理，一個字都不注入。
//   quota_relay_day / quota_pg_day / rl_per_min（2026-07-14 配額全域預設）：
//            正整數＝覆寫程式內建預設（src/lib/quota.ts QUOTA_DEFAULTS）；null 或空字串＝刪鍵＝回到內建。
//   relay_meter: true/false — 中轉計量 pump 的總開關（false 存 '0'＝退回純直通；true＝刪鍵＝預設開）。
//            計量 pump 出怪問題時的免部署保險，平常不要動。
//   tg_bot_token / tg_chat_id（2026-07-17 /settings 頁）：Telegram 告警憑證改可存 D1 —
//            cron tgAlertScan 讀取 **D1 優先、Cloudflare secrets 後備**；空字串＝刪鍵。
//            token 回讀一律遮罩（tg_token_set/tg_token_hint）、audit 不落明文。
//   dumb_mode / dumb_channel / dumb_model（v2.2 Dumb mode）：把所有會員鎖在單一「隱藏」模型 —
//            開關＋渠道 slug＋模型名三者齊全才生效；生效時會員的模型選單消失、
//            聊天請求一律被蓋成指定模型、對話回讀遮掉 channel/model（管理員不受限）。
//   demo_mode / demo_channel / demo_models / demo_per_min / demo_per_ip_day / demo_global_day /
//   demo_max_tokens（v2.0.0 Phase K 體驗模式）：
//            demo_mode true/false；demo_channel＝鎖定的渠道 slug（**沒設＝demo 不生效**）；
//            demo_models＝逗號分隔模型白名單（空＝該渠道全部）；四個數字鍵 null＝回內建預設
//            （3／10／200／不限，src/lib/demo.ts DEMO_DEFAULTS — demo_max_tokens 預設 0＝不壓回覆長度）。
// 回 { ok, brand, custom, pg_open, quota_*, rl_per_min, relay_meter, demo_* }（改完的現況）。
import { json, siteBrand } from "../../../lib/site.js";
import { adminOk, pgOpenAll } from "../../../lib/auth.js";
import { QUOTA_DEFAULTS } from "../../../lib/quota.js";
import { DEMO_DEFAULTS, demoCfg } from "../../../lib/demo.js";
import { PG_DEFAULT_SYSTEM, PG_LIMITS } from "../../../lib/playground.js";
import { FILE_DEFAULTS, FILE_CEILING, activeStore, fileLimits } from "../../../lib/filestore.js";
import { R2_FREE, R2_PLAN, r2Ops, r2MbFromRawMb } from "../../../lib/r2budget.js";
import { audit } from "../../../lib/observe.js";
import type { RouteCtx } from "../../../types.js";

const QUOTA_KEYS = ["quota_relay_day", "quota_pg_day", "rl_per_min"];
const DEMO_NUM_KEYS = ["demo_per_min", "demo_per_ip_day", "demo_global_day", "demo_max_tokens"];
// Playground 附件的三層容量（2026-07-29 v2.3，預設值在 lib/filestore.ts FILE_DEFAULTS）：
// 單檔 KB／每人 MB／全站 MB。跟 QUOTA_KEYS 走同一套語意（正整數，空字串＝刪鍵＝回預設）。
// **預設值與可設定範圍都跟著儲存模式走**（純 D1／D1+R2），因為兩邊的物理限制不同：
// D1 卡在單值 2,000,000 bytes 與免費庫 500MB，R2 卡在免費額度 10GB／月。
// 天花板寫死在 FILE_CEILING，這裡只負責把超過的請求擋下來並說清楚為什麼 ——
// 「配額可設定」不能等於「免費額度可突破」，手滑多打一個 0 就開始收費是不能接受的。
const FILE_KEYS = ["pgfile_max_kb", "pgfile_user_mb", "pgfile_total_mb"];
// 單次請求「所有圖片」的 bytes 總和上限（KB）。2026-07-29 站長把預設放寬到 16MB，
// 並要求「先讓大家測、幾天後看數據再定」—— 做成設定就是為了那一步：
// 調整不必改程式、不必重新部署，/settings 改完立刻生效。
// 天花板是 PG_LIMITS.maxImgBytesCeiling（只能往下調）。
const PG_IMG_KEY = "pg_img_total_kb";
const ALL_KEYS = [
  "brand",
  "contact_url",
  "pg_open",
  "pg_default_system",
  "relay_meter",
  "demo_mode",
  "demo_channel",
  "demo_models",
  // Dumb mode（2026-07-22 v2.2）：把所有會員鎖在單一隱藏模型（管理員不受限）。
  // dumb_mode='1' 開關；dumb_channel＋dumb_model＝指定的渠道×模型 — 三者齊全才生效。
  "dumb_mode",
  "dumb_channel",
  "dumb_model",
  // VPN 對外展示（2026-07-22 v2.2）：'1'＝選單與 /vpn 頁對所有人可見（訂閱仍要批准）；
  // 沒設＝維持 VPN 隱形（只有管理員／被批准 vpn 的人看得到）。
  "vpn_public",
  // Telegram 告警（2026-07-17 /settings 頁上線時加）：存 D1 settings，cron 讀取時
  // **D1 優先、Cloudflare secrets（TG_BOT_TOKEN/TG_CHAT_ID）後備**。空字串＝刪鍵。
  // 跟中轉管道上游金鑰同一套資安待遇：回讀遮罩、audit 不落明文。
  "tg_bot_token",
  "tg_chat_id"
]
  .concat(QUOTA_KEYS)
  .concat(DEMO_NUM_KEYS)
  .concat(FILE_KEYS)
  .concat([PG_IMG_KEY]);

// Telegram bot token 的遮罩提示（同 relay 管道 key_hint 精神：只給尾 4 碼）
function tgHint(v: string | undefined): string {
  return v ? "…" + v.slice(-4) : "";
}

/**
 * 附件的真實用量（/settings 的「附件儲存」卡拿去顯示）。
 *
 * 兩個數字刻意分開回，因為它們量的是不同的東西：
 *   filesRawMb — 全部未清除附件的**原始檔大小**合計。這把尺要跟 pgfile_total_mb 一致，
 *                也要跟 cron 淘汰時比對的那個 SUM 一致，所以不分 d1／r2 全算進來。
 *   r2FilesMb  — 只算存在 R2 的那些，再乘 4/3 還原成 base64 的**實際佔用**。
 *                這才是拿去跟 10GB 免費額度比的數字。
 * 兩者用同一次查詢取得（CASE WHEN），不為了一張唯讀卡多打一趟 D1。
 *
 * backupRaw＝settings 的 r2_backup_mb（每日 cron 量完寫進去的）。cron 還沒跑過就是
 * null，UI 顯示「待每日排程量測」而不是假裝它是 0 —— 0 會讓人以為備份不佔空間。
 */
async function storageUsed(
  env: RouteCtx["env"],
  store: "d1" | "r2",
  backupRaw: string | undefined
): Promise<Record<string, number | null>> {
  let allBytes = 0;
  let r2Bytes = 0;
  try {
    const r = await env.DB.prepare(
      "SELECT COALESCE(SUM(bytes),0) AS a, " +
        "COALESCE(SUM(CASE WHEN storage='r2' THEN bytes ELSE 0 END),0) AS r " +
        "FROM pg_files WHERE purged=0"
    ).first<{ a: number; r: number }>();
    allBytes = Number(r && r.a) || 0;
    r2Bytes = Number(r && r.r) || 0;
  } catch (e) {}
  const filesRawMb = Math.ceil(allBytes / 1048576);
  if (store !== "r2")
    return { filesRawMb: filesRawMb, r2FilesMb: null, backupMb: null, r2TotalMb: null, r2Pct: null };
  const r2FilesMb = r2MbFromRawMb(Math.ceil(r2Bytes / 1048576));
  const b = parseInt(backupRaw || "", 10);
  const backupMb = Number.isFinite(b) ? b : null;
  const r2TotalMb = r2FilesMb + (backupMb || 0);
  return {
    filesRawMb: filesRawMb,
    r2FilesMb: r2FilesMb,
    backupMb: backupMb,
    r2TotalMb: r2TotalMb,
    r2Pct: Math.round((r2TotalMb / R2_FREE.storageMb) * 100)
  };
}

// 設定表目前的原況（給 /settings 管理頁當編輯初值）。數字鍵沒設過＝null；
// 前端拿 defaults 當 placeholder，空欄送 null＝清掉覆寫、回到內建預設。
export async function onRequestGet(context: RouteCtx): Promise<Response> {
  const { request, env } = context;
  const url = new URL(request.url);
  if (!(await adminOk(request, env, url))) return json({ error: "unauthorized" }, 401);
  if (!env.DB) return json({ error: "no-db" }, 500);
  const store = activeStore(env); // 附件存哪：有 FILES 綁定＝r2，沒有＝d1
  try {
    const res = await env.DB.prepare(
      "SELECT k,v FROM settings WHERE k IN ('brand','contact_url','pg_open','pg_default_system','relay_meter'," +
        "'quota_relay_day','quota_pg_day','rl_per_min','tg_bot_token','tg_chat_id'," +
        "'demo_mode','demo_channel','demo_models','demo_per_min','demo_per_ip_day','demo_global_day','demo_max_tokens'," +
        "'dumb_mode','dumb_channel','dumb_model','vpn_public'," +
        "'pgfile_max_kb','pgfile_user_mb','pgfile_total_mb','r2_backup_mb')"
    ).all();
    const st: Record<string, string> = {};
    ((res.results || []) as { k: string; v: string }[]).forEach(function (r) {
      st[r.k] = r.v;
    });
    const numOrNull = function (v: string | undefined): number | null {
      const n = parseInt(v || "", 10);
      return Number.isFinite(n) ? n : null;
    };
    return json({
      ok: true,
      brand: st.brand || siteBrand(env, request),
      custom: !!st.brand,
      contact_url: st.contact_url || "",
      pg_open: st.pg_open === "1",
      // 沒設過回空字串（不是內建那段）— 前端把內建放 placeholder，空欄就代表「用內建」。
      pg_default_system: st.pg_default_system || "",
      relay_meter: st.relay_meter !== "0",
      quota_relay_day: numOrNull(st.quota_relay_day),
      quota_pg_day: numOrNull(st.quota_pg_day),
      rl_per_min: numOrNull(st.rl_per_min),
      demo_mode: st.demo_mode === "1",
      demo_active: st.demo_mode === "1" && !!String(st.demo_channel || "").trim(),
      demo_channel: st.demo_channel || "",
      demo_models: st.demo_models || "",
      demo_per_min: numOrNull(st.demo_per_min),
      demo_per_ip_day: numOrNull(st.demo_per_ip_day),
      demo_global_day: numOrNull(st.demo_global_day),
      demo_max_tokens: numOrNull(st.demo_max_tokens),
      dumb_mode: st.dumb_mode === "1",
      dumb_active:
        st.dumb_mode === "1" &&
        !!String(st.dumb_channel || "").trim() &&
        !!String(st.dumb_model || "").trim(),
      dumb_channel: st.dumb_channel || "",
      dumb_model: st.dumb_model || "",
      vpn_public: st.vpn_public === "1",
      // Playground 附件的三層容量（v2.3）；null＝沒設過＝用 defaults 那組
      pgfile_max_kb: numOrNull(st.pgfile_max_kb),
      pgfile_user_mb: numOrNull(st.pgfile_user_mb),
      pgfile_total_mb: numOrNull(st.pgfile_total_mb),
      // Telegram 告警：token 絕不回明文（只回 set/hint）；chat id 不是秘密可回。
      // tg_active＝告警實際會不會發（D1 或 secrets 湊齊 token+chat 其一即可）。
      tg_chat_id: st.tg_chat_id || "",
      tg_token_set: !!st.tg_bot_token,
      tg_token_hint: tgHint(st.tg_bot_token),
      tg_env_set: !!(env.TG_BOT_TOKEN && env.TG_CHAT_ID),
      tg_active: !!(st.tg_bot_token || env.TG_BOT_TOKEN) && !!(st.tg_chat_id || env.TG_CHAT_ID),
      // 只放「可用 PUT 設定」的數字鍵（DEMO_DEFAULTS 另含內部用的 maxInputChars，不外流）
      // ＋ pg_default_system 的內建值（前端拿去當灰字，管理員看得到「留空會送出什麼」）
      defaults: {
        pg_default_system: PG_DEFAULT_SYSTEM,
        quota_relay_day: QUOTA_DEFAULTS.quota_relay_day,
        quota_pg_day: QUOTA_DEFAULTS.quota_pg_day,
        rl_per_min: QUOTA_DEFAULTS.rl_per_min,
        demo_per_min: DEMO_DEFAULTS.demo_per_min,
        demo_per_ip_day: DEMO_DEFAULTS.demo_per_ip_day,
        demo_global_day: DEMO_DEFAULTS.demo_global_day,
        demo_max_tokens: DEMO_DEFAULTS.demo_max_tokens,
        pgfile_max_kb: FILE_DEFAULTS[store].pgfile_max_kb,
        pgfile_user_mb: FILE_DEFAULTS[store].pgfile_user_mb,
        pgfile_total_mb: FILE_DEFAULTS[store].pgfile_total_mb
      },
      // 附件儲存的現況（給 /settings 頁顯示，讓管理員知道自己在哪個模式、還剩多少）。
      // mode：d1＝內容存在資料庫裡；r2＝存在 R2 桶裡（wrangler.toml 的 FILES 綁定決定）。
      // ceiling：這個模式下三個欄位各自能填到多大 —— 前端拿去當 max 屬性與說明文字。
      // ops：本月 R2 操作用量（只有 r2 模式才有意義），百分比是相對於我們自訂的預算
      //      （免費額度的 90%），不是相對於 Cloudflare 的原始額度。
      storage: {
        mode: store,
        ceiling: FILE_CEILING[store],
        free: R2_FREE,
        plan: R2_PLAN,
        ops: store === "r2" ? await r2Ops(env, true) : null,
        // limits＝**現在真正生效**的三層容量（內建預設 → settings 覆寫 → 天花板夾擠之後）。
        // 跟上面那三個 pgfile_* 原況欄位不一樣：那些是「有沒有設過」，這個是「實際擋在哪」。
        limits: await fileLimits(env),
        // used＝真實用量。filesRawMb 跟 pgfile_total_mb 是同一把尺（原始檔大小，
        // 也是 cron 淘汰時比對的那個數）；r2FilesMb 才是 R2 實際佔用（base64 的 4/3）。
        used: await storageUsed(env, store, st.r2_backup_mb)
      }
    });
  } catch (e: any) {
    return json({ error: "query-failed", detail: String((e && e.message) || e) }, 500);
  }
}

export async function onRequestPut(context: RouteCtx): Promise<Response> {
  const { request, env } = context;
  const url = new URL(request.url);
  if (!(await adminOk(request, env, url))) return json({ error: "unauthorized" }, 401);
  if (!env.DB) return json({ error: "no-db" }, 500);

  let body: any = null;
  try {
    body = await request.json();
  } catch (e) {}
  if (!body || typeof body !== "object") return json({ error: "bad-input", hint: "需要 JSON 本體" }, 400);
  if (
    !ALL_KEYS.some(function (k) {
      return k in body;
    })
  ) {
    return json({ error: "bad-input", hint: "至少要帶一個設定鍵（" + ALL_KEYS.join(" / ") + "）" }, 400);
  }

  // 先全部驗證、最後一次寫入（2026-07-22）。
  // 舊版是逐鍵「驗證 → 立刻 await 寫入」：14 個鍵裡只要有一個在後段被擋下，前段已經
  // 落地的照樣留在 D1，而端點回 400、前端把它當「整包失敗」不重抓 —— UI 與資料庫從此
  // 不一致，而且雙方都不知道。改成收集 statements、驗完才 env.DB.batch()（D1 的 batch
  // 是單一交易）之後，400 的語意變成「什麼都沒發生」。副作用是十幾次 D1 往返收斂成 1 次。
  const stmts: D1PreparedStatement[] = [];
  const put = function (k: string, v: string) {
    stmts.push(
      env.DB.prepare(
        "INSERT INTO settings (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v=excluded.v"
      ).bind(k, v)
    );
  };
  const del = function (k: string) {
    stmts.push(env.DB.prepare("DELETE FROM settings WHERE k=?1").bind(k));
  };

  try {
    if ("brand" in body) {
      const brand = String(body.brand == null ? "" : body.brand)
        .trim()
        .slice(0, 60);
      if (!brand) del("brand");
      else put("brand", brand);
    }
    if ("contact_url" in body) {
      const cu = String(body.contact_url == null ? "" : body.contact_url)
        .trim()
        .slice(0, 300);
      if (!cu) del("contact_url");
      else if (!/^https?:\/\//i.test(cu)) {
        return json(
          { error: "bad-input", hint: "contact_url 要是 http(s):// 開頭的網址，或空字串＝移除" },
          400
        );
      } else put("contact_url", cu);
    }
    if ("pg_open" in body) {
      if (body.pg_open) put("pg_open", "1");
      else del("pg_open");
    }
    if ("pg_default_system" in body) {
      const ps = String(body.pg_default_system == null ? "" : body.pg_default_system)
        .trim()
        .slice(0, 4000);
      if (!ps)
        del("pg_default_system"); // 空＝回到內建 PG_DEFAULT_SYSTEM
      else put("pg_default_system", ps);
    }
    const store = activeStore(env);
    const ceiling = FILE_CEILING[store] as Record<string, number>;
    for (const k of QUOTA_KEYS.concat(FILE_KEYS).concat([PG_IMG_KEY])) {
      if (!(k in body)) continue;
      const v = body[k];
      if (v === null || v === "") {
        del(k);
        continue;
      }
      const n = parseInt(v, 10);
      if (!Number.isFinite(n) || n < 1) {
        const def =
          (QUOTA_DEFAULTS as Record<string, number>)[k] ??
          (FILE_DEFAULTS[store] as Record<string, number>)[k] ??
          (k === PG_IMG_KEY ? Math.round(PG_LIMITS.maxImgBytesTotal / 1024) : undefined);
        return json(
          { error: "bad-input", hint: k + " 要是正整數，或 null＝回到內建預設（" + def + "）" },
          400
        );
      }
      // 圖片總量的天花板跟附件三層分開算（它限的是 CPU，不是儲存額度）
      if (k === PG_IMG_KEY) {
        const capKb = Math.round(PG_LIMITS.maxImgBytesCeiling / 1024);
        if (n > capKb) {
          return json(
            {
              error: "bad-input",
              hint:
                PG_IMG_KEY +
                " 最多只能設到 " +
                capKb +
                " KB —— 這條限的是免費方案每請求 10ms CPU（組上游 body 的成本跟圖片總 bytes 成正比），不是儲存空間",
              ceiling: capKb
            },
            400
          );
        }
      }
      // 附件三層有硬天花板（見 FILE_CEILING）。超過就擋，並且明講擋在哪、為什麼 ——
      // 這是「確保不會超出免費額度」真正生效的地方，靜靜夾成上限反而會讓人以為設定成功了。
      if (k in ceiling && n > ceiling[k]) {
        return json(
          {
            error: "bad-input",
            hint:
              k +
              " 最多只能設到 " +
              ceiling[k] +
              "（目前是 " +
              (store === "r2" ? "R2" : "純 D1") +
              " 儲存模式）—— " +
              (store === "r2"
                ? "再高就會吃掉 Cloudflare R2 每月 " + R2_FREE.storageMb / 1024 + "GB 免費額度"
                : "再高就會超過 D1 的單值 2MB／免費庫 500MB 限制，寫入時才會失敗"),
            ceiling: ceiling[k],
            mode: store
          },
          400
        );
      }
      put(k, String(n));
    }
    if ("relay_meter" in body) {
      if (body.relay_meter)
        del("relay_meter"); // 預設就是開
      else put("relay_meter", "0");
    }
    // —— demo 體驗模式（Phase K）——
    if ("demo_mode" in body) {
      if (body.demo_mode) put("demo_mode", "1");
      else del("demo_mode");
    }
    if ("demo_channel" in body) {
      const dc = String(body.demo_channel == null ? "" : body.demo_channel)
        .trim()
        .toLowerCase()
        .slice(0, 100);
      if (!dc) del("demo_channel");
      else put("demo_channel", dc);
    }
    if ("demo_models" in body) {
      const dm = String(body.demo_models == null ? "" : body.demo_models)
        .trim()
        .slice(0, 1000);
      if (!dm) del("demo_models");
      else put("demo_models", dm);
    }
    for (const k of DEMO_NUM_KEYS) {
      if (!(k in body)) continue;
      const v = body[k];
      if (v === null || v === "") {
        del(k);
        continue;
      }
      const n = parseInt(v, 10);
      if (!Number.isFinite(n) || n < 1) {
        // 內建預設 0（demo_max_tokens）代表「不限」— 別把 0 直接印給管理員看
        const d = (DEMO_DEFAULTS as Record<string, number>)[k];
        return json(
          {
            error: "bad-input",
            hint: k + " 要是正整數，或 null＝回到內建預設（" + (d > 0 ? d : "不限") + "）"
          },
          400
        );
      }
      put(k, String(n));
    }
    // —— Dumb mode（單一隱藏模型）——
    if ("dumb_mode" in body) {
      if (body.dumb_mode) put("dumb_mode", "1");
      else del("dumb_mode");
    }
    if ("dumb_channel" in body) {
      const dc = String(body.dumb_channel == null ? "" : body.dumb_channel)
        .trim()
        .toLowerCase()
        .slice(0, 100);
      if (!dc) del("dumb_channel");
      else put("dumb_channel", dc);
    }
    if ("dumb_model" in body) {
      // 模型名不轉小寫（上游模型名大小寫敏感）
      const dm = String(body.dumb_model == null ? "" : body.dumb_model)
        .trim()
        .slice(0, 200);
      if (!dm) del("dumb_model");
      else put("dumb_model", dm);
    }
    // —— VPN 對外展示 ——
    if ("vpn_public" in body) {
      if (body.vpn_public) put("vpn_public", "1");
      else del("vpn_public");
    }
    // —— Telegram 告警（存 D1；cron 讀取 D1 優先、secrets 後備）——
    if ("tg_bot_token" in body) {
      const v = String(body.tg_bot_token == null ? "" : body.tg_bot_token)
        .trim()
        .slice(0, 100);
      if (!v) del("tg_bot_token");
      else put("tg_bot_token", v);
    }
    if ("tg_chat_id" in body) {
      const v = String(body.tg_chat_id == null ? "" : body.tg_chat_id)
        .trim()
        .slice(0, 50);
      if (!v) del("tg_chat_id");
      else put("tg_chat_id", v);
    }

    // 這一行之前的每個 return 400 都代表「一列都沒寫」——原子性就靠這個位置。
    if (stmts.length) await env.DB.batch(stmts);

    // 稽核：記「帶了哪些鍵、改成什麼」（站名與開關不是秘密，可直接記值；
    // tg_bot_token 是秘密 — 只記「有更新」，明文絕不進 audit_log）
    const changed = ALL_KEYS.filter(function (k) {
      return k in body;
    })
      .map(function (k) {
        if (k === "tg_bot_token") return "tg_bot_token=" + (body[k] ? "(updated)" : "(cleared)");
        return k + "=" + String(body[k]).slice(0, 60);
      })
      .join(", ");
    audit(
      env,
      function (p) {
        context.waitUntil(p);
      },
      request,
      "settings.put",
      "",
      changed
    );

    // 回傳改完的現況（settings 沒鍵時顯示內建預設）
    const res = await env.DB.prepare(
      "SELECT k,v FROM settings WHERE k IN ('brand','contact_url','pg_default_system','quota_relay_day','quota_pg_day','rl_per_min','relay_meter','demo_channel','demo_models','tg_bot_token','tg_chat_id','dumb_mode','dumb_channel','dumb_model','vpn_public')"
    ).all();
    const st: Record<string, string> = {};
    ((res.results || []) as { k: string; v: string }[]).forEach(function (r) {
      st[r.k] = r.v;
    });
    const dcfg = await demoCfg(env);
    return json({
      ok: true,
      brand: st.brand || siteBrand(env, request),
      custom: !!st.brand,
      contact_url: st.contact_url || "",
      pg_open: await pgOpenAll(env),
      pg_default_system: st.pg_default_system || "",
      quota_relay_day: st.quota_relay_day ? parseInt(st.quota_relay_day, 10) : QUOTA_DEFAULTS.quota_relay_day,
      quota_pg_day: st.quota_pg_day ? parseInt(st.quota_pg_day, 10) : QUOTA_DEFAULTS.quota_pg_day,
      rl_per_min: st.rl_per_min ? parseInt(st.rl_per_min, 10) : QUOTA_DEFAULTS.rl_per_min,
      relay_meter: st.relay_meter !== "0",
      demo_mode: dcfg.on,
      demo_channel: st.demo_channel || "",
      demo_models: st.demo_models || "",
      demo_per_min: dcfg.on ? dcfg.perMin : DEMO_DEFAULTS.demo_per_min,
      demo_per_ip_day: dcfg.on ? dcfg.perIpDay : DEMO_DEFAULTS.demo_per_ip_day,
      demo_global_day: dcfg.on ? dcfg.globalDay : DEMO_DEFAULTS.demo_global_day,
      demo_max_tokens: dcfg.on ? dcfg.maxTokens : DEMO_DEFAULTS.demo_max_tokens,
      dumb_mode: st.dumb_mode === "1",
      dumb_active:
        st.dumb_mode === "1" &&
        !!String(st.dumb_channel || "").trim() &&
        !!String(st.dumb_model || "").trim(),
      dumb_channel: st.dumb_channel || "",
      dumb_model: st.dumb_model || "",
      vpn_public: st.vpn_public === "1",
      tg_chat_id: st.tg_chat_id || "",
      tg_token_set: !!st.tg_bot_token,
      tg_token_hint: tgHint(st.tg_bot_token),
      tg_active: !!(st.tg_bot_token || env.TG_BOT_TOKEN) && !!(st.tg_chat_id || env.TG_CHAT_ID)
    });
  } catch (e: any) {
    return json({ error: "save-failed", detail: String((e && e.message) || e) }, 500);
  }
}
