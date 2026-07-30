// src/index.ts — Workers 進入點（v2.0.0 Phase D）。
// export default { fetch }：所有請求進 router.handle；靜態資產與 SPA fallback 由
// wrangler.toml 的 [assets]（binding=ASSETS, not_found_handling=single-page-application）
// 提供，router 找不到路由時 fetch 它。功能邏輯全在 src/routes/ 的 handler，此處只轉交。
import { handle } from "./router.js";
import { runCron } from "./cron.js";
import type { Env } from "./types.js";

// Durable Object 類別必須從進入點匯出，wrangler 的 DO binding 才找得到
// （Phase H 限流器；v2.5_DO 的 Playground 串流引擎 —— 見 docs/adr/0015）
export { RateLimiter } from "./do/rate-limiter.js";
export { PgStream } from "./do/pg-stream.js";

export default {
  fetch(request: Request, env: Env, exec: ExecutionContext): Promise<Response> {
    return handle(request, env, exec);
  },
  // cron 觸發（v2.0.0 Phase I）：備份/聚合/清理/告警，全在 src/cron.ts
  scheduled(controller: ScheduledController, env: Env, exec: ExecutionContext): void {
    exec.waitUntil(runCron(controller.cron, env));
  }
};
