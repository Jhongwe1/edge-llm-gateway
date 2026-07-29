// src/cron.ts — cron 派工（v2.0.0 Phase I）：備份／日聚合／保留清理／Telegram 告警。
//
// 兩條排程（wrangler.toml [triggers]）：
//   "*/5 * * * *"  → tgAlertScan：掃 errlog 增量、推 Telegram（/settings 或 secrets 未設＝跳過）
//   "17 19 * * *"  → rollupUsageDaily ＋ backupToR2 ＋ purgeOld（UTC 19:17＝台北 03:17 低峰）
//
// 紀律：每個 job 各自 try/catch 隔離 — 一個壞不拖累其他；結果寫 settings cron_last_<job>
// （JSON {ts,ok,note|err}，/logs 或 API 隨時可查），失敗另寫 errlog（src=cron.<job>），
// 下一輪 tgAlertScan 自然把 cron 自身的故障也告警出去。
// 測試性：now 可注入；job 函式全部具名匯出、可直呼。
import { reportErrorNow } from "./lib/observe.js";
import { deleteFiles, evictOldest, fileLimits } from "./lib/filestore.js";
import type { FileRow } from "./lib/filestore.js";
import type { Env, Row } from "./types.js";

export const CRON_ALERTS = "*/5 * * * *";
export const CRON_DAILY = "17 19 * * *";

// ---- settings 小工具（cron 自用；表在 migrations/0001 就有） ----
async function getSetting(env: Env, k: string): Promise<string | null> {
  const r = await env.DB.prepare("SELECT v FROM settings WHERE k=?1").bind(k).first<{ v: string }>();
  return r ? String(r.v) : null;
}
async function putSetting(env: Env, k: string, v: string): Promise<void> {
  await env.DB.prepare("INSERT INTO settings (k,v) VALUES (?1,?2) ON CONFLICT(k) DO UPDATE SET v=excluded.v")
    .bind(k, v)
    .run();
}

/**
 * Telegram 告警掃描（每 5 分鐘）：settings tg_cursor（上次送到的 errlog.id）→ 撈增量 →
 * sendMessage → 成功才推進 cursor（失敗下輪重送，至多重複、不會漏）。
 * 憑證來源（2026-07-17 起）：settings 表 tg_bot_token / tg_chat_id（/settings 網頁可設）
 * **優先**，沒有才用 Cloudflare secrets TG_BOT_TOKEN / TG_CHAT_ID 後備。
 * 兩邊都沒設＝直接跳過、cursor 不動 — 之後補設會從上次斷點續送。
 */
export async function tgAlertScan(env: Env): Promise<string> {
  const token = (await getSetting(env, "tg_bot_token")) || (env.TG_BOT_TOKEN ? String(env.TG_BOT_TOKEN) : "");
  const chat = (await getSetting(env, "tg_chat_id")) || (env.TG_CHAT_ID ? String(env.TG_CHAT_ID) : "");
  if (!token || !chat) return "skip：Telegram 未設定（/settings 頁或 secrets）";

  const cursor = parseInt((await getSetting(env, "tg_cursor")) || "0", 10) || 0;
  const rs = await env.DB.prepare("SELECT id,ts,src,msg,path FROM errlog WHERE id>?1 ORDER BY id LIMIT 30")
    .bind(cursor)
    .all();
  const rows = (rs.results || []) as { id: number; ts: string; src: string; msg: string; path: string }[];
  if (!rows.length) return "無新錯誤";

  // 一則訊息打包全部增量（Telegram 上限 4096 字，保守截 3500）
  let text = "⚠️ uaip errlog +" + rows.length + "\n";
  for (const r of rows) {
    const line = "[" + r.src + "] " + String(r.msg).slice(0, 120) + (r.path ? "（" + r.path + "）" : "");
    if (text.length + line.length > 3500) {
      text += "…（其餘略）";
      break;
    }
    text += line + "\n";
  }
  const resp = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text: text, disable_web_page_preview: true })
  });
  if (!resp.ok) throw new Error("telegram sendMessage HTTP " + resp.status);
  await putSetting(env, "tg_cursor", String(rows[rows.length - 1].id));
  return "已告警 " + rows.length + " 筆（cursor→" + rows[rows.length - 1].id + "）";
}

/**
 * 結算「昨日」（UTC）的 req_log 進 usage_daily（migration 0003）。
 * INSERT OR REPLACE：同一天重跑會覆寫同 PK 列 → 冪等；req_log 之後被 90 天清掉，
 * 聚合列仍在 — 長期報告（Phase N）的數據源。
 */
export async function rollupUsageDaily(env: Env, now?: Date): Promise<string> {
  const t = now || new Date();
  const day = new Date(t.getTime() - 86400e3).toISOString().slice(0, 10); // 昨日 UTC
  const lo = day + "T00:00:00.000Z";
  const hi = new Date(new Date(lo).getTime() + 86400e3).toISOString();
  const r = await env.DB.prepare(
    "INSERT OR REPLACE INTO usage_daily (day,user_id,svc,channel,model,n,errs,tokens_in,tokens_out,dur_ms_sum) " +
      "SELECT ?1, user_id, svc, channel, model, COUNT(*), " +
      "SUM(CASE WHEN status>=400 OR status=0 THEN 1 ELSE 0 END), " +
      "SUM(tokens_in), SUM(tokens_out), SUM(dur_ms) " +
      "FROM req_log WHERE ts>=?2 AND ts<?3 GROUP BY user_id, svc, channel, model"
  )
    .bind(day, lo, hi)
    .run();
  return day + " 結算 " + (r.meta.changes || 0) + " 列";
}

// 備份範圍：全部資料表（media 排除 data BLOB — 免費層 10ms CPU 護欄；中繼資料仍留）。
// 用 rowid 游標分批（500 列/批）：每張表都是普通 rowid 表，穩定有序、不吃記憶體。
const BACKUP_TABLES: { t: string; cols: string }[] = [
  { t: "settings", cols: "*" },
  { t: "menu", cols: "*" },
  { t: "articles", cols: "*" },
  { t: "pages", cols: "*" },
  { t: "media", cols: "id,mime,bytes,w,h,created_at" }, // data BLOB 排除
  // 附件同理排除內容欄位（b64 動輒幾百 KB，全量備份會把 R2 物件撐爆、也吃 CPU）——
  // 備份的價值在「哪則訊息掛過哪個檔案」這層關聯，圖片本身遺失是可接受的損失。
  { t: "pg_files", cols: "id,user_id,conv_id,msg_id,kind,mime,name,bytes,w,h,storage,purged,created_at" },
  { t: "users", cols: "*" },
  { t: "sessions", cols: "*" },
  { t: "relay_channels", cols: "*" },
  { t: "vpn_channels", cols: "*" },
  { t: "pg_conversations", cols: "*" },
  { t: "pg_messages", cols: "*" },
  { t: "usage_daily", cols: "*" },
  { t: "req_log", cols: "*" },
  { t: "errlog", cols: "*" },
  { t: "audit_log", cols: "*" },
  { t: "visits", cols: "*" }
];

/**
 * 全庫 JSONL 備份到 R2（binding BACKUPS）：物件 backup/<UTC日>.jsonl，
 * 一列一行 {"t":"users","r":{…}}；同日重跑覆寫同物件（冪等）。保留最近 14 份、其餘刪除。
 */
export async function backupToR2(env: Env, now?: Date): Promise<string> {
  if (!env.BACKUPS) return "skip：無 BACKUPS 綁定";
  const day = (now || new Date()).toISOString().slice(0, 10);
  let out = "";
  let total = 0;
  for (const tab of BACKUP_TABLES) {
    let cursor = 0;
    for (;;) {
      const rs = await env.DB.prepare(
        "SELECT rowid AS _rid, " + tab.cols + " FROM " + tab.t + " WHERE rowid>?1 ORDER BY rowid LIMIT 500"
      )
        .bind(cursor)
        .all();
      const rows = (rs.results || []) as Row[];
      if (!rows.length) break;
      for (const row of rows) {
        cursor = Number(row._rid);
        delete row._rid;
        out += JSON.stringify({ t: tab.t, r: row }) + "\n";
        total++;
      }
      if (rows.length < 500) break;
    }
  }
  const key = "backup/" + day + ".jsonl";
  await env.BACKUPS.put(key, out, { httpMetadata: { contentType: "application/jsonl" } });

  // 保留 14 份：列出 backup/ 前綴、鍵名字典序＝日期序，砍最舊的
  const listed = await env.BACKUPS.list({ prefix: "backup/" });
  const keys = listed.objects.map((o) => o.key).sort();
  const excess = keys.slice(0, Math.max(0, keys.length - 14));
  for (const k of excess) await env.BACKUPS.delete(k);
  return key + "（" + total + " 列" + (excess.length ? "；清掉 " + excess.length + " 份舊備份" : "") + "）";
}

// 保留期限（天）。改這裡就好 —— 三個數字都在同一個地方，不必翻 SQL。
export const RETAIN = {
  reqLog: 90, // 請求紀錄（計量明細；長期趨勢看 usage_daily，那張永久保留）
  conv: 360, // 對話（以 updated_at 計，見 purgeOld 的說明）
  visits: 180, // 訪客紀錄（2026-07-29 站長拍板；此表在此之前**完全沒有**清理機制）
  orphanFileHours: 24 // 上傳了卻沒送出的附件
};

/**
 * 保留清理（接手 lib/quota.ts 退役的 1% 隨機清舊 hack）。
 *
 * ## 2026-07-29 的兩個修正（v2.3）
 *
 * **對話改成整則過期，而不是逐則訊息過期。** 舊規則是「pg_messages 超過 360 天就刪」，
 * 但 pg_conversations **完全沒有任何清理** —— 訊息被刪光之後，對話的殼會永遠留在
 * 側邊欄 History 裡，點進去一片空白，而且只會越積越多。發作時間是站台上線滿一年，
 * 也就是那種「等你發現時已經一堆」的債。
 * 現在改成以 updated_at 判斷整則對話：過期就連訊息、附件一起刪，殼跟內容同進同出。
 * 副作用是「一直在用的長壽對話」永遠不會被清 —— 那是使用者主動在維護的對話，該留。
 *
 * **visits 開始有保留期限。** 這張表每個請求寫一筆、以前沒有任何上限。空間其實不急
 * （實測平均 242 bytes／筆、約 116 筆／天），真正的風險是 D1 免費方案**每日 10 萬列寫入**：
 * 被爬蟲密集掃時一天寫進幾萬筆是很容易的事，額度一旦燒光，那天剩下的時間**整站的
 * D1 寫入全部失敗**（登入、聊天、發文一起掛）。保留期限解決不了單日暴衝（那需要取樣或
 * 寫入上限，記在 DEBT），但至少讓長期成長有天花板。
 *
 * 順序有意義：先刪過期對話（連帶清掉它們的附件），再清孤兒，最後才做全站容量淘汰 ——
 * 前面每一步都在釋放空間，最後那步要處理的量才會是真正的超量。
 */
export async function purgeOld(env: Env, now?: Date): Promise<string> {
  const t = (now || new Date()).getTime();
  const ago = (days: number): string => new Date(t - days * 86400e3).toISOString();
  const notes: string[] = [];

  // 1) 過期對話 → 附件（含 R2 物件）→ 訊息 → 對話本身。
  //    一次最多 500 則，避免單次 job 跑太久；沒清完下一輪繼續。
  let convGone = 0;
  try {
    const rs = await env.DB.prepare("SELECT id FROM pg_conversations WHERE updated_at<?1 LIMIT 500")
      .bind(ago(RETAIN.conv))
      .all();
    const ids = ((rs.results || []) as { id: number }[]).map((r) => Number(r.id));
    if (ids.length) {
      const inList = "(" + ids.join(",") + ")";
      const fr = await env.DB.prepare("SELECT * FROM pg_files WHERE conv_id IN " + inList).all();
      await deleteFiles(env, (fr.results || []) as FileRow[]);
      const res = await env.DB.batch([
        env.DB.prepare("DELETE FROM pg_messages WHERE conv_id IN " + inList),
        env.DB.prepare("DELETE FROM pg_conversations WHERE id IN " + inList)
      ]);
      convGone = Number(res[1] && res[1].meta && res[1].meta.changes) || 0;
    }
  } catch (e) {
    notes.push("對話清理失敗");
  }

  // 2) 例行清理（可以一批打完的部分）
  const res = await env.DB.batch([
    env.DB.prepare("DELETE FROM req_log WHERE ts<?1").bind(ago(RETAIN.reqLog)),
    env.DB.prepare("DELETE FROM sessions WHERE expires_at<?1").bind(new Date(t).toISOString()),
    env.DB.prepare("DELETE FROM visits WHERE ts<?1").bind(ago(RETAIN.visits)),
    // 孤兒訊息：對話已經不在了，訊息卻還在（歷史資料或中途失敗留下的殘骸）
    env.DB.prepare("DELETE FROM pg_messages WHERE conv_id NOT IN (SELECT id FROM pg_conversations)")
  ]);
  const n = (i: number): number => Number(res[i] && res[i].meta && res[i].meta.changes) || 0;

  // 3) 孤兒附件：上傳了但一直沒隨訊息送出（使用者改變主意、關掉分頁）。
  //    24 小時的寬限期是為了「上傳完擱著、隔天回來才送出」這種正常情境。
  let orphan = 0;
  try {
    const fr = await env.DB.prepare("SELECT * FROM pg_files WHERE msg_id IS NULL AND created_at<?1 LIMIT 500")
      .bind(new Date(t - RETAIN.orphanFileHours * 3600e3).toISOString())
      .all();
    orphan = await deleteFiles(env, (fr.results || []) as FileRow[]);
  } catch (e) {}

  // 4) L3 全站容量淘汰：超過上限就從最舊的開始清內容（中繼資料留著顯示「檔案已刪除」）
  let evicted = 0;
  try {
    const lim = await fileLimits(env);
    evicted = await evictOldest(env, lim.totalMb);
  } catch (e) {}

  notes.push(
    "req_log −" +
      n(0) +
      "、sessions −" +
      n(1) +
      "、visits −" +
      n(2) +
      "、對話 −" +
      convGone +
      "、孤兒訊息 −" +
      n(3) +
      "、孤兒附件 −" +
      orphan +
      "、附件淘汰 −" +
      evicted
  );
  return notes.join("；");
}

// 單一 job 的隔離執行：成功／失敗都寫 settings cron_last_<name>；失敗再寫 errlog（告警會撈到）
async function runJob(env: Env, name: string, fn: () => Promise<string>): Promise<void> {
  const ts = new Date().toISOString();
  try {
    const note = await fn();
    await putSetting(env, "cron_last_" + name, JSON.stringify({ ts: ts, ok: true, note: note }));
  } catch (e) {
    await reportErrorNow(env, "cron." + name, e);
    try {
      await putSetting(
        env,
        "cron_last_" + name,
        JSON.stringify({
          ts: ts,
          ok: false,
          err: String((e as { message?: unknown })?.message || e).slice(0, 300)
        })
      );
    } catch (e2) {
      /* settings 也壞了就只剩 errlog */
    }
  }
}

/** scheduled 進入點的派工：比對觸發的 cron 字串。未知字串（dashboard 手動觸發）＝全套跑一遍。 */
export async function runCron(cron: string, env: Env, now?: Date): Promise<void> {
  if (!env || !env.DB) return;
  const isDaily = cron === CRON_DAILY;
  const isAlerts = cron === CRON_ALERTS;
  const all = !isDaily && !isAlerts; // 未知字串（dashboard 手動觸發）＝全套跑一遍
  if (isDaily || all) {
    await runJob(env, "rollup", () => rollupUsageDaily(env, now));
    await runJob(env, "backup", () => backupToR2(env, now));
    await runJob(env, "purge", () => purgeOld(env, now));
  }
  if (isAlerts || all) {
    await runJob(env, "alerts", () => tgAlertScan(env));
  }
}
