// vitest.bench.config.mjs — 只跑 test/**/*.bench.ts（workerd 裡的量測工具）。
//
// 為什麼要獨立一份設定，而不是塞進 vitest.config.mjs：
// bench 動輒跑幾萬次迴圈，混進 npm test／CI 只會讓每次推送都變慢，而它量的東西
// （CPU 成本）本來就跟環境負載有關，在 CI 上跑出來的數字也不能拿來下判斷。
// 所以刻意分家：vitest.config.mjs 收 *.test.ts（回歸測試），這份收 *.bench.ts（量測）。
//
// 綁定設定跟正式測試一致（同一顆 workerd、同樣的 compatibilityDate），
// 這樣量到的數字才跟 npm test 與正式環境是同一個 runtime。
// D1 不用套 migrations —— bench 只量 CPU，不碰資料庫。
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    include: ["test/**/*.bench.ts"],
    // bench 會跑好幾萬次迴圈，預設 5 秒逾時不夠
    testTimeout: 300000,
    poolOptions: {
      workers: {
        singleWorker: true,
        main: "./src/index.ts",
        miniflare: {
          compatibilityDate: "2026-07-01",
          d1Databases: ["DB"],
          r2Buckets: ["BACKUPS", "FILES_TEST"],
          durableObjects: {
            RATE_LIMITER: { className: "RateLimiter", useSQLite: true }
          },
          bindings: {
            SITE_ORIGIN: "https://uaip.cc.cd",
            ADMIN_EMAILS: "admin@example.com"
          }
        }
      }
    }
  }
});
