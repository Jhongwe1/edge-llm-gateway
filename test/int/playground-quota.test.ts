// playground 配額與計量（Phase C）：429 在任何 D1 寫入之前、三家 usage 解析進 req_log。
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { env, fetchMock } from "cloudflare:test";
import { onRequestPost } from "../../src/routes/api/playground/chat.js";
import { createSession } from "../../src/lib/auth.js";
import { logReq } from "../../src/lib/quota.js";
import { makeCtx, drainWaits, seedUser, seedChannel, readAll, ORIGIN } from "../helpers.js";
import type { UserRow } from "../../src/types.js";

const UP = "https://api.example.com";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

async function chatCtx(user: UserRow, body: unknown) {
  const sess = await createSession(env, user, new URL(ORIGIN + "/"));
  return makeCtx({
    url: ORIGIN + "/api/playground/chat",
    init: {
      method: "POST",
      headers: { cookie: "ipua_sess=" + sess.sid, origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify(body)
    }
  });
}

const lastLog = () =>
  env.DB.prepare("SELECT * FROM req_log WHERE svc='pg' ORDER BY id DESC LIMIT 1").first<any>();

describe("playground 配額", () => {
  it("日配額用完 → 429，且【不建對話、不存訊息】（檢查在任何寫入之前）", async () => {
    // 用 req_log 餵量＝D1 語意，釘在 D1 降級路徑（DO 路徑的擋人測試在 unit/rate-limiter.test.ts）
    await env.DB.prepare("INSERT INTO settings (k,v) VALUES ('quota_do','0')").run();
    const u = await seedUser({ status: "approved", services: "playground", quota_pg_day: 1, rl_per_min: 99 });
    await logReq(env, { user_id: u.id, svc: "pg", status: 200 });
    const ctx = await chatCtx(u, { channel: "any", model: "m", messages: [{ role: "user", content: "hi" }] });
    const r = await onRequestPost(ctx);
    expect(r.status).toBe(429);
    expect(((await r.json()) as any).error).toBe("quota-exceeded");
    const convs = await env.DB.prepare("SELECT COUNT(*) c FROM pg_conversations WHERE user_id=?1")
      .bind(u.id)
      .first<any>();
    expect(convs.c).toBe(0);
    const msgs = await env.DB.prepare("SELECT COUNT(*) c FROM pg_messages").first<any>();
    expect(msgs.c).toBe(0);
  });
});

describe("playground 計量（三家 usage 進 req_log）", () => {
  async function run(kind: string, slug: string, body: string, headers?: Record<string, string>) {
    const u = await seedUser({ status: "approved", services: "playground" });
    await seedChannel({ slug, kind, base_url: UP, models: "m" });
    const paths: Record<string, string | RegExp> = {
      anthropic: "/v1/messages",
      gemini: /^\/v1beta\/models\//,
      openai: "/v1/chat/completions",
      custom: "/v1/chat/completions"
    };
    fetchMock
      .get(UP)
      .intercept({ path: paths[kind], method: "POST" })
      .reply(200, body, { headers: headers || { "content-type": "text/event-stream" } });
    const ctx = await chatCtx(u, { channel: slug, model: "m", messages: [{ role: "user", content: "hi" }] });
    const resp = await onRequestPost(ctx);
    expect(resp.status).toBe(200);
    await readAll(resp);
    await drainWaits(ctx);
    return { u, log: await lastLog() };
  }

  it("openai：stream_options.include_usage 讓尾端帶 usage → req_log 有 tokens", async () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"a"}}]}\n\n' +
      'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":22}}\n\n' +
      "data: [DONE]\n\n";
    const { u, log } = await run("openai", "po", sse);
    expect(log.user_id).toBe(u.id);
    expect(log.channel).toBe("po");
    expect(log.model).toBe("m");
    expect(log.status).toBe(200);
    expect(log.tokens_in).toBe(11);
    expect(log.tokens_out).toBe(22);
    expect(log.dur_ms).toBeGreaterThanOrEqual(0);
  });

  it("anthropic：message_start input＋message_delta output", async () => {
    const sse =
      'data: {"type":"message_start","message":{"usage":{"input_tokens":33,"output_tokens":1}}}\n\n' +
      'data: {"type":"content_block_delta","delta":{"text":"喵"}}\n\n' +
      'data: {"type":"message_delta","usage":{"output_tokens":44}}\n\n';
    const { log } = await run("anthropic", "pa", sse);
    expect(log.tokens_in).toBe(33);
    expect(log.tokens_out).toBe(44);
  });

  it("gemini：usageMetadata", async () => {
    const sse =
      'data: {"candidates":[{"content":{"parts":[{"text":"嗨"}]}}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":6}}\n\n';
    const { log } = await run("gemini", "pg1", sse);
    expect(log.tokens_in).toBe(5);
    expect(log.tokens_out).toBe(6);
  });

  it("非串流整包 JSON（openai 相容）也記 usage", async () => {
    const body =
      '{"choices":[{"message":{"content":"整包"}}],"usage":{"prompt_tokens":1,"completion_tokens":2}}';
    const { log } = await run("custom", "pc", body, { "content-type": "application/json" });
    expect(log.tokens_in).toBe(1);
    expect(log.tokens_out).toBe(2);
  });
});
