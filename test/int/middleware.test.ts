// functions/_middleware.js — 訪客紀錄的 shouldLog 判斷矩陣。
// shouldLog 沒對外 export，所以透過 onRequest 驅動：用一顆「記錄型」假 DB 觀測
// 到底有沒有寫入 visits（順便驗 logVisit 的 SQL 綁定不會炸）。
import { describe, it, expect, beforeEach } from "vitest";
import { onRequest, VISIT_GUARD } from "../../src/routes/_middleware.js";
import { ORIGIN } from "../helpers.js";

// 假 DB：認 INSERT INTO visits（記下次數與**綁定的欄位值**，欄位順序見 _middleware.ts 的
// INSERT：ts, host, path, method, ip, ua, …）與 INSERT INTO errlog（上限告警）；其餘 no-op。
function recordingEnv(rate?: { deny?: boolean; throws?: boolean }) {
  const state: { inserts: number; binds: unknown[]; errs: unknown[][]; checks: any[] } = {
    inserts: 0,
    binds: [],
    errs: [],
    checks: []
  };
  const stmt = (sql: string) => ({
    bind: (...args: unknown[]) => ({
      run: async () => {
        if (/INSERT INTO visits/i.test(sql)) {
          state.inserts++;
          state.binds = args;
        }
        if (/INSERT INTO errlog/i.test(sql)) state.errs.push(args);
        return { success: true };
      }
    }),
    first: async () => null,
    all: async () => ({ results: [] })
  });
  const env: any = { DB: { prepare: stmt } };
  if (rate) {
    env.RATE_LIMITER = {
      idFromName: (n: string) => n,
      get: () => ({
        check: async (arg: any) => {
          state.checks.push(arg);
          if (rate.throws) throw new Error("DO down");
          return rate.deny ? { ok: false, kind: "day", used: 9, limit: 9 } : { ok: true };
        }
      })
    };
  }
  return { env, state };
}

// 驅動一次請求並等背景寫入跑完；回傳 inserts 次數與寫進 visits 的欄位值。
async function run(
  path: string,
  opts: {
    method?: string;
    headers?: Record<string, string>;
    rate?: { deny?: boolean; throws?: boolean };
  } = {}
) {
  const { env, state } = recordingEnv(opts.rate);
  const waits: Promise<unknown>[] = [];
  const ctx: any = {
    request: new Request(ORIGIN + path, { method: opts.method || "GET", headers: opts.headers || {} }),
    env,
    waitUntil: (p: Promise<unknown>) => waits.push(Promise.resolve(p)),
    next: async () => new Response("ok")
  };
  const r = await onRequest(ctx);
  await Promise.allSettled(waits);
  return { logged: state.inserts > 0, resp: r, binds: state.binds, state };
}

// VISIT_GUARD 是**模組層級**的狀態（每個 isolate 一份），測試之間一定要重置，
// 否則前一條測試把 stopped 設成 true 之後，後面全部會莫名其妙不記錄。
const GUARD_DEFAULTS = { capPerDay: VISIT_GUARD.capPerDay, sample: VISIT_GUARD.sample };
beforeEach(() => {
  VISIT_GUARD.capPerDay = GUARD_DEFAULTS.capPerDay;
  VISIT_GUARD.sample = GUARD_DEFAULTS.sample;
  VISIT_GUARD.day = "";
  VISIT_GUARD.stopped = false;
});

// visits 的 INSERT 欄位順序（_middleware.ts logVisit）
const COL = { ts: 0, host: 1, path: 2, method: 3, ip: 4, ua: 5, lang: 12, referer: 13 };

const HTML = { accept: "text/html" };

describe("shouldLog：會記錄的頁面瀏覽", () => {
  it("首頁與工具頁（Accept: text/html）", async () => {
    for (const p of ["/", "/ip", "/ua", "/news", "/articles"]) {
      expect((await run(p, { headers: HTML })).logged).toBe(true);
    }
  });
  it("動態文章頁與自訂頁面（樣式比對，免 Accept）", async () => {
    expect((await run("/news/12")).logged).toBe(true);
    expect((await run("/articles/345")).logged).toBe(true);
    expect((await run("/p/about")).logged).toBe(true);
  });
  it("尾斜線正規化：/news/ 等同 /news", async () => {
    expect((await run("/news/", { headers: HTML })).logged).toBe(true);
  });
});

describe("shouldLog：不記錄的請求", () => {
  it("API／管理頁／圖片／登入／中轉／VPN 抓取一律不記", async () => {
    for (const p of [
      "/api/me",
      "/api/health",
      "/logs",
      "/admin",
      "/img/5",
      "/auth/login",
      "/auth/callback",
      "/relay/openai/v1/models",
      "/vpn/sub/uvtabc"
    ]) {
      expect((await run(p, { headers: HTML })).logged).toBe(false);
    }
  });
  it("非 GET/HEAD（POST/PUT…）不記", async () => {
    expect((await run("/news", { method: "POST", headers: HTML })).logged).toBe(false);
    expect((await run("/", { method: "PUT", headers: HTML })).logged).toBe(false);
  });
  it("HEAD 記（也是頁面瀏覽）", async () => {
    expect((await run("/", { method: "HEAD", headers: HTML })).logged).toBe(true);
  });
  it("預先抓取（sec-purpose: prefetch）不記", async () => {
    expect((await run("/news", { headers: { accept: "text/html", "sec-purpose": "prefetch" } })).logged).toBe(
      false
    );
    expect((await run("/", { headers: { accept: "text/html", purpose: "prefetch" } })).logged).toBe(false);
  });
  it("非頁面路徑且沒帶 text/html Accept（多為靜態資產請求）不記", async () => {
    expect((await run("/assets/account.js", { headers: { accept: "*/*" } })).logged).toBe(false);
    expect((await run("/favicon.ico")).logged).toBe(false);
  });
  it("沒帶 Accept 但打固定頁面路徑（機器人）仍記", async () => {
    expect((await run("/")).logged).toBe(true);
    expect((await run("/ip")).logged).toBe(true);
  });
});

// ── L1 白名單（2026-08，DEBT #35）──────────────────────────────────────────
// 以前的條件是「帶了 Accept: text/html 就記」，等於**任何路徑都記，連不存在的都記**：
// 掃描器打 /wp-admin、/.env 這些會落到 SPA fallback 回 200，看起來像正常瀏覽，
// 而每個路徑都不一樣還順便讓邊緣快取失效 —— 一發請求一列 D1 寫入，沒有任何上限。
describe("L1 白名單：不存在的路徑不再寫 D1", () => {
  it("掃描器常打的路徑一律不記（就算帶 Accept: text/html）", async () => {
    for (const p of [
      "/wp-admin",
      "/.env",
      "/phpmyadmin",
      "/wp-login.php",
      "/does-not-exist-9f2a",
      "/news/../../etc",
      "/p/約束不了的中文",
      "/news/999999999999999999" // 超過樣式允許的位數
    ]) {
      expect((await run(p, { headers: HTML })).logged).toBe(false);
    }
  });
  it("v2.2 之後才有的 SSR 頁面也在白名單裡（以前靠 Accept 誤打誤撞記到）", async () => {
    for (const p of ["/playground", "/relay", "/vpn", "/members", "/settings", "/api-docs"]) {
      expect((await run(p, { headers: HTML })).logged).toBe(true);
    }
  });
  it("/relay 頁面記、但 /relay/<轉發路徑> 不記", async () => {
    expect((await run("/relay", { headers: HTML })).logged).toBe(true);
    expect((await run("/relay/openai/v1/chat/completions", { headers: HTML })).logged).toBe(false);
  });
});

// ── L2 每日上限 ─────────────────────────────────────────────────────────────
// 重點不只是「會停」，而是**停的時候會留下告警**：那一筆 errlog 會被五分鐘一次的
// tgAlertScan 推到 Telegram，而此刻 D1 還活著。等平台額度真的爆掉才想通知就來不及了。
describe("L2 每日寫入上限（VISIT_GUARD）", () => {
  it("沒綁 RATE_LIMITER：只有 L1，照樣記錄（同 quota_do 的降級語意）", async () => {
    expect((await run("/news", { headers: HTML })).logged).toBe(true);
  });
  it("DO 放行 → 照記；且 perDay 是換算過的抽樣次數，不是瀏覽次數", async () => {
    VISIT_GUARD.sample = 1;
    VISIT_GUARD.capPerDay = 40;
    const { logged, state } = await run("/news", { headers: HTML, rate: {} });
    expect(logged).toBe(true);
    expect(state.checks.length).toBe(1);
    expect(state.checks[0].svc).toBe("visit");
    expect(state.checks[0].perDay).toBe(40); // capPerDay 40 ÷ sample 1
  });
  it("抽樣換算：sample=20、cap=40000 → DO 的 perDay 是 2000", async () => {
    VISIT_GUARD.sample = 1; // 讓這一次必定抽中
    VISIT_GUARD.capPerDay = 40000;
    const { state } = await run("/news", { headers: HTML, rate: {} });
    expect(state.checks[0].perDay).toBe(40000);
    VISIT_GUARD.day = "";
    VISIT_GUARD.stopped = false;
    VISIT_GUARD.sample = 20;
    const r2 = await run("/news", { headers: HTML, rate: {} });
    // sample=20 時這一發不一定被抽到；被抽到的話換算必須是 2000
    if (r2.state.checks.length) expect(r2.state.checks[0].perDay).toBe(2000);
  });
  it("DO 拒絕 → 停止記錄，並寫一筆 visits.cap 告警", async () => {
    VISIT_GUARD.sample = 1;
    const { logged, state } = await run("/news", { headers: HTML, rate: { deny: true } });
    expect(logged).toBe(false);
    expect(VISIT_GUARD.stopped).toBe(true);
    expect(state.errs.length).toBe(1);
    expect(String(state.errs[0][1])).toBe("visits.cap"); // errlog 欄位序：ts, src, msg, …
    expect(String(state.errs[0][2])).toContain("停止記錄");
  });
  it("DO 丟例外 → 同樣停止記錄（護欄壞了就讓路，與 quota 的 fail-open 刻意相反）", async () => {
    VISIT_GUARD.sample = 1;
    const { logged, state } = await run("/news", { headers: HTML, rate: { throws: true } });
    expect(logged).toBe(false);
    expect(state.errs.length).toBe(1);
  });
  it("停止之後不再呼叫 DO（被灌時不會用 DO 額度換 D1 額度）", async () => {
    VISIT_GUARD.sample = 1;
    await run("/news", { headers: HTML, rate: { deny: true } });
    const second = await run("/news", { headers: HTML, rate: { deny: true } });
    expect(second.logged).toBe(false);
    expect(second.state.checks.length).toBe(0);
  });
  it("跨日自動重置（日期入鍵的懶重置，不需要 alarm）", async () => {
    VISIT_GUARD.sample = 1;
    await run("/news", { headers: HTML, rate: { deny: true } });
    expect(VISIT_GUARD.stopped).toBe(true);
    VISIT_GUARD.day = "1999-01-01"; // 假裝上次判斷是很久以前
    const next = await run("/news", { headers: HTML, rate: {} });
    expect(next.logged).toBe(true);
    expect(VISIT_GUARD.stopped).toBe(false);
  });
  it("上限只擋記錄，不影響網站回應", async () => {
    VISIT_GUARD.sample = 1;
    const { resp } = await run("/news", { headers: HTML, rate: { deny: true } });
    expect(await resp.text()).toBe("ok");
  });
});

// 隔壁的 ua/lang/referer 都截了長度，只有 path 沒有 —— 而 Cloudflare 接受約 16 KB 的 URL，
// 等於任何人都能往 visits 塞 16 KB 一列。截到 500 跟 referer 同一個數量級。
describe("visits 欄位長度上限", () => {
  it("path 超長截斷到 500 字（含 query string）", async () => {
    const long = "/news?q=" + "a".repeat(20000);
    const { logged, binds } = await run(long, { headers: HTML });
    expect(logged).toBe(true);
    expect(String(binds[COL.path]).length).toBe(500);
    expect(String(binds[COL.path]).startsWith("/news?q=aaa")).toBe(true);
  });
  it("一般長度的 path 原樣寫入（含 query string）", async () => {
    const { binds } = await run("/news?q=1", { headers: HTML });
    expect(binds[COL.path]).toBe("/news?q=1");
  });
  it("ua / lang / referer 維持既有上限（700 / 200 / 500）", async () => {
    const { binds } = await run("/news", {
      headers: {
        accept: "text/html",
        "user-agent": "u".repeat(2000),
        "accept-language": "l".repeat(2000),
        referer: "https://example.com/" + "r".repeat(2000)
      }
    });
    expect(String(binds[COL.ua]).length).toBe(700);
    expect(String(binds[COL.lang]).length).toBe(200);
    expect(String(binds[COL.referer]).length).toBe(500);
  });
});

describe("中介層永不影響網站本體", () => {
  it("一律 return next() 的回應", async () => {
    const { resp } = await run("/news", { headers: HTML });
    expect(await resp.text()).toBe("ok");
  });
  it("沒有 env.DB 也不炸、照樣放行", async () => {
    const waits: Promise<unknown>[] = [];
    const ctx: any = {
      request: new Request(ORIGIN + "/news", { headers: HTML }),
      env: {},
      waitUntil: (p: Promise<unknown>) => waits.push(Promise.resolve(p)),
      next: async () => new Response("ok")
    };
    const r = await onRequest(ctx);
    expect(await r.text()).toBe("ok");
  });
});
