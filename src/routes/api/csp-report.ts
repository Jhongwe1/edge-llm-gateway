// POST /api/csp-report — CSP 違規回報收集端（瀏覽器自動 POST，無認證）。
// 進 errlog（src:'csp'），在 /logs 錯誤分頁看得到 — CSP 政策壞了第一時間知道。
//
// 這是全站**兩個**匿名 D1 寫入口之一，防線比其他端點厚（2026-07-22 稽核後補上限流）：
//
// ⚠ 這行原本寫「全站唯一的匿名 D1 寫入口」——**那是錯的**（2026-08 稽核 F1 / DEBT #35）。
// 另一個是 `routes/_middleware.ts` 的 visitLog，由 router 在**路由分派之前**呼叫，
// 帶 `Accept: text/html` 就寫一列，**沒有取樣也沒有限流** —— 也就是說真正該擔心的那個，
// 反而是防線比較薄的那個。留著這段更正而不是直接改掉一個字：這裡的四道防線是照
// 「唯一入口」的假設設計的，下一個人需要知道那個假設不成立。
//   1. 10% 取樣          — 正常瀏覽器的重複回報不必每筆都存
//   2. 每 IP 限流（DO）   — 取樣後才檢查，正常流量幾乎不會付這個成本
//   3. 長度截斷          — 進 errlog 前先砍到 2000／500 字
//   4. 永遠回 204        — 不給探測者任何回饋
//
// 為什麼限流是必要的而不是「以防萬一」：這張 errlog 表同時是 cron.ts 的 tgAlertScan
// 每 5 分鐘撈去推 Telegram 的來源，而 cron.ts 把 msg 直接內插進訊息本體。沒有限流的話，
// 持續 POST ＝ D1 寫入放大 ＋ **攻擊者可控的文字直接送進管理員的 Telegram**。
//
// 失敗方向刻意與會員路徑相反（同 ADR-0009 對 demo 的處理）：限流器壞掉就不寫。
// 匿名寫入口在「擋不住的時候」該關起來，而 CSP 回報只是診斷資料，掉了不影響任何服務。
import { reportErrorNow } from "../../lib/observe.js";
import type { Env, RouteCtx } from "../../types.js";

// 取樣**之後**的配額（實際違規量約為這裡的 10 倍才會開始被丟）。
// 一個政策壞掉的頁面每次載入頂多噴幾筆，5/分鐘 ≈ 50 筆實際違規／分鐘，遠超真實需求。
const CSP_RATE = { perMin: 5, perDay: 50 };

async function rateOk(env: Env, request: Request): Promise<boolean> {
  try {
    if (!env.RATE_LIMITER) return false; // 沒綁定＝擋不住＝不寫（見檔頭的失敗方向）
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName("csp-ip:" + ip));
    const r = await stub.check({ svc: "csp", perMin: CSP_RATE.perMin, perDay: CSP_RATE.perDay });
    return r.ok;
  } catch (e) {
    return false;
  }
}

export async function onRequestPost({ request, env }: RouteCtx): Promise<Response> {
  try {
    // 取樣先做：90% 的請求在這裡就結束，連 DO 都不必叫（DO 呼叫本身也是成本）。
    if (Math.random() < 0.1 && (await rateOk(env, request))) {
      const raw = String(await request.text()).slice(0, 2000);
      let brief = raw;
      try {
        const j = JSON.parse(raw);
        const r = j["csp-report"] || j;
        brief =
          (r["violated-directive"] || r.violatedDirective || "?") +
          " @ " +
          (r["document-uri"] || r.documentURI || "?") +
          " ← " +
          (r["blocked-uri"] || r.blockedURI || "?");
      } catch (e) {}
      await reportErrorNow(env, "csp", brief.slice(0, 500), { detail: raw });
    }
  } catch (e) {}
  return new Response(null, { status: 204 });
}
