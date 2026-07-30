// POST /api/playground/chat — SSE 快樂路徑、D1 持久化、錯誤淨化（會員看不到上游身分）。
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { env, fetchMock } from "cloudflare:test";
import { onRequestPost, BG } from "../../src/routes/api/playground/chat.js";
import { createSession } from "../../src/lib/auth.js";
import {
  makeCtx,
  drainWaits,
  seedUser,
  seedAdmin,
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

async function chatCtx(user: UserRow, body: unknown) {
  const sess = await createSession(env, user, new URL(ORIGIN + "/"));
  return makeCtx({
    url: ORIGIN + "/api/playground/chat",
    init: {
      method: "POST",
      headers: {
        cookie: "ipua_sess=" + sess.sid,
        origin: ORIGIN,
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    }
  });
}

const openaiSSE = (chunks: string[]) =>
  chunks.map((c: any) => 'data: {"choices":[{"delta":{"content":' + JSON.stringify(c) + "}}]}").join("\n\n") +
  "\n\ndata: [DONE]\n\n";

// 推理模型的串流：先一串 reasoning_content（思考），再一串 content（正文）
const reasoningSSE = (think: string[], answer: string[]) =>
  think
    .map((c) => 'data: {"choices":[{"delta":{"reasoning_content":' + JSON.stringify(c) + "}}]}")
    .concat(answer.map((c) => 'data: {"choices":[{"delta":{"content":' + JSON.stringify(c) + "}}]}"))
    .join("\n\n") + "\n\ndata: [DONE]\n\n";

describe("playground chat", () => {
  it("未登入 → 401；沒 playground 服務 → 403", async () => {
    const ctx = makeCtx({
      url: ORIGIN + "/api/playground/chat",
      init: { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }
    });
    expect((await onRequestPost(ctx)).status).toBe(401);

    const noSvc = await seedUser({ status: "approved", services: "relay" });
    const ctx2 = await chatCtx(noSvc, {
      channel: "c",
      model: "m",
      messages: [{ role: "user", content: "hi" }]
    });
    expect((await onRequestPost(ctx2)).status).toBe(403);
  });

  // 快速路徑（lib/fastsse.ts）用正則抽出「還沒反跳脫的原始字串」再交給 JSON.parse，
  // 跳脫字元是它最容易出錯的地方 — 這裡端到端驗一次：SSE 事件與 D1 都要逐字正確。
  it("跳脫字元端到端：換行／引號／反斜線／emoji 都要原樣送達並存進 D1", async () => {
    const user = await seedUser({ status: "approved", services: "playground" });
    await seedChannel({ slug: "pg", kind: "openai", base_url: UP, models: "gpt-t" });
    const parts = ['第一行\n第二行 "引號"', " 反斜線\\ 與 tab\t", "emoji😀 結束"];
    fetchMock
      .get(UP)
      .intercept({ path: "/v1/chat/completions", method: "POST" })
      .reply(200, openaiSSE(parts), { headers: { "content-type": "text/event-stream" } });

    const ctx = await chatCtx(user, {
      channel: "pg",
      model: "gpt-t",
      messages: [{ role: "user", content: "來點特殊字元" }]
    });
    const resp = await onRequestPost(ctx);
    const events = sseEvents(await readAll(resp));
    await drainWaits(ctx);

    const want = parts.join("");
    expect(
      events
        .filter((e: any) => e.d)
        .map((e: any) => e.d)
        .join("")
    ).toBe(want);
    const msgs = await env.DB.prepare("SELECT content FROM pg_messages WHERE conv_id=?1 AND role='assistant'")
      .bind(events[0].conv)
      .all();
    expect(msgs.results[0].content).toBe(want);
  });

  it("快樂路徑：SSE 串流→統一事件→存 D1（新對話＋user＋assistant）", async () => {
    const user = await seedUser({ status: "approved", services: "playground" });
    await seedChannel({ slug: "pg", kind: "openai", base_url: UP, models: "gpt-t" });
    fetchMock
      .get(UP)
      .intercept({ path: "/v1/chat/completions", method: "POST" })
      .reply(200, openaiSSE(["你", "好"]), { headers: { "content-type": "text/event-stream" } });

    const ctx = await chatCtx(user, {
      channel: "pg",
      model: "gpt-t",
      messages: [{ role: "user", content: "打招呼" }]
    });
    const resp = await onRequestPost(ctx);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toContain("text/event-stream");

    const events = sseEvents(await readAll(resp));
    await drainWaits(ctx);
    expect(events[0].conv).toBeGreaterThan(0);
    expect(events[0].title).toBe("打招呼");
    expect(
      events
        .filter((e: any) => e.d)
        .map((e: any) => e.d)
        .join("")
    ).toBe("你好");
    expect(events[events.length - 1].done).toBe(true);

    const convId = events[0].conv;
    const msgs = await env.DB.prepare("SELECT role,content FROM pg_messages WHERE conv_id=?1 ORDER BY id")
      .bind(convId)
      .all();
    expect(msgs.results.map((m: any) => m.role)).toEqual(["user", "assistant"]);
    expect(msgs.results[1].content).toBe("你好");
    const conv = await env.DB.prepare("SELECT * FROM pg_conversations WHERE id=?1").bind(convId).first<any>();
    expect(conv.user_id).toBe(user.id);
    expect(conv.model).toBe("gpt-t");
  });

  // 2026-07-21 的回歸：思考欄位以前被整段丟掉（畫面空白像當機），
  // 而每筆增量各送一次 SSE 會燒穿免費方案 10ms CPU（isolate 被殺、串流無聲中斷）。
  it("推理模型：思考走 {r}、正文走 {d}、思考不進 D1，且增量有批次合併", async () => {
    const user = await seedUser({ status: "approved", services: "playground" });
    await seedChannel({ slug: "pg", kind: "openai", base_url: UP, models: "glm-t" });
    fetchMock
      .get(UP)
      .intercept({ path: "/v1/chat/completions", method: "POST" })
      .reply(200, reasoningSSE(["先看", "整數位", "都是 9"], ["9.9", " 比較大"]), {
        headers: { "content-type": "text/event-stream" }
      });

    const ctx = await chatCtx(user, {
      channel: "pg",
      model: "glm-t",
      messages: [{ role: "user", content: "9.11 和 9.9 哪個大" }]
    });
    const resp = await onRequestPost(ctx);
    const events = sseEvents(await readAll(resp));
    await drainWaits(ctx);

    const rs = events.filter((e: any) => e.r).map((e: any) => e.r);
    const ds = events.filter((e: any) => e.d).map((e: any) => e.d);
    expect(rs.join("")).toBe("先看整數位都是 9");
    expect(ds.join("")).toBe("9.9 比較大");
    // 5 筆上游增量 → 合併後遠少於 5 筆事件（思考與正文各自成塊，順序不混）
    expect(rs.length + ds.length).toBeLessThan(5);
    expect(events.findIndex((e: any) => e.r)).toBeLessThan(events.findIndex((e: any) => e.d));
    expect(events[events.length - 1].done).toBe(true);

    // 存進 D1 的只有正式回覆 — 思考過程一個字都不落地
    const msgs = await env.DB.prepare("SELECT role,content FROM pg_messages WHERE conv_id=?1 ORDER BY id")
      .bind(events[0].conv)
      .all();
    expect(msgs.results[1].content).toBe("9.9 比較大");
  });

  it("只有思考、沒有正文 → 回 empty-output 錯誤，不會靜默送 done", async () => {
    const user = await seedUser({ status: "approved", services: "playground" });
    await seedChannel({ slug: "pg", kind: "openai", base_url: UP, models: "glm-t" });
    fetchMock
      .get(UP)
      .intercept({ path: "/v1/chat/completions", method: "POST" })
      .reply(200, reasoningSSE(["想了很久"], []), {
        headers: { "content-type": "text/event-stream" }
      });

    const ctx = await chatCtx(user, {
      channel: "pg",
      model: "glm-t",
      messages: [{ role: "user", content: "嗨" }]
    });
    const events = sseEvents(await readAll(await onRequestPost(ctx)));
    await drainWaits(ctx);

    const err = events.find((e: any) => e.error);
    expect(err.error).toBe("empty-output");
    expect(err.hint).toContain("思考"); // 會員看得到成因，不是一句「發生錯誤」
    expect(events[events.length - 1].done).toBe(true);
  });

  // ── 斷線後的背景續跑（2026-07-21）──
  // 舊行為：瀏覽器一斷線就掐斷上游。會員在模型「還在思考」時關掉網頁，正文一個字都還沒
  // 生成 → D1 連 assistant 那列都沒有 → 下次打開對話是空的。現在改成背景讀完再存。
  //
  // 這三個測試都靠「不讀回應主體就 cancel」來模擬關網頁：TransformStream 的 readable
  // 預設 highWaterMark 是 0，沒人讀就會卡住第一次寫入，所以 cancel() 必定在讀取上游的
  // 迴圈開始前就讓 send() 失敗 —— 時序是確定的，不是碰運氣。
  it("斷線後背景續跑：關網頁時還在思考，完整回覆仍然存進 D1", async () => {
    const user = await seedUser({ status: "approved", services: "playground" });
    await seedChannel({ slug: "pgbg", kind: "openai", base_url: UP, models: "glm-t" });
    fetchMock
      .get(UP)
      .intercept({ path: "/v1/chat/completions", method: "POST" })
      .reply(200, reasoningSSE(["先想一下"], ["完整", "的回覆"]), {
        headers: { "content-type": "text/event-stream" }
      });

    const ctx = await chatCtx(user, {
      channel: "pgbg",
      model: "glm-t",
      messages: [{ role: "user", content: "還在思考我就關掉網頁" }]
    });
    const resp = await onRequestPost(ctx);
    await resp.body!.cancel(); // ← 使用者關掉網頁
    await drainWaits(ctx);

    const conv = await env.DB.prepare("SELECT id FROM pg_conversations WHERE user_id=?1")
      .bind(user.id)
      .first<any>();
    const saved = await env.DB.prepare(
      "SELECT content FROM pg_messages WHERE conv_id=?1 AND role='assistant'"
    )
      .bind(conv.id)
      .all();
    // 舊行為只會存到斷線當下的「完整」；續跑之後連斷線後才生成的「的回覆」都在
    expect(saved.results.length).toBe(1);
    expect(saved.results[0].content).toBe("完整的回覆");
  });

  it("續跑期間的階段性存檔：同一列 UPDATE，不會變成好幾則回覆", async () => {
    const prev = BG.ckMs;
    BG.ckMs = 0; // 斷線後每筆增量都存一次（正常是 5 秒一次）
    try {
      const user = await seedUser({ status: "approved", services: "playground" });
      await seedChannel({ slug: "pgck", kind: "openai", base_url: UP, models: "glm-t" });
      fetchMock
        .get(UP)
        .intercept({ path: "/v1/chat/completions", method: "POST" })
        .reply(200, reasoningSSE(["思考中"], ["一", "二", "三"]), {
          headers: { "content-type": "text/event-stream" }
        });

      const ctx = await chatCtx(user, {
        channel: "pgck",
        model: "glm-t",
        messages: [{ role: "user", content: "數數" }]
      });
      const resp = await onRequestPost(ctx);
      await resp.body!.cancel();
      await drainWaits(ctx);

      const conv = await env.DB.prepare("SELECT id FROM pg_conversations WHERE user_id=?1")
        .bind(user.id)
        .first<any>();
      const saved = await env.DB.prepare(
        "SELECT content FROM pg_messages WHERE conv_id=?1 AND role='assistant'"
      )
        .bind(conv.id)
        .all();
      expect(saved.results.length).toBe(1); // 存了三次，但始終只有一列
      expect(saved.results[0].content).toBe("一二三");
    } finally {
      BG.ckMs = prev;
    }
  });

  it("續跑有時間上限：預算用完就收工，不會一直讀到 isolate 被拔電源", async () => {
    const prev = BG.budgetMs;
    BG.budgetMs = 0; // 逼出極端情況：斷線後第一次檢查就收工＝完全不續跑（等同舊行為）
    try {
      const user = await seedUser({ status: "approved", services: "playground" });
      await seedChannel({ slug: "pgbd", kind: "openai", base_url: UP, models: "glm-t" });
      fetchMock
        .get(UP)
        .intercept({ path: "/v1/chat/completions", method: "POST" })
        .reply(200, reasoningSSE(["思考中"], ["一", "二", "三"]), {
          headers: { "content-type": "text/event-stream" }
        });

      const ctx = await chatCtx(user, {
        channel: "pgbd",
        model: "glm-t",
        messages: [{ role: "user", content: "數數" }]
      });
      const resp = await onRequestPost(ctx);
      await resp.body!.cancel();
      await drainWaits(ctx); // 會結束＝預算真的讓迴圈停下來了

      const conv = await env.DB.prepare("SELECT id FROM pg_conversations WHERE user_id=?1")
        .bind(user.id)
        .first<any>();
      const saved = await env.DB.prepare(
        "SELECT content FROM pg_messages WHERE conv_id=?1 AND role='assistant'"
      )
        .bind(conv.id)
        .all();
      // 預算 0＝一斷線就停，正文還沒生成 → 沒有 assistant 列。
      // 這正是預設值不能設 0 的原因，也證明上限是真的生效的那道閘。
      expect(saved.results.length).toBe(0);
      // user 訊息不受影響 — 問過的問題永遠存得住
      const u = await env.DB.prepare("SELECT COUNT(*) c FROM pg_messages WHERE conv_id=?1 AND role='user'")
        .bind(conv.id)
        .first<any>();
      expect(u.c).toBe(1);
    } finally {
      BG.budgetMs = prev;
    }
  });

  // 2026-07-21 線上實測抓到的真正死因，也是上面那些 cancel() 測試漏掉的情境：
  // 關掉分頁後 Cloudflare **不會**取消回應串流，只是再也沒有人讀 → 背壓不解除 →
  // writer.write() 既不 resolve 也不 reject。舊寫法卡在 await，整個請求被判定
  // hung 而 canceled，D1／req_log／errlog 全部陪葬（wrangler tail 才看得到）。
  // 所以這裡故意「不讀也不取消」—— 沒有死鎖斷路器的話，drainWaits 會等到天荒地老。
  it("沒人讀也沒人取消（線上真實情境）：寫入卡死不會拖垮整趟，回覆照樣完整存進 D1", async () => {
    const prev = BG.hangMs;
    BG.hangMs = 50; // 正式值 5 秒，測試縮短
    try {
      const user = await seedUser({ status: "approved", services: "playground" });
      await seedChannel({ slug: "pghang", kind: "openai", base_url: UP, models: "glm-t" });
      fetchMock
        .get(UP)
        .intercept({ path: "/v1/chat/completions", method: "POST" })
        .reply(200, reasoningSSE(["想很久"], ["完整", "的回覆"]), {
          headers: { "content-type": "text/event-stream" }
        });

      const ctx = await chatCtx(user, {
        channel: "pghang",
        model: "glm-t",
        messages: [{ role: "user", content: "思考到一半關掉分頁" }]
      });
      const resp = await onRequestPost(ctx); // 關鍵：完全不碰 resp.body —— 不讀、不取消，就像關掉的分頁
      await drainWaits(ctx);

      const conv = await env.DB.prepare("SELECT id FROM pg_conversations WHERE user_id=?1")
        .bind(user.id)
        .first<any>();
      const saved = await env.DB.prepare(
        "SELECT content FROM pg_messages WHERE conv_id=?1 AND role='assistant'"
      )
        .bind(conv.id)
        .all();
      expect(saved.results.length).toBe(1);
      expect(saved.results[0].content).toBe("完整的回覆");
      // 斷言做完才收拾：這是全套唯一「故意留著沒人讀的串流」的測試，不收掉的話
      // 那條 TransformStream 會讓 IoContext 一直活著，拖累後面測試的隔離儲存回收。
      // 放在斷言之後，所以不會削弱「沒人讀也要跑完」這個被測性質。
      await resp.body?.cancel().catch(() => {});
    } finally {
      BG.hangMs = prev;
    }
  });

  it("模型不在渠道清單 → 400；渠道不存在 → 404", async () => {
    const user = await seedUser({ status: "approved", services: "playground" });
    await seedChannel({ slug: "pg2", models: "only-this" });
    const bad = await chatCtx(user, {
      channel: "pg2",
      model: "other",
      messages: [{ role: "user", content: "x" }]
    });
    expect((await onRequestPost(bad)).status).toBe(400);
    const none = await chatCtx(user, {
      channel: "ghost",
      model: "m",
      messages: [{ role: "user", content: "x" }]
    });
    expect((await onRequestPost(none)).status).toBe(404);
  });

  it("上游先失敗（HTTP 500）：會員只看安全分類字、管理員看得到原文", async () => {
    const member = await seedUser({ status: "approved", services: "playground" });
    await seedChannel({ slug: "pg3", base_url: UP, models: "m" });
    fetchMock
      .get(UP)
      .intercept({ path: "/v1/chat/completions", method: "POST" })
      .reply(500, '{"error":{"message":"secret provider detail"}}');

    const ctx = await chatCtx(member, {
      channel: "pg3",
      model: "m",
      messages: [{ role: "user", content: "x" }]
    });
    const r = await onRequestPost(ctx);
    await drainWaits(ctx); // 埋點（errlog）是背景寫入，要等它收尾
    expect(r.status).toBe(502);
    const j: any = await r.json();
    expect(j.error).toBe("upstream-error");
    expect(j.detail).toBeUndefined(); // 原文不外洩
    expect(JSON.stringify(j)).not.toContain("secret provider detail");
    expect(j.conv).toBeGreaterThan(0); // 對話已建，user 訊息不丟

    const admin = await seedAdmin();
    fetchMock
      .get(UP)
      .intercept({ path: "/v1/chat/completions", method: "POST" })
      .reply(500, '{"error":{"message":"secret provider detail"}}');
    const ctx2 = await chatCtx(admin, {
      channel: "pg3",
      model: "m",
      messages: [{ role: "user", content: "x" }]
    });
    const j2: any = await (await onRequestPost(ctx2)).json();
    await drainWaits(ctx2);
    expect(j2.detail).toContain("secret provider detail"); // 管理員除錯用
    // 埋點：上游 5xx 也留了站內錯誤（src=pg.upstream）
    const errs = await env.DB.prepare("SELECT COUNT(*) c FROM errlog WHERE src='pg.upstream'").first<any>();
    expect(errs.c).toBe(2);
  });

  it("串流中途上游夾錯誤：已生成部分照存、會員拿到淨化訊息", async () => {
    const user = await seedUser({ status: "approved", services: "playground" });
    await seedChannel({ slug: "pg4", base_url: UP, models: "m" });
    const body =
      'data: {"choices":[{"delta":{"content":"部分"}}]}\n\n' +
      'data: {"error":{"message":"provider blew up"}}\n\n';
    fetchMock
      .get(UP)
      .intercept({ path: "/v1/chat/completions", method: "POST" })
      .reply(200, body, { headers: { "content-type": "text/event-stream" } });

    const ctx = await chatCtx(user, {
      channel: "pg4",
      model: "m",
      messages: [{ role: "user", content: "x" }]
    });
    const events = sseEvents(await readAll(await onRequestPost(ctx)));
    await drainWaits(ctx);
    const errEv = events.find((e: any) => e.error);
    expect(errEv).toBeTruthy();
    expect(errEv.hint).not.toContain("provider blew up"); // 淨化
    const convId = events[0].conv;
    const saved = await env.DB.prepare(
      "SELECT content FROM pg_messages WHERE conv_id=?1 AND role='assistant'"
    )
      .bind(convId)
      .first<any>();
    expect(saved.content).toBe("部分"); // 部分內容留住
  });

  it("上游不理串流、直接回整包 JSON → 一次送完（備援路徑）", async () => {
    const user = await seedUser({ status: "approved", services: "playground" });
    await seedChannel({ slug: "pg5", base_url: UP, models: "m" });
    fetchMock
      .get(UP)
      .intercept({ path: "/v1/chat/completions", method: "POST" })
      .reply(200, '{"choices":[{"message":{"content":"整包回覆"}}]}', {
        headers: { "content-type": "application/json" }
      });

    const ctx = await chatCtx(user, {
      channel: "pg5",
      model: "m",
      messages: [{ role: "user", content: "x" }]
    });
    const events = sseEvents(await readAll(await onRequestPost(ctx)));
    await drainWaits(ctx);
    expect(events.find((e: any) => e.d).d).toBe("整包回覆");
    expect(events[events.length - 1].done).toBe(true);
  });

  it("帶既有 conv_id 續聊；別人的對話 → 404", async () => {
    const user = await seedUser({ status: "approved", services: "playground" });
    const other = await seedUser({ status: "approved", services: "playground" });
    await seedChannel({ slug: "pg6", base_url: UP, models: "m" });
    const now = new Date().toISOString();
    const conv = await env.DB.prepare(
      "INSERT INTO pg_conversations (user_id,title,channel,model,created_at,updated_at) VALUES (?1,'t','pg6','m',?2,?2)"
    )
      .bind(other.id, now)
      .run();
    const ctx = await chatCtx(user, {
      conv_id: conv.meta.last_row_id,
      channel: "pg6",
      model: "m",
      messages: [{ role: "user", content: "偷看" }]
    });
    expect((await onRequestPost(ctx)).status).toBe(404);
  });
});
