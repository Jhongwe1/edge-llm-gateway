// Playground 附件（v2.3）：上傳守門、容量配額、歸屬檢查、與聊天的串接。
// 重點放在「會讓人上傳到壞東西 / 看到別人的東西 / 把資料庫塞爆」的那幾條路徑。
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { env, fetchMock } from "cloudflare:test";
import { onRequestPost as uploadFile } from "../../src/routes/api/playground/files/index.js";
import { onRequestGet as getFile } from "../../src/routes/api/playground/files/[id].js";
import { onRequestPost as chat } from "../../src/routes/api/playground/chat.js";
import { onRequestDelete as delConv } from "../../src/routes/api/playground/conversations/[id].js";
import { createSession } from "../../src/lib/auth.js";
import { makeCtx, drainWaits, seedUser, seedChannel, readAll, ORIGIN } from "../helpers.js";
import type { UserRow } from "../../src/types.js";

const UP = "https://api.example.com";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

// 造一張「檔頭合法」的假圖：前 12 byte 是真的 WebP 簽章，後面填任意資料湊大小
function fakeWebp(bytes: number): string {
  const u = new Uint8Array(Math.max(16, bytes));
  const sig = [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50];
  for (let i = 0; i < sig.length; i++) u[i] = sig[i];
  for (let i = sig.length; i < u.length; i++) u[i] = (i * 31) & 255;
  let s = "";
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s);
}
function fakePng(): string {
  const u = new Uint8Array(64);
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < sig.length; i++) u[i] = sig[i];
  let s = "";
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s);
}

async function upCtx(user: UserRow, b64: string, q?: string) {
  const sess = await createSession(env, user, new URL(ORIGIN + "/"));
  return makeCtx({
    url: ORIGIN + "/api/playground/files?" + (q || "mime=image/webp&name=a.webp&w=10&h=10"),
    init: {
      method: "POST",
      headers: {
        cookie: "ipua_sess=" + sess.sid,
        origin: ORIGIN,
        "content-type": "text/plain; charset=utf-8"
      },
      body: b64
    }
  });
}
const approved = () => seedUser({ status: "approved", services: "playground" });

describe("上傳守門", () => {
  it("正常圖片 → 200，落一列 pg_files（孤兒狀態：還沒綁對話）", async () => {
    const u = await approved();
    const ctx = await upCtx(u, fakeWebp(500));
    const r = await uploadFile(ctx);
    await drainWaits(ctx);
    expect(r.status).toBe(200);
    const d = (await r.json()) as any;
    expect(d.id).toBeGreaterThan(0);
    expect(d.mime).toBe("image/webp");
    const row = await env.DB.prepare("SELECT * FROM pg_files WHERE id=?1").bind(d.id).first<any>();
    expect(row.user_id).toBe(u.id);
    expect(row.conv_id).toBeNull();
    expect(row.msg_id).toBeNull();
    expect(row.storage).toBe("d1"); // 測試環境沒綁 R2 → 走 D1 路徑
    expect(row.b64).toBeTruthy();
  });

  it("宣告 image/png 但內容是 WebP → 415（不能只信 query 的 mime）", async () => {
    const u = await approved();
    const ctx = await upCtx(u, fakeWebp(200), "mime=image/png");
    const r = await uploadFile(ctx);
    await drainWaits(ctx);
    expect(r.status).toBe(415);
    expect(((await r.json()) as any).error).toBe("type-mismatch");
  });

  it("SVG 之類的非白名單格式 → 415（連檔頭都不用看）", async () => {
    const u = await approved();
    const ctx = await upCtx(u, fakePng(), "mime=image/svg%2Bxml");
    const r = await uploadFile(ctx);
    await drainWaits(ctx);
    expect(r.status).toBe(415);
    expect(((await r.json()) as any).error).toBe("bad-type");
  });

  it("內容不是合法 base64 → 400（這是字串串接快路徑的安全前提）", async () => {
    const u = await approved();
    const ctx = await upCtx(u, 'AAA","injected":"x');
    const r = await uploadFile(ctx);
    await drainWaits(ctx);
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error).toBe("bad-encoding");
  });

  it("超過單檔上限 → 413", async () => {
    const u = await approved();
    await env.DB.prepare("INSERT OR REPLACE INTO settings (k,v) VALUES ('pgfile_max_kb','1')").run();
    const ctx = await upCtx(u, fakeWebp(4096)); // 4KB > 1KB
    const r = await uploadFile(ctx);
    await drainWaits(ctx);
    expect(r.status).toBe(413);
    expect(((await r.json()) as any).error).toBe("too-large");
    await env.DB.prepare("DELETE FROM settings WHERE k='pgfile_max_kb'").run();
  });

  it("個人容量用完 → 413（管理員豁免）", async () => {
    const u = await approved();
    await env.DB.prepare("INSERT OR REPLACE INTO settings (k,v) VALUES ('pgfile_user_mb','1')").run();
    // 先塞一筆 1MB 佔滿配額
    await env.DB.prepare(
      "INSERT INTO pg_files (user_id,kind,mime,name,bytes,storage,b64,purged,created_at) " +
        "VALUES (?1,'image','image/webp','big.webp',1048576,'d1','AAAA',0,?2)"
    )
      .bind(u.id, new Date().toISOString())
      .run();
    const ctx = await upCtx(u, fakeWebp(500));
    const r = await uploadFile(ctx);
    await drainWaits(ctx);
    expect(r.status).toBe(413);
    expect(((await r.json()) as any).error).toBe("quota-exceeded");
    await env.DB.prepare("DELETE FROM settings WHERE k='pgfile_user_mb'").run();
  });

  it("未登入且 demo 關著 → 401", async () => {
    const ctx = makeCtx({
      url: ORIGIN + "/api/playground/files?mime=image/webp",
      init: { method: "POST", headers: { origin: ORIGIN }, body: fakeWebp(200) }
    });
    const r = await uploadFile(ctx);
    await drainWaits(ctx);
    expect(r.status).toBe(401);
  });
});

describe("讀回附件", () => {
  it("自己的讀得到（二進位＋正確 content-type）", async () => {
    const u = await approved();
    const up = await upCtx(u, fakeWebp(300));
    const id = ((await (await uploadFile(up)).json()) as any).id;
    await drainWaits(up);

    const sess = await createSession(env, u, new URL(ORIGIN + "/"));
    const ctx = makeCtx({
      url: ORIGIN + "/api/playground/files/" + id,
      init: { headers: { cookie: "ipua_sess=" + sess.sid } },
      params: { id: String(id) }
    });
    const r = await getFile(ctx);
    await drainWaits(ctx);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/webp");
    const buf = new Uint8Array(await r.arrayBuffer());
    expect(buf[0]).toBe(0x52); // 'R' of RIFF — 解碼回來確實是原圖
    expect(buf[8]).toBe(0x57); // 'W' of WEBP
  });

  it("別人的檔案 → 404（不是 403 — 403 等於承認這個編號存在）", async () => {
    const owner = await approved();
    const other = await approved();
    const up = await upCtx(owner, fakeWebp(300));
    const id = ((await (await uploadFile(up)).json()) as any).id;
    await drainWaits(up);

    const sess = await createSession(env, other, new URL(ORIGIN + "/"));
    const ctx = makeCtx({
      url: ORIGIN + "/api/playground/files/" + id,
      init: { headers: { cookie: "ipua_sess=" + sess.sid } },
      params: { id: String(id) }
    });
    const r = await getFile(ctx);
    await drainWaits(ctx);
    expect(r.status).toBe(404);
  });

  it("內容已淘汰（purged）→ 410，並附中繼資料給前端畫佔位", async () => {
    const u = await approved();
    const up = await upCtx(u, fakeWebp(300));
    const id = ((await (await uploadFile(up)).json()) as any).id;
    await drainWaits(up);
    await env.DB.prepare("UPDATE pg_files SET purged=1, b64=NULL WHERE id=?1").bind(id).run();

    const sess = await createSession(env, u, new URL(ORIGIN + "/"));
    const ctx = makeCtx({
      url: ORIGIN + "/api/playground/files/" + id,
      init: { headers: { cookie: "ipua_sess=" + sess.sid } },
      params: { id: String(id) }
    });
    const r = await getFile(ctx);
    await drainWaits(ctx);
    expect(r.status).toBe(410);
    const d = (await r.json()) as any;
    expect(d.error).toBe("purged");
    expect(d.name).toBe("a.webp");
  });
});

describe("聊天串接", () => {
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

  it("模型沒被標成 vision → 400，且【不建對話】", async () => {
    const u = await approved();
    const ch = await seedChannel({ models: "m1", vision_models: "" });
    const up = await upCtx(u, fakeWebp(300));
    const fid = ((await (await uploadFile(up)).json()) as any).id;
    await drainWaits(up);

    const before = await env.DB.prepare("SELECT COUNT(*) c FROM pg_conversations").first<any>();
    const ctx = await chatCtx(u, {
      channel: ch.slug,
      model: "m1",
      messages: [{ role: "user", content: "看圖", files: [fid] }]
    });
    const r = await chat(ctx);
    await drainWaits(ctx);
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error).toBe("no-vision");
    const after = await env.DB.prepare("SELECT COUNT(*) c FROM pg_conversations").first<any>();
    expect(after.c).toBe(before.c);
  });

  it("vision 模型 → 圖片進上游 body，且附件被綁到那則訊息", async () => {
    const u = await approved();
    const ch = await seedChannel({ models: "m1", vision_models: "m1", base_url: UP });
    const up = await upCtx(u, fakeWebp(300));
    const fid = ((await (await uploadFile(up)).json()) as any).id;
    await drainWaits(up);

    let sentBody = "";
    fetchMock
      .get(UP)
      .intercept({ path: "/v1/chat/completions", method: "POST" })
      .reply(
        200,
        (opts: any) => {
          sentBody = String(opts.body || "");
          return 'data: {"choices":[{"delta":{"content":"看到了"}}]}\n\ndata: [DONE]\n\n';
        },
        { headers: { "content-type": "text/event-stream" } }
      );

    const ctx = await chatCtx(u, {
      channel: ch.slug,
      model: "m1",
      messages: [{ role: "user", content: "這是什麼", files: [fid] }]
    });
    const r = await chat(ctx);
    await readAll(r);
    await drainWaits(ctx);

    // 上游確實收到 data URL 形式的圖
    expect(sentBody).toContain("image_url");
    expect(sentBody).toContain("data:image/webp;base64,");
    // 附件已從孤兒狀態綁到對話與訊息上
    const row = await env.DB.prepare("SELECT * FROM pg_files WHERE id=?1").bind(fid).first<any>();
    expect(row.conv_id).toBeGreaterThan(0);
    expect(row.msg_id).toBeGreaterThan(0);
  });

  it("別人的檔案編號塞進來 → 查不到，靜默降級成文字佔位（不會洩漏內容）", async () => {
    const owner = await approved();
    const attacker = await approved();
    const ch = await seedChannel({ models: "m1", vision_models: "m1", base_url: UP });
    const up = await upCtx(owner, fakeWebp(300));
    const victimId = ((await (await uploadFile(up)).json()) as any).id;
    await drainWaits(up);

    let sentBody = "";
    fetchMock
      .get(UP)
      .intercept({ path: "/v1/chat/completions", method: "POST" })
      .reply(
        200,
        (opts: any) => {
          sentBody = String(opts.body || "");
          return 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n';
        },
        { headers: { "content-type": "text/event-stream" } }
      );

    const ctx = await chatCtx(attacker, {
      channel: ch.slug,
      model: "m1",
      messages: [{ role: "user", content: "偷看", files: [victimId] }]
    });
    const r = await chat(ctx);
    await readAll(r);
    await drainWaits(ctx);

    expect(sentBody).not.toContain("image_url"); // 沒有任何圖片進到上游
    expect(sentBody).toContain("已省略的圖片");
    // 受害者的檔案沒有被綁走
    const row = await env.DB.prepare("SELECT * FROM pg_files WHERE id=?1").bind(victimId).first<any>();
    expect(row.msg_id).toBeNull();
  });

  it("刪對話 → 附件一起刪掉（不留孤兒佔容量）", async () => {
    const u = await approved();
    const ch = await seedChannel({ models: "m1", vision_models: "m1", base_url: UP });
    const up = await upCtx(u, fakeWebp(300));
    const fid = ((await (await uploadFile(up)).json()) as any).id;
    await drainWaits(up);

    fetchMock
      .get(UP)
      .intercept({ path: "/v1/chat/completions", method: "POST" })
      .reply(200, 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
        headers: { "content-type": "text/event-stream" }
      });
    const c1 = await chatCtx(u, {
      channel: ch.slug,
      model: "m1",
      messages: [{ role: "user", content: "x", files: [fid] }]
    });
    await readAll(await chat(c1));
    await drainWaits(c1);
    const row = await env.DB.prepare("SELECT conv_id FROM pg_files WHERE id=?1").bind(fid).first<any>();
    const convId = row.conv_id;

    const sess = await createSession(env, u, new URL(ORIGIN + "/"));
    const ctx = makeCtx({
      url: ORIGIN + "/api/playground/conversations/" + convId,
      init: { method: "DELETE", headers: { cookie: "ipua_sess=" + sess.sid, origin: ORIGIN } },
      params: { id: String(convId) }
    });
    expect((await delConv(ctx)).status).toBe(200);
    await drainWaits(ctx);
    const left = await env.DB.prepare("SELECT * FROM pg_files WHERE id=?1").bind(fid).first<any>();
    expect(left).toBeNull();
  });
});
