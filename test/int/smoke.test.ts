// 冒煙測試 — 驗證整條測試工具鏈成立：
//   1. bracket 檔名（functions/relay/[[path]].js）可以直接 import（整個測試策略的前提）
//   2. migrations 已套用（D1 有表）、helpers 的 makeCtx 能驅動 handler
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { onRequest } from "../../src/routes/relay/[[path]].js";
import { onRequestGet as health, classifyDbError } from "../../src/routes/api/health.js";
import { makeCtx, ORIGIN } from "../helpers.js";

describe("工具鏈冒煙", () => {
  it("bracket 檔名 handler 可直接 import 且能執行（無金鑰 → 401）", async () => {
    const ctx = makeCtx({
      url: ORIGIN + "/relay/openai/v1/models",
      params: { path: ["openai", "v1", "models"] }
    });
    const resp = await onRequest(ctx);
    expect(resp.status).toBe(401);
    const j: any = await resp.json();
    expect(j.error).toBe("no-key");
  });

  it("migrations 已套用：核心表都在", async () => {
    const r = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
    const names = (r.results || []).map((x: any) => x.name);
    for (const t of [
      "visits",
      "articles",
      "users",
      "sessions",
      "relay_channels",
      "vpn_channels",
      "pg_conversations",
      "settings"
    ]) {
      expect(names).toContain(t);
    }
  });
});

// /api/health 是 D1 額度爆掉時**全站唯一還講得出話的地方**（errlog 是 D1 的表、
// Telegram 告警要從 D1 讀它 —— 兩條路都斷了）。所以它必須能分辨「D1 掛了」與
// 「額度用完了」：處置完全不同（前者看狀態頁，後者等 UTC 午夜或升方案）。
describe("/api/health 的 D1 狀態分類", () => {
  it("D1 正常 → db:true、沒有 db_error", async () => {
    const resp = await health(makeCtx({ url: ORIGIN + "/api/health" }));
    const j: any = await resp.json();
    expect(j.ok).toBe(true);
    expect(j.db).toBe(true);
    expect(j.db_error).toBeUndefined();
  });

  it("沒綁 DB → db:false、db_error:'unbound'", async () => {
    const ctx = makeCtx({ url: ORIGIN + "/api/health" });
    const resp = await health({ ...ctx, env: {} as any });
    const j: any = await resp.json();
    expect(j.db).toBe(false);
    expect(j.db_error).toBe("unbound");
  });

  it("D1 丟額度錯誤 → db_error:'quota'；其他錯誤 → 'error'", async () => {
    const boom = (msg: string) =>
      ({
        DB: {
          prepare: () => ({
            first: async () => {
              throw new Error(msg);
            }
          })
        }
      }) as any;
    const ask = async (msg: string) => {
      const ctx = makeCtx({ url: ORIGIN + "/api/health" });
      const j: any = await (await health({ ...ctx, env: boom(msg) })).json();
      return j.db_error;
    };
    expect(await ask("Exceeded your daily limits for D1")).toBe("quota");
    expect(await ask("D1 daily limit exceeded")).toBe("quota");
    expect(await ask("storage quota reached")).toBe("quota");
    expect(await ask("network connection reset")).toBe("error");
  });

  it("分類函式永不外洩原始訊息（只回分類字）", () => {
    expect(classifyDbError(new Error("secret-internal-detail"))).toBe("error");
    expect(classifyDbError(null)).toBe("error");
    expect(classifyDbError(undefined)).toBe("error");
  });
});
