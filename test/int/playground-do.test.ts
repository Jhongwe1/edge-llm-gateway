// POST /api/playground/chat 的 **Durable Object 路徑**（v2.5_DO，ADR-0015）。
//
// 為什麼要獨立一個檔案：測試環境的 DO 綁定**故意叫 PG_STREAM_TEST 而不是 PG_STREAM**
// （見 vitest.config.mjs 的註解），所以 playground-chat.test.ts 那 20 幾個測試跑的是
// 「沒有 DO 的退路」＝Worker 路徑。這裡把同一個 handler 餵一個**有 PG_STREAM 的 env**，
// 驗證交棒之後行為完全一樣。
//
// 兩條路徑跑的是同一支 lib/pgchat.ts 的 runChat —— 這是刻意的設計（見該檔檔頭）：
// 串流與淨化的細節由 playground-chat.test.ts 涵蓋，**這個檔案只驗「交棒本身」**：
// 交棒有沒有真的發生、跨 DO 邊界之後 SSE 與 D1 落地是否原樣、開關關掉會不會回到舊路徑。
//
// ⚠️ DO 拿到的是 miniflare 的原始 env，不是測試用 envWith() 疊出來的那個。
// 所以在這個檔案裡「用 envWith 覆寫某個綁定」對 DO 內部無效（DB 是同一顆，沒差；
// 但要測 FILES/R2 之類的覆寫就不能靠這條路）。
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { env, fetchMock } from "cloudflare:test";
import { onRequestPost } from "../../src/routes/api/playground/chat.js";
import { createSession } from "../../src/lib/auth.js";
import {
  makeCtx,
  drainWaits,
  seedUser,
  seedChannel,
  readAll,
  sseEvents,
  envWith,
  ORIGIN
} from "../helpers.js";
import type { Env, UserRow } from "../../src/types.js";

const UP = "https://api.example.com";

// 有 PG_STREAM 的 env＝正式環境的形狀（wrangler.toml 綁著它）
function doEnv(extra?: Record<string, unknown>): Env {
  return envWith(Object.assign({ PG_STREAM: (env as any).PG_STREAM_TEST }, extra || {}));
}

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

async function chatCtx(user: UserRow, body: unknown, useEnv: Env) {
  const sess = await createSession(env, user, new URL(ORIGIN + "/"));
  return makeCtx({
    url: ORIGIN + "/api/playground/chat",
    env: useEnv,
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

describe("playground chat：交棒給 PgStream DO", () => {
  it("快樂路徑：SSE 穿過 DO 原樣送達，assistant 回覆與 req_log 都由伺服器端落地", async () => {
    const user = await seedUser({ status: "approved", services: "playground" });
    await seedChannel({ slug: "pgdo", kind: "openai", base_url: UP, models: "gpt-t" });
    fetchMock
      .get(UP)
      .intercept({ path: "/v1/chat/completions", method: "POST" })
      .reply(200, openaiSSE(["你", "好", "，世界"]), { headers: { "content-type": "text/event-stream" } });

    const ctx = await chatCtx(
      user,
      { channel: "pgdo", model: "gpt-t", messages: [{ role: "user", content: "打招呼" }] },
      doEnv()
    );
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
    ).toBe("你好，世界");
    expect(events[events.length - 1].done).toBe(true);

    // ── 這三條是 v2.5_DO 相對於 v2.5 直通版的全部理由 ──
    // 直通版伺服器看不到回覆，落地與 token 用量都得改由前端回報；DO 版沒有這個代價。
    // 而且落地一定發生在 done 事件之前（runChat 的順序），所以讀完串流就能直接斷言。
    const convId = events[0].conv;
    const msgs = await env.DB.prepare("SELECT role,content FROM pg_messages WHERE conv_id=?1 ORDER BY id")
      .bind(convId)
      .all();
    expect(msgs.results.map((m: any) => m.role)).toEqual(["user", "assistant"]);
    expect(msgs.results[1].content).toBe("你好，世界");
    const log = await env.DB.prepare("SELECT * FROM req_log WHERE user_id=?1 AND svc='pg'")
      .bind(user.id)
      .first<any>();
    expect(log.channel).toBe("pgdo");
    expect(log.status).toBe(200);
  });

  // 這一條是整個 v2.5_DO 存在的理由：v2.5 的原生直通把上游位元組原樣交給瀏覽器，
  // 上游錯誤原文（含提供商身分）會直接落在會員眼前。DO 版把轉譯留著，淨化照舊生效。
  it("上游錯誤：跨 DO 邊界之後，會員拿到的仍是安全分類字，沒有上游身分外洩", async () => {
    const user = await seedUser({ status: "approved", services: "playground" });
    await seedChannel({ slug: "pgdo2", kind: "openai", base_url: UP, models: "gpt-t" });
    fetchMock
      .get(UP)
      .intercept({ path: "/v1/chat/completions", method: "POST" })
      .reply(
        401,
        JSON.stringify({
          error: { message: "Incorrect API key provided by AcmeCloud, see https://acme.example/docs" }
        }),
        {
          headers: { "content-type": "application/json" }
        }
      );

    const ctx = await chatCtx(
      user,
      { channel: "pgdo2", model: "gpt-t", messages: [{ role: "user", content: "嗨" }] },
      doEnv()
    );
    const resp = await onRequestPost(ctx);
    await drainWaits(ctx);
    expect(resp.status).toBe(502);
    const body = await resp.text();
    expect(JSON.parse(body).hint).toBe("渠道憑證可能失效，請聯絡管理員");
    expect(body).not.toContain("AcmeCloud");
    expect(body).not.toContain("acme.example");
    // conv 仍要回給前端，否則它會重複開一則新對話
    expect(JSON.parse(body).conv).toBeGreaterThan(0);
  });

  // 免部署的退路（跟 quota_do='0' 同一套慣例）。壞掉時站長要能立刻讓服務恢復可用。
  it("settings.pg_do='0'：不交棒，改在 Worker 裡跑，結果一模一樣", async () => {
    const user = await seedUser({ status: "approved", services: "playground" });
    await seedChannel({ slug: "pgdo3", kind: "openai", base_url: UP, models: "gpt-t" });
    await env.DB.prepare("INSERT OR REPLACE INTO settings (k,v) VALUES ('pg_do','0')").run();
    fetchMock
      .get(UP)
      .intercept({ path: "/v1/chat/completions", method: "POST" })
      .reply(200, openaiSSE(["退", "路"]), { headers: { "content-type": "text/event-stream" } });

    const ctx = await chatCtx(
      user,
      { channel: "pgdo3", model: "gpt-t", messages: [{ role: "user", content: "測退路" }] },
      doEnv()
    );
    const resp = await onRequestPost(ctx);
    const events = sseEvents(await readAll(resp));
    // Worker 路徑的背景工作掛在 waitUntil —— 一定要 drain，否則 D1 還沒寫完就斷言
    await drainWaits(ctx);
    expect(
      events
        .filter((e: any) => e.d)
        .map((e: any) => e.d)
        .join("")
    ).toBe("退路");
    const msgs = await env.DB.prepare("SELECT content FROM pg_messages WHERE conv_id=?1 AND role='assistant'")
      .bind(events[0].conv)
      .all();
    expect(msgs.results[0].content).toBe("退路");
  });

  // 交棒信封是「job JSON 一行 ＋ 原始本體原樣接上」。dumb 模式會覆寫渠道與模型，
  // 而原始本體裡留著的是使用者自己填的那組 —— DO 一律以 job 為準，不能回頭讀本體。
  it("渠道與模型以 job 為準：本體裡的值不會被 DO 拿去用", async () => {
    const user = await seedUser({ status: "approved", services: "playground" });
    await seedChannel({ slug: "real", kind: "openai", base_url: UP, models: "gpt-t" });
    fetchMock
      .get(UP)
      .intercept({ path: "/v1/chat/completions", method: "POST" })
      .reply(200, openaiSSE(["ok"]), { headers: { "content-type": "text/event-stream" } });

    const ctx = await chatCtx(
      user,
      { channel: "real", model: "gpt-t", messages: [{ role: "user", content: "嗨" }] },
      doEnv()
    );
    const resp = await onRequestPost(ctx);
    const events = sseEvents(await readAll(resp));
    await drainWaits(ctx);
    expect(events[events.length - 1].done).toBe(true);
    const log = await env.DB.prepare("SELECT channel,model FROM req_log WHERE user_id=?1")
      .bind(user.id)
      .first<any>();
    expect(log.channel).toBe("real");
    expect(log.model).toBe("gpt-t");
  });
});
