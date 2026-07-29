// cron 派工（v2.0.0 Phase I）：Telegram 告警游標、rollup 冪等、R2 備份內容與保留、
// 清理保留期、runJob 隔離（失敗寫 errlog＋cron_last_* 有 ok:false）。
// 全部直呼 src/cron.ts 的具名函式（now 可注入 → 日期斷言確定性）。
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { env, fetchMock } from "cloudflare:test";
import {
  tgAlertScan,
  rollupUsageDaily,
  backupToR2,
  r2Guard,
  purgeOld,
  runCron,
  CRON_ALERTS,
  CRON_DAILY
} from "../../src/cron.js";
import { R2_PLAN, opKeys } from "../../src/lib/r2budget.js";
import { envWith, seedUser } from "../helpers.js";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

async function seedErr(src: string, msg: string): Promise<void> {
  await env.DB.prepare("INSERT INTO errlog (ts,src,msg,detail,path) VALUES (?1,?2,?3,'','/x')")
    .bind(new Date().toISOString(), src, msg)
    .run();
}
async function getSetting(k: string): Promise<string | null> {
  const r = await env.DB.prepare("SELECT v FROM settings WHERE k=?1").bind(k).first<{ v: string }>();
  return r ? String(r.v) : null;
}
async function seedReq(
  ts: string,
  user_id: number,
  svc: string,
  status: number,
  tin: number | null
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO req_log (ts,user_id,svc,channel,model,status,dur_ms,tokens_in,tokens_out) " +
      "VALUES (?1,?2,?3,'ch','m1',?4,100,?5,?5)"
  )
    .bind(ts, user_id, svc, status, tin)
    .run();
}

describe("tgAlertScan", () => {
  it("TG secrets 未設 → 跳過、cursor 不動、不打網路", async () => {
    await seedErr("relay.upstream", "boom");
    const note = await tgAlertScan(env);
    expect(note).toContain("skip");
    expect(await getSetting("tg_cursor")).toBeNull();
  });

  it("有 secrets → 打包送 Telegram、成功才推 cursor；再掃一次＝無新錯誤（不重送）", async () => {
    await seedErr("relay.upstream", "boom-1");
    await seedErr("pg.stream", "boom-2");
    let sent: any = null;
    fetchMock
      .get("https://api.telegram.org")
      .intercept({
        method: "POST",
        path: "/bott123/sendMessage",
        body(b) {
          sent = JSON.parse(String(b));
          return true;
        }
      })
      .reply(200, { ok: true });
    const e2 = envWith({ TG_BOT_TOKEN: "t123", TG_CHAT_ID: "42" });
    const note = await tgAlertScan(e2);
    expect(note).toContain("2 筆");
    expect(sent.chat_id).toBe("42");
    expect(sent.text).toContain("[relay.upstream] boom-1");
    expect(sent.text).toContain("[pg.stream] boom-2");
    const cur = parseInt((await getSetting("tg_cursor")) || "0", 10);
    expect(cur).toBeGreaterThan(0);
    // 第二輪：沒有新列 → 不需要任何 fetch（沒註冊 interceptor，打了就會炸）
    expect(await tgAlertScan(e2)).toBe("無新錯誤");
  });

  it("D1 settings 憑證（/settings 網頁設定）優先於 secrets", async () => {
    await seedErr("relay.upstream", "db-cred");
    await env.DB.prepare(
      "INSERT INTO settings (k,v) VALUES ('tg_bot_token','dbtok'),('tg_chat_id','99')"
    ).run();
    let sent: any = null;
    fetchMock
      .get("https://api.telegram.org")
      .intercept({
        method: "POST",
        path: "/botdbtok/sendMessage", // D1 的 token 勝出（不是 secrets 的 t123）
        body(b) {
          sent = JSON.parse(String(b));
          return true;
        }
      })
      .reply(200, { ok: true });
    const e2 = envWith({ TG_BOT_TOKEN: "t123", TG_CHAT_ID: "42" });
    const note = await tgAlertScan(e2);
    expect(note).toContain("1 筆");
    expect(sent.chat_id).toBe("99"); // chat id 也走 D1
  });

  it("Telegram 回 500 → throw、cursor 不推進（下輪重送）", async () => {
    await seedErr("csp", "x");
    fetchMock
      .get("https://api.telegram.org")
      .intercept({ method: "POST", path: "/bott123/sendMessage" })
      .reply(500, "nope");
    const e2 = envWith({ TG_BOT_TOKEN: "t123", TG_CHAT_ID: "42" });
    await expect(tgAlertScan(e2)).rejects.toThrow(/500/);
    expect(await getSetting("tg_cursor")).toBeNull();
  });
});

describe("rollupUsageDaily", () => {
  it("結算昨日、分組正確、重跑冪等；今日的列不納入", async () => {
    const u = await seedUser();
    const now = new Date("2026-01-03T12:00:00Z"); // 昨日＝2026-01-02
    await seedReq("2026-01-02T05:00:00.000Z", u.id, "relay", 200, 10);
    await seedReq("2026-01-02T06:00:00.000Z", u.id, "relay", 502, 5);
    await seedReq("2026-01-03T01:00:00.000Z", u.id, "relay", 200, 99); // 今日 → 不算
    await rollupUsageDaily(env, now);
    await rollupUsageDaily(env, now); // 冪等
    const rows = (await env.DB.prepare("SELECT * FROM usage_daily").all()).results as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].day).toBe("2026-01-02");
    expect(rows[0].n).toBe(2);
    expect(rows[0].errs).toBe(1);
    expect(rows[0].tokens_in).toBe(15);
    expect(rows[0].dur_ms_sum).toBe(200);
  });
});

describe("backupToR2", () => {
  it("全表 JSONL、media 排除 BLOB、保留 14 份", async () => {
    const u = await seedUser({ name: "備份對象" });
    await env.DB.prepare(
      "INSERT INTO articles (category,title,summary,cover,body_md,status,created_at,updated_at) " +
        "VALUES ('news','備份標題','','','內文','published',?1,?1)"
    )
      .bind(new Date().toISOString())
      .run();
    await env.DB.prepare(
      "INSERT INTO media (mime,bytes,w,h,data,created_at) VALUES ('image/webp',3,1,1,?1,?2)"
    )
      .bind(new Uint8Array([1, 2, 3]), new Date().toISOString())
      .run();
    // 佈 15 份舊備份 → 今天這份寫完應只剩 14 份
    for (let i = 1; i <= 15; i++) {
      const d = "2020-01-" + String(i).padStart(2, "0");
      await env.BACKUPS!.put("backup/" + d + ".jsonl", "{}");
    }
    const now = new Date("2026-01-03T12:00:00Z");
    const note = await backupToR2(env, now);
    expect(note).toContain("backup/2026-01-03.jsonl");
    const obj = await env.BACKUPS!.get("backup/2026-01-03.jsonl");
    expect(obj).not.toBeNull();
    const lines = (await obj!.text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const art = lines.find((x) => x.t === "articles");
    expect(art.r.title).toBe("備份標題");
    const usr = lines.find((x) => x.t === "users" && x.r.id === u.id);
    expect(usr.r.name).toBe("備份對象");
    const med = lines.find((x) => x.t === "media");
    expect(med.r.mime).toBe("image/webp");
    expect("data" in med.r).toBe(false); // BLOB 排除
    const listed = await env.BACKUPS!.list({ prefix: "backup/" });
    expect(listed.objects.length).toBe(14);
    expect(listed.objects.some((o) => o.key === "backup/2020-01-01.jsonl")).toBe(false); // 最舊被清
    expect(listed.objects.some((o) => o.key === "backup/2026-01-03.jsonl")).toBe(true);
  });

  it("無 BACKUPS 綁定 → 跳過不炸", async () => {
    const e2 = envWith({ BACKUPS: undefined });
    expect(await backupToR2(e2)).toContain("skip");
  });

  // 只管份數是不夠的：資料庫會長大，「14 份 × 一份多大」是會漂移的乘積。
  // 沒有這條規則的話，備份可以安靜地把附件的空間吃光，兩邊加起來越過 10GB 免費額度。
  it("備份合計超過預留空間 → 連份數還沒滿也要砍最舊的", async () => {
    const big = "x".repeat(600 * 1024); // 每份 600KB
    for (let i = 1; i <= 5; i++) {
      await env.BACKUPS!.put("backup/2020-02-" + String(i).padStart(2, "0") + ".jsonl", big);
    }
    // 把預留空間當成 1MB 來測（真實值 1536MB，測試裡塞不出那麼多資料）
    const spy = vi.spyOn(R2_PLAN, "backupMb", "get").mockReturnValue(1);
    try {
      await backupToR2(env, new Date("2026-02-09T12:00:00Z"));
    } finally {
      spy.mockRestore();
    }
    const listed = await env.BACKUPS!.list({ prefix: "backup/" });
    const total = listed.objects.reduce((s, o) => s + Number(o.size), 0);
    expect(total).toBeLessThanOrEqual(1024 * 1024);
    expect(listed.objects.length).toBeLessThan(6); // 份數沒滿 14 也照砍
    // 至少留最新那一份 —— 備份全砍光比超出預留空間更糟
    expect(listed.objects.some((o) => o.key === "backup/2026-02-09.jsonl")).toBe(true);
    // 量到的用量記進 settings，purgeOld 靠它算附件還剩多少空間
    expect(parseInt((await getSetting("r2_backup_mb")) || "", 10)).toBeGreaterThanOrEqual(0);
  });
});

describe("r2Guard — 免費額度體檢", () => {
  it("沒有任何 R2 綁定 → 跳過", async () => {
    const e2 = envWith({ BACKUPS: undefined, FILES: undefined });
    expect(await r2Guard(e2)).toContain("skip");
  });

  it("回報空間與本月操作用量（附件按 base64 的 4/3 實佔換算）", async () => {
    await env.DB.prepare(
      "INSERT INTO pg_files (user_id,kind,mime,name,bytes,storage,r2_key,purged,created_at) " +
        "VALUES (1,'image','image/webp','a.webp',?1,'r2','pgfile/1/x',0,?2)"
    )
      .bind(3 * 1048576, new Date().toISOString())
      .run();
    const note = await r2Guard(env);
    expect(note).toContain("空間");
    expect(note).toContain("ClassA");
    // 3MB 原始 → R2 實佔 4MB（4/3）；沒換算的話這裡會是 3
    expect(note).toContain("附件 4");
  });

  it("清掉過期月份的操作計數鍵，留下本月的", async () => {
    const cur = opKeys().a;
    await env.DB.prepare("INSERT OR REPLACE INTO settings (k,v) VALUES (?1,'5')").bind(cur).run();
    await env.DB.prepare("INSERT OR REPLACE INTO settings (k,v) VALUES ('r2a_2020-01','999')").run();
    await r2Guard(env);
    expect(await getSetting("r2a_2020-01")).toBeNull();
    expect(await getSetting(cur)).toBe("5");
  });
});

describe("purgeOld", () => {
  it("req_log 90 天、sessions 過期、visits 180 天", async () => {
    const u = await seedUser();
    const now = new Date("2026-01-03T12:00:00Z");
    const old = (d: number): string => new Date(now.getTime() - d * 86400e3).toISOString();
    await seedReq(old(91), u.id, "relay", 200, null);
    await seedReq(old(89), u.id, "relay", 200, null);
    await env.DB.prepare("INSERT INTO sessions (sid,user_id,created_at,expires_at) VALUES ('dead',?1,?2,?3)")
      .bind(u.id, old(30), old(1))
      .run();
    await env.DB.prepare("INSERT INTO sessions (sid,user_id,created_at,expires_at) VALUES ('live',?1,?2,?3)")
      .bind(u.id, old(1), new Date(now.getTime() + 86400e3).toISOString())
      .run();
    // visits 在 v2.3 之前完全沒有清理機制（2026-07-29 補）
    await env.DB.prepare("INSERT INTO visits (ts,host,path) VALUES (?1,'h','/old')").bind(old(181)).run();
    await env.DB.prepare("INSERT INTO visits (ts,host,path) VALUES (?1,'h','/new')").bind(old(179)).run();

    const note = await purgeOld(env, now);
    expect(note).toContain("req_log −1");
    expect(note).toContain("visits −1");
    const reqs = (await env.DB.prepare("SELECT * FROM req_log").all()).results as any[];
    expect(reqs.length).toBe(1);
    const sess = (await env.DB.prepare("SELECT sid FROM sessions").all()).results as any[];
    expect(sess.map((s) => s.sid)).toEqual(["live"]);
    const vs = (await env.DB.prepare("SELECT path FROM visits").all()).results as any[];
    expect(vs.map((v) => v.path)).toEqual(["/new"]);
  });

  // v2.3 的行為變更：以前是「訊息滿 360 天就刪，對話殼永遠留著」——
  // 結果是一年後 History 裡開始堆積點進去空白的對話。現在改成整則對話一起過期。
  it("對話過期＝殼跟內容同進同出（含附件）；還在用的對話不受影響", async () => {
    const u = await seedUser();
    const now = new Date("2026-01-03T12:00:00Z");
    const old = (d: number): string => new Date(now.getTime() - d * 86400e3).toISOString();
    // 過期對話（361 天沒更新）
    const c1 = await env.DB.prepare(
      "INSERT INTO pg_conversations (user_id,title,created_at,updated_at) VALUES (?1,'舊對話',?2,?2)"
    )
      .bind(u.id, old(361))
      .run();
    const id1 = c1.meta.last_row_id;
    await env.DB.prepare(
      "INSERT INTO pg_messages (conv_id,role,content,created_at) VALUES (?1,'user','舊',?2)"
    )
      .bind(id1, old(361))
      .run();
    await env.DB.prepare(
      "INSERT INTO pg_files (user_id,conv_id,msg_id,kind,mime,name,bytes,storage,b64,purged,created_at) " +
        "VALUES (?1,?2,1,'image','image/webp','a.webp',100,'d1','AAAA',0,?3)"
    )
      .bind(u.id, id1, old(361))
      .run();
    // 還活著的對話（359 天前建、但最近有更新）＋一則很舊的訊息
    const c2 = await env.DB.prepare(
      "INSERT INTO pg_conversations (user_id,title,created_at,updated_at) VALUES (?1,'活的',?2,?3)"
    )
      .bind(u.id, old(400), old(2))
      .run();
    const id2 = c2.meta.last_row_id;
    await env.DB.prepare(
      "INSERT INTO pg_messages (conv_id,role,content,created_at) VALUES (?1,'user','很舊',?2)"
    )
      .bind(id2, old(390))
      .run();

    const note = await purgeOld(env, now);
    expect(note).toContain("對話 −1");
    const convs = (await env.DB.prepare("SELECT title FROM pg_conversations").all()).results as any[];
    expect(convs.map((c) => c.title)).toEqual(["活的"]);
    // 過期對話的訊息與附件一起走；活著的對話裡那則 390 天前的訊息**留著**
    const msgs = (await env.DB.prepare("SELECT content FROM pg_messages").all()).results as any[];
    expect(msgs.map((m) => m.content)).toEqual(["很舊"]);
    const files = (await env.DB.prepare("SELECT id FROM pg_files").all()).results as any[];
    expect(files.length).toBe(0);
  });

  it("孤兒附件（上傳了沒送出）超過 24 小時就清掉；未滿的留著", async () => {
    const u = await seedUser();
    const now = new Date("2026-01-03T12:00:00Z");
    const hrsAgo = (h: number): string => new Date(now.getTime() - h * 3600e3).toISOString();
    const ins = async (name: string, at: string): Promise<void> => {
      await env.DB.prepare(
        "INSERT INTO pg_files (user_id,conv_id,msg_id,kind,mime,name,bytes,storage,b64,purged,created_at) " +
          "VALUES (?1,NULL,NULL,'image','image/webp',?2,100,'d1','AAAA',0,?3)"
      )
        .bind(u.id, name, at)
        .run();
    };
    await ins("stale.webp", hrsAgo(25));
    await ins("fresh.webp", hrsAgo(2));
    const note = await purgeOld(env, now);
    expect(note).toContain("孤兒附件 −1");
    const left = (await env.DB.prepare("SELECT name FROM pg_files").all()).results as any[];
    expect(left.map((f) => f.name)).toEqual(["fresh.webp"]);
  });

  it("孤兒訊息（對話已不存在）一併清掉", async () => {
    const now = new Date("2026-01-03T12:00:00Z");
    await env.DB.prepare(
      "INSERT INTO pg_messages (conv_id,role,content,created_at) VALUES (99999,'user','沒主人',?1)"
    )
      .bind(now.toISOString())
      .run();
    const note = await purgeOld(env, now);
    expect(note).toContain("孤兒訊息 −1");
    const msgs = (await env.DB.prepare("SELECT content FROM pg_messages WHERE conv_id=99999").all())
      .results as any[];
    expect(msgs.length).toBe(0);
  });
});

describe("runCron 派工與隔離", () => {
  it("每日 cron → rollup/backup/purge 各寫 cron_last_*（ok:true）；不跑告警", async () => {
    await runCron(CRON_DAILY, env, new Date("2026-01-03T12:00:00Z"));
    for (const name of ["rollup", "backup", "purge"]) {
      const rec = JSON.parse((await getSetting("cron_last_" + name)) || "{}");
      expect(rec.ok).toBe(true);
    }
    expect(await getSetting("cron_last_alerts")).toBeNull();
  });

  it("告警 cron 失敗 → cron_last_alerts ok:false ＋ errlog 有 cron.alerts（下輪告警撈得到）", async () => {
    await seedErr("relay.upstream", "boom");
    fetchMock
      .get("https://api.telegram.org")
      .intercept({ method: "POST", path: "/bott123/sendMessage" })
      .reply(500, "nope");
    const e2 = envWith({ TG_BOT_TOKEN: "t123", TG_CHAT_ID: "42" });
    await runCron(CRON_ALERTS, e2);
    const rec = JSON.parse((await getSetting("cron_last_alerts")) || "{}");
    expect(rec.ok).toBe(false);
    expect(rec.err).toContain("500");
    const errs = (await env.DB.prepare("SELECT src FROM errlog ORDER BY id").all()).results as any[];
    expect(errs.map((r) => r.src)).toContain("cron.alerts");
  });
});
