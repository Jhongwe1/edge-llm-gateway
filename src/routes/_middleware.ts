// src/routes/_middleware.ts — 全站中介層：把每一次「頁面瀏覽」寫進 D1（visits 資料表）。
// 寫入走 waitUntil（背景執行、不拖慢回應），且全程 try/catch — 記錄失敗絕不影響網站。
//
// ## ⚠ 這是全站兩個「匿名 D1 寫入口」之一，而且是流量大的那個
//
// 另一個是 /api/csp-report（那支有取樣＋限流）。這支跑在 router 分派**之前**、每個請求都會經過，
// 所以它的成本控制不是可有可無的（2026-08 稽核 F1／DEBT #35 —— 修在 v2.6.1）。
//
// 為什麼會是問題：Cloudflare 免費額度是 **Workers 每日 10 萬請求**與 **D1 每日 10 萬列寫入**，
// **兩個數字一樣大**。瀏覽紀錄一個請求寫一列，等於全站最沒價值的那筆寫入，跟 session、
// 對話落地、req_log（一輪聊天約 4 列）搶同一個預算，而且優先權還在前面。
// 額度一旦用完，D1 **連查詢都會失敗**（不只寫入），而那時站台**講不出話** ——
// errlog 是 D1 的表、Telegram 告警要從 D1 讀它。症狀會是「網頁打得開，但登入失敗、
// 聊天存不進去，而且沒有任何通知」。
//
// 兩層防護，兩層都不加 I/O 到使用者的關鍵路徑上：
//   L1 白名單（下面的 PAGE_PATHS／PAGE_RE）—— 只記「真的存在的頁面」。零成本，
//      而且擋掉的正是最現實的那種流量：掃描器打 /wp-admin /.env /phpmyadmin，
//      每個路徑都不一樣（順便讓邊緣快取失效），以前每一發都寫一列。
//   L2 每日上限（VISIT_GUARD）—— 全站計數走既有的 RateLimiter DO。
//      **上限跳掉時寫一筆 errlog**，五分鐘後既有的 tgAlertScan 就會推到 Telegram ——
//      這一點是整個修法的重點：**在 D1 真的爆掉之前先叫**，因為爆掉之後告警管道自己也死了。
import { reportErrorNow } from "../lib/observe.js";
import type { Env, RouteCtx } from "../types.js";

// L1 白名單：站上「真的有這一頁」的固定路徑（尾斜線已正規化、全小寫）。
// 刻意**不含** /logs 與 /admin（管理頁不是訪客瀏覽），也不含 /feed 與 /sitemap（那是機器讀的）。
// 新增 SSR 頁面時記得補進來 —— 漏了只會少記錄，不會壞掉。
const PAGE_PATHS: Record<string, number> = {
  "/": 1,
  "/ip": 1,
  "/ua": 1,
  "/index.html": 1,
  "/news": 1,
  "/articles": 1,
  "/playground": 1,
  "/relay": 1,
  "/vpn": 1,
  "/members": 1,
  "/settings": 1,
  "/api-docs": 1
};
// 動態頁面：文章頁（/news/12、/articles/34）與自訂頁面（/p/about）
const PAGE_RE = [/^\/(?:news|articles)\/\d{1,12}$/, /^\/p\/[a-z0-9-]{1,64}$/];

function shouldLog(request: Request, url: URL): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const p = url.pathname.toLowerCase().replace(/\/+$/, "") || "/";
  // 瀏覽器「預先抓取」不是真的瀏覽，跳過
  const purpose = (request.headers.get("sec-purpose") || request.headers.get("purpose") || "").toLowerCase();
  if (purpose.indexOf("prefetch") >= 0 || purpose.indexOf("preview") >= 0) return false;
  // ── L1：白名單，不是名單上的一律不記 ──
  // 這裡以前是「帶了 Accept: text/html 就記」，那等於**任何路徑都記，連不存在的都記**
  // （打不存在的路徑會落到 SPA fallback、回 200，看起來像正常瀏覽）。
  // 改成白名單之後，Accept 不再是「觸發條件」——固定頁面就算沒帶 Accept（機器人）照樣記，
  // 那個行為是刻意保留的。
  if (PAGE_PATHS[p] === 1) return true;
  for (let i = 0; i < PAGE_RE.length; i++) if (PAGE_RE[i].test(p)) return true;
  return false;
}

/**
 * L2：訪客紀錄的每日寫入上限。
 *
 * 用可變物件而不是 const —— 測試要能把數字改小去驗證這條路徑（同 lib/pgchat.ts 的 BG）。
 *
 * capPerDay 40000：D1 免費額度是每日 10 萬列寫入，**留 60% 給有使用者資料的寫入**
 *   （session、對話、req_log）。這個站平常約 123 次瀏覽／天，離 40000 有兩個數量級，
 *   所以正常情況下這道閘永遠不會作用 —— 它是護欄，不是配額。
 * sample 20：每 20 次記錄才真的去問一次 DO。正常流量下一天約 6 次 DO 呼叫，可以忽略；
 *   被灌的時候在 20 個請求內就會收斂，之後連 DO 都不再呼叫（stopped 快取住）。
 *   代價是上限是**近似值**（誤差約一個取樣區間），而護欄本來就不需要精確。
 */
export const VISIT_GUARD = {
  capPerDay: 40000,
  sample: 20,
  day: "", // 這個 isolate 目前算的是哪一天（UTC）
  stopped: false // 今天已經停止記錄了
};

/**
 * 還能不能記。**沒綁定 RATE_LIMITER 就只有 L1**（跟 quota_do 的降級語意一致：
 * 拿掉 DO 是一種有文件的部署模式，不是設定錯誤）。
 *
 * 反過來，DO **拒絕或丟例外**都一律停止記錄 —— 這裡刻意跟 lib/quota.ts 的 fail-open 相反，
 * 理由跟 /api/csp-report 同一條：被保護的是「正職服務的寫入預算」，
 * 那麼在擋不住的時候，最沒價值的那筆寫入就該讓路。
 *
 * 註：stopped 是**每個 isolate 各自**的快取，所以上限跳掉時每個 isolate 會各寫一筆 errlog。
 * 那是有界的（isolate 數量級），而且重複的告警比漏掉的告警好。
 */
async function capOk(env: Env): Promise<boolean> {
  const g = VISIT_GUARD;
  const today = new Date().toISOString().slice(0, 10);
  if (g.day !== today) {
    g.day = today; // 跨日自動重置（跟 RateLimiter 的日期入鍵同一套懶重置）
    g.stopped = false;
  }
  if (g.stopped) return false;
  if (!env.RATE_LIMITER) return true; // 沒有這道護欄的部署 —— L1 仍然生效
  if (Math.random() * g.sample >= 1) return true; // 這一筆沒被抽到 → 不必問
  let denied = true;
  try {
    const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName("visit:global"));
    const r = await stub.check({
      svc: "visit",
      perMin: 1e9, // 只管日上限（同 demo:global 的做法）
      perDay: Math.max(1, Math.ceil(g.capPerDay / g.sample)) // 一次抽樣代表 sample 次瀏覽
    });
    denied = !r.ok;
  } catch (e) {
    /* 護欄本身壞了 → 當成擋不住，停止記錄 */
  }
  if (!denied) return true;
  g.stopped = true;
  // ⚠ 這一筆 errlog 是整個修法的重點：它會被五分鐘一次的 tgAlertScan 推到 Telegram，
  // 而此刻 D1 **還活著**（我們只用掉自訂上限、離平台上限還有 60% 餘裕）。
  // 等到平台額度真的爆掉才想通知就來不及了 —— 那時 errlog 也寫不進去。
  await reportErrorNow(
    env,
    "visits.cap",
    "訪客紀錄達到今日自訂上限（約 " + g.capPerDay + " 列），今天剩下的時間停止記錄以保留 D1 寫入額度",
    { path: "/_middleware", detail: "cap=" + g.capPerDay + " sample=" + g.sample + " day=" + today }
  );
  return false;
}

async function logVisit(request: Request, env: Env, url: URL): Promise<void> {
  if (!(await capOk(env))) return; // L2：先問護欄，再決定要不要花這一列
  const h = request.headers;
  // cf 欄位依方案／環境可有可無，逐欄防禦式取值

  const cf = (request.cf || {}) as any;
  await env.DB.prepare(
    `INSERT INTO visits (ts, host, path, method, ip, ua, country, city, region, colo, asn, isp, lang, referer, http, tls)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  )
    .bind(
      new Date().toISOString(),
      url.hostname,
      // 截 500 跟隔壁 referer 同級：Cloudflare 接受約 16 KB 的 URL，不截等於
      // 任何人都能單靠網址長度往 visits 塞爆一列（ua/lang/referer 本來就都截了）
      (url.pathname + (url.search || "")).slice(0, 500),
      request.method,
      h.get("cf-connecting-ip") || "",
      (h.get("user-agent") || "").slice(0, 700),
      cf.country || "",
      cf.city || "",
      cf.region || "",
      cf.colo || "",
      cf.asn || null,
      cf.asOrganization || "",
      (h.get("accept-language") || "").slice(0, 200),
      (h.get("referer") || "").slice(0, 500),
      cf.httpProtocol || "",
      cf.tlsVersion || ""
    )
    .run();
}

// 記一次頁面瀏覽（背景、永不影響網站本體）。Pages 時代的 _middleware 與 Workers 版 router
// 共用這一支（單一真相）：router 在分派 handler 前先呼叫它，行為與 Pages 一致。
export function visitLog(context: Pick<RouteCtx, "request" | "env" | "waitUntil">): void {
  const { request, env } = context;
  try {
    const url = new URL(request.url);
    if (env.DB && shouldLog(request, url)) {
      context.waitUntil(logVisit(request, env, url).catch(() => {}));
    }
  } catch (e) {
    /* 記錄永不影響網站本體 */
  }
}

export async function onRequest(context: RouteCtx): Promise<Response> {
  visitLog(context);
  return context.next();
}
