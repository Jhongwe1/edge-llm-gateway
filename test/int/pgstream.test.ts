// v2.5 串流直通（ADR-0014）：什麼時候直通、什麼時候退回轉譯，以及回覆怎麼落地。
//
// 這支測的是**行為**，不是效能 —— 直通到底省不省 CPU 只有正式環境的 wrangler tail
// 量得到（本機 workerd 比線上低估 95 倍，見 test/bench/stream.bench.ts 檔頭）。
// 2026-07-31 線上實測：轉譯 626ms → 直通 6ms，數字記在 lib/pgstream.ts。
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { env, fetchMock } from "cloudflare:test";
import { onRequestPost } from "../../src/routes/api/playground/chat.js";
import { onRequestPost as saveChat } from "../../src/routes/api/playground/chat/save.js";
import { createSession } from "../../src/lib/auth.js";
import {
  makeCtx,
  drainWaits,
  seedAdmin,
  seedUser,
  seedChannel,
  readAll,
  sseEvents,
  ORIGIN
} from "../helpers.js";
import type { UserRow } from "../../src/types.js";

const UP = "https://api.example.com";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

// 真實上游的形狀（2026-07-31 抓線上流量抄回來的，含 vLLM 系會塞的 prompt_token_ids）
const frame = (delta: Record<string, unknown>) =>
  'data: {"id":"chatcmpl-x","object":"chat.completion.chunk","created":1,"model":"gpt-t",' +
  '"choices":[{"index":0,"delta":' +
  JSON.stringify(delta) +
  ',"finish_reason":null}],"prompt_token_ids":null}';

const upstreamSSE = (parts: string[], extraTop?: string) =>
  parts
    .map((c) =>
      extraTop
        ? frame({ content: c }).replace("}]," + '"prompt', "}]," + extraTop + ',"prompt')
        : frame({ content: c })
    )
    .join("\n\n") +
  '\n\ndata: {"id":"chatcmpl-x","object":"chat.completion.chunk","created":1,"model":"gpt-t",' +
  '"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":22}}\n\ndata: [DONE]\n\n';

async function chatCtx(user: UserRow, body: unknown, qs?: string) {
  const sess = await createSession(env, user, new URL(ORIGIN + "/"));
  return makeCtx({
    url: ORIGIN + "/api/playground/chat" + (qs || ""),
    init: {
      method: "POST",
      headers: { cookie: "ipua_sess=" + sess.sid, origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify(body)
    }
  });
}

function mockUpstream(sse: string) {
  fetchMock
    .get(UP)
    .intercept({ path: "/v1/chat/completions", method: "POST" })
    .reply(200, sse, { headers: { "content-type": "text/event-stream" } });
}

async function setting(k: string, v: string) {
  await env.DB.prepare("INSERT INTO settings (k,v) VALUES (?1,?2) ON CONFLICT(k) DO UPDATE SET v=excluded.v")
    .bind(k, v)
    .run();
}

describe("v2.5 串流直通", () => {
  it("形狀乾淨的 openai 渠道 → 直通：原始 chunk 原樣送達、conv 走標頭、req_log 先落一列", async () => {
    const user = await seedUser({ status: "approved", services: "playground" });
    const ch = await seedChannel({ kind: "openai", base_url: UP, models: "gpt-t" });
    mockUpstream(upstreamSSE(["你好", "，世界 😀"]));

    const ctx = await chatCtx(user, {
      channel: ch.slug,
      model: "gpt-t",
      messages: [{ role: "user", content: "嗨" }]
    });
    const resp = await onRequestPost(ctx);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("x-pg-mode")).toBe("passthrough");
    const conv = Number(resp.headers.get("x-pg-conv"));
    const logId = Number(resp.headers.get("x-pg-log"));
    expect(conv).toBeGreaterThan(0);
    expect(logId).toBeGreaterThan(0);

    const text = await readAll(resp);
    await drainWaits(ctx);

    // 第一筆是我們的前綴事件，之後全是上游原文（含 [DONE]）
    expect(text.indexOf('data: {"conv":' + conv)).toBe(0);
    expect(text).toContain('"mode":"passthrough"');
    expect(text).toContain('"你好"');
    expect(text).toContain("，世界 😀"); // 多位元組字元不能在重播時壞掉
    expect(text).toContain("[DONE]");
    // 上游的標頭一個都不轉過來
    expect(resp.headers.get("content-type")).toContain("text/event-stream");

    // req_log：先寫一列佔位，token 留 NULL 等前端回報
    const log = await env.DB.prepare("SELECT * FROM req_log WHERE id=?1").bind(logId).first<any>();
    expect(log.user_id).toBe(user.id);
    expect(log.svc).toBe("pg");
    expect(log.tokens_out).toBe(null);
    // 直通模式伺服器不存 assistant —— 這時 D1 裡只該有 user 那一則
    const msgs = await env.DB.prepare("SELECT role FROM pg_messages WHERE conv_id=?1 ORDER BY id")
      .bind(conv)
      .all();
    expect(msgs.results.map((m: any) => m.role)).toEqual(["user"]);
  });

  it("chunk 帶未知頂層欄位（provider）→ 退回轉譯，會員看不到上游身分", async () => {
    const user = await seedUser({ status: "approved", services: "playground" });
    const ch = await seedChannel({ kind: "openai", base_url: UP, models: "gpt-t" });
    // OpenRouter 那種每筆都寫著上游是誰的形狀
    mockUpstream(
      'data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"gpt-t","provider":"DeepInfra",' +
        '"choices":[{"delta":{"content":"祕密"}}]}\n\ndata: [DONE]\n\n'
    );

    const ctx = await chatCtx(user, {
      channel: ch.slug,
      model: "gpt-t",
      messages: [{ role: "user", content: "嗨" }]
    });
    const resp = await onRequestPost(ctx);
    expect(resp.headers.get("x-pg-mode")).toBe(null);
    const text = await readAll(resp);
    await drainWaits(ctx);
    expect(text).toContain('{"d":"祕密"}');
    expect(text).not.toContain("DeepInfra"); // 上游身分不准流出去
    expect(text).not.toContain("[DONE]");
  });

  it("上游第一筆就夾 error → 退回轉譯，錯誤訊息被淨化", async () => {
    const user = await seedUser({ status: "approved", services: "playground" });
    const ch = await seedChannel({ kind: "openai", base_url: UP, models: "gpt-t" });
    mockUpstream('data: {"error":{"message":"quota exhausted at acme-ai.example"}}\n\ndata: [DONE]\n\n');

    const ctx = await chatCtx(user, {
      channel: ch.slug,
      model: "gpt-t",
      messages: [{ role: "user", content: "嗨" }]
    });
    const resp = await onRequestPost(ctx);
    expect(resp.headers.get("x-pg-mode")).toBe(null);
    const text = await readAll(resp);
    await drainWaits(ctx);
    expect(text).not.toContain("acme-ai.example");
    expect(text).toContain("上游發生錯誤");
  });

  it("嗅探退回轉譯時，被 chunk 邊界切開的多位元組字元不會壞掉", async () => {
    const user = await seedUser({ status: "approved", services: "playground" });
    const ch = await seedChannel({ kind: "openai", base_url: UP, models: "gpt-t" });
    // 第一筆帶 provider 逼它退回轉譯；後面的中文要逐字還原（同一顆 TextDecoder 的回歸）
    const body =
      'data: {"id":"x","provider":"acme","choices":[{"delta":{"content":"開頭"}}]}\n\n' +
      frame({ content: "中文字串測試" }) +
      "\n\n" +
      frame({ content: "🙂 結束" }) +
      "\n\ndata: [DONE]\n\n";
    mockUpstream(body);

    const ctx = await chatCtx(user, {
      channel: ch.slug,
      model: "gpt-t",
      messages: [{ role: "user", content: "嗨" }]
    });
    const resp = await onRequestPost(ctx);
    const events = sseEvents(await readAll(resp));
    await drainWaits(ctx);
    const got = events
      .filter((e: any) => e.d)
      .map((e: any) => e.d)
      .join("");
    expect(got).toBe("開頭中文字串測試🙂 結束");
    const msgs = await env.DB.prepare("SELECT content FROM pg_messages WHERE conv_id=?1 AND role='assistant'")
      .bind(events[0].conv)
      .all();
    expect(msgs.results[0].content).toBe("開頭中文字串測試🙂 結束");
  });

  it("dumb mode 生效 → 不直通（原始 chunk 會洩漏被藏起來的模型名稱）", async () => {
    const user = await seedUser({ status: "approved", services: "playground" });
    const ch = await seedChannel({ kind: "openai", base_url: UP, models: "secret-model" });
    await setting("dumb_mode", "1");
    await setting("dumb_channel", ch.slug);
    await setting("dumb_model", "secret-model");
    mockUpstream(upstreamSSE(["回覆"]));

    const ctx = await chatCtx(user, { channel: "", model: "", messages: [{ role: "user", content: "嗨" }] });
    const resp = await onRequestPost(ctx);
    expect(resp.headers.get("x-pg-mode")).toBe(null);
    const text = await readAll(resp);
    await drainWaits(ctx);
    expect(text).toContain('{"d":"回覆"}');
    expect(text).not.toContain("secret-model");
  });

  it("站台開關 pg_passthrough=0 → 全部退回轉譯", async () => {
    const user = await seedUser({ status: "approved", services: "playground" });
    const ch = await seedChannel({ kind: "openai", base_url: UP, models: "gpt-t" });
    await setting("pg_passthrough", "0");
    mockUpstream(upstreamSSE(["關掉了"]));

    const ctx = await chatCtx(user, {
      channel: ch.slug,
      model: "gpt-t",
      messages: [{ role: "user", content: "嗨" }]
    });
    const resp = await onRequestPost(ctx);
    expect(resp.headers.get("x-pg-mode")).toBe(null);
    const text = await readAll(resp);
    await drainWaits(ctx);
    expect(text).toContain('{"d":"關掉了"}');
  });

  it("管理員 ?stream=transform 強制轉譯；會員帶同一個參數無效", async () => {
    const admin = await seedAdmin({ services: "playground" });
    const ch = await seedChannel({ kind: "openai", base_url: UP, models: "gpt-t" });
    mockUpstream(upstreamSSE(["強制"]));
    const ctx = await chatCtx(
      admin,
      { channel: ch.slug, model: "gpt-t", messages: [{ role: "user", content: "嗨" }] },
      "?stream=transform"
    );
    const resp = await onRequestPost(ctx);
    expect(resp.headers.get("x-pg-mode")).toBe(null);
    expect(await readAll(resp)).toContain('{"d":"強制"}');
    await drainWaits(ctx);

    // 會員帶 ?stream=transform：參數被忽略，照樣直通
    const user = await seedUser({ status: "approved", services: "playground" });
    mockUpstream(upstreamSSE(["照舊"]));
    const ctx2 = await chatCtx(
      user,
      { channel: ch.slug, model: "gpt-t", messages: [{ role: "user", content: "嗨" }] },
      "?stream=transform"
    );
    const resp2 = await onRequestPost(ctx2);
    expect(resp2.headers.get("x-pg-mode")).toBe("passthrough");
    await readAll(resp2);
    await drainWaits(ctx2);
  });

  it("gemini 渠道不直通（形狀不是 OpenAI 相容）", async () => {
    const user = await seedUser({ status: "approved", services: "playground" });
    const ch = await seedChannel({ kind: "gemini", base_url: UP, models: "gem-t" });
    fetchMock
      .get(UP)
      .intercept({ path: /streamGenerateContent/, method: "POST" })
      .reply(200, 'data: {"candidates":[{"content":{"parts":[{"text":"哈囉"}]}}]}\n\n', {
        headers: { "content-type": "text/event-stream" }
      });
    const ctx = await chatCtx(user, {
      channel: ch.slug,
      model: "gem-t",
      messages: [{ role: "user", content: "嗨" }]
    });
    const resp = await onRequestPost(ctx);
    expect(resp.headers.get("x-pg-mode")).toBe(null);
    expect(await readAll(resp)).toContain('{"d":"哈囉"}');
    await drainWaits(ctx);
  });
});

describe("v2.5 直通的回覆落地（/api/playground/chat/save）", () => {
  async function saveCtx(user: UserRow, body: unknown) {
    const sess = await createSession(env, user, new URL(ORIGIN + "/"));
    return makeCtx({
      url: ORIGIN + "/api/playground/chat/save",
      init: {
        method: "POST",
        headers: { cookie: "ipua_sess=" + sess.sid, origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify(body)
      }
    });
  }

  // 跑一趟直通，回傳 { user, conv, log }
  async function streamOnce() {
    const user = await seedUser({ status: "approved", services: "playground" });
    const ch = await seedChannel({ kind: "openai", base_url: UP, models: "gpt-t" });
    mockUpstream(upstreamSSE(["嗨"]));
    const ctx = await chatCtx(user, {
      channel: ch.slug,
      model: "gpt-t",
      messages: [{ role: "user", content: "問題" }]
    });
    const resp = await onRequestPost(ctx);
    const conv = Number(resp.headers.get("x-pg-conv"));
    const log = Number(resp.headers.get("x-pg-log"));
    await readAll(resp);
    await drainWaits(ctx);
    return { user, conv, log };
  }

  it("串完回報 → assistant 落地、conversation 更新、req_log 補上 token", async () => {
    const { user, conv, log } = await streamOnce();
    const ctx = await saveCtx(user, {
      conv_id: conv,
      log_id: log,
      content: "完整回覆",
      tokens_in: 11,
      tokens_out: 22,
      dur_ms: 1234
    });
    const r = await saveChat(ctx);
    await drainWaits(ctx);
    expect(r.status).toBe(200);
    expect((await r.json()) as any).toMatchObject({ ok: true, saved: "insert" });

    const msgs = await env.DB.prepare("SELECT role,content FROM pg_messages WHERE conv_id=?1 ORDER BY id")
      .bind(conv)
      .all();
    expect(msgs.results.map((m: any) => m.role)).toEqual(["user", "assistant"]);
    expect(msgs.results[1].content).toBe("完整回覆");
    const lg = await env.DB.prepare("SELECT * FROM req_log WHERE id=?1").bind(log).first<any>();
    expect(lg.tokens_in).toBe(11);
    expect(lg.tokens_out).toBe(22);
    expect(lg.dur_ms).toBe(1234);
  });

  it("重送（sendBeacon 遲到）不會變成兩則回覆，也不會用半截蓋掉完整內容", async () => {
    const { user, conv, log } = await streamOnce();
    await drainWaits(
      await saveCtx(user, { conv_id: conv, log_id: log, content: "完整的一大段回覆" }).then(async (c) => {
        await saveChat(c);
        return c;
      })
    );
    // 遲到的半截
    const late = await saveCtx(user, { conv_id: conv, log_id: log, content: "完整的", status: "aborted" });
    const r2 = await saveChat(late);
    await drainWaits(late);
    expect(((await r2.json()) as any).saved).toBe("skip");

    const msgs = await env.DB.prepare("SELECT content FROM pg_messages WHERE conv_id=?1 AND role='assistant'")
      .bind(conv)
      .all();
    expect(msgs.results.length).toBe(1);
    expect(msgs.results[0].content).toBe("完整的一大段回覆");
  });

  it("續寫（先半截、後完整）會改寫同一列", async () => {
    const { user, conv, log } = await streamOnce();
    const a = await saveCtx(user, { conv_id: conv, log_id: log, content: "半截" });
    await saveChat(a);
    await drainWaits(a);
    const b = await saveCtx(user, { conv_id: conv, log_id: log, content: "半截＋後面補齊" });
    const r = await saveChat(b);
    await drainWaits(b);
    expect(((await r.json()) as any).saved).toBe("update");
    const msgs = await env.DB.prepare("SELECT content FROM pg_messages WHERE conv_id=?1 AND role='assistant'")
      .bind(conv)
      .all();
    expect(msgs.results.length).toBe(1);
    expect(msgs.results[0].content).toBe("半截＋後面補齊");
  });

  it("token 只補得了一次（重送不會再改數字）", async () => {
    const { user, conv, log } = await streamOnce();
    const a = await saveCtx(user, { conv_id: conv, log_id: log, content: "甲", tokens_out: 5 });
    await saveChat(a);
    await drainWaits(a);
    const b = await saveCtx(user, { conv_id: conv, log_id: log, content: "甲乙丙", tokens_out: 999 });
    await saveChat(b);
    await drainWaits(b);
    const lg = await env.DB.prepare("SELECT tokens_out FROM req_log WHERE id=?1").bind(log).first<any>();
    expect(lg.tokens_out).toBe(5);
  });

  it("別人的對話存不進去（404），未登入 401", async () => {
    const { conv, log } = await streamOnce();
    const other = await seedUser({ status: "approved", services: "playground" });
    const ctx = await saveCtx(other, { conv_id: conv, log_id: log, content: "偷寫" });
    const r = await saveChat(ctx);
    await drainWaits(ctx);
    expect(r.status).toBe(404);

    const anon = makeCtx({
      url: ORIGIN + "/api/playground/chat/save",
      init: { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }
    });
    expect((await saveChat(anon)).status).toBe(401);
  });

  it("別人的 req_log 改不動（log_id 猜對也一樣）", async () => {
    const first = await streamOnce();
    const second = await streamOnce();
    const ctx = await saveCtx(second.user, {
      conv_id: second.conv,
      log_id: first.log, // 別人的計量列
      content: "乙",
      tokens_out: 777
    });
    await saveChat(ctx);
    await drainWaits(ctx);
    const lg = await env.DB.prepare("SELECT tokens_out FROM req_log WHERE id=?1")
      .bind(first.log)
      .first<any>();
    expect(lg.tokens_out).toBe(null);
  });
});
