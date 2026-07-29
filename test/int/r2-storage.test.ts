// R2 儲存模式（2026-07-29）：附件存進 R2 桶、額度守門、兩種模式互通。
//
// 測試環境預設**沒有** FILES 綁定（純 D1 模式，見 vitest.config.mjs 的說明），
// 所以這裡自己組一個 { ...env, FILES: env.FILES_TEST } 當成「開通 R2 的站台」。
// 一個 handler 兩種 env 跑得起來，本身就是「雙模式」這個設計最直接的證明。
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { onRequestPost as uploadFile } from "../../src/routes/api/playground/files/index.js";
import { onRequestGet as getFile } from "../../src/routes/api/playground/files/[id].js";
import { onRequestPut as putSettings } from "../../src/routes/api/admin/settings.js";
import { createSession } from "../../src/lib/auth.js";
import { activeStore, fileLimits, uploadPlan, FILE_DEFAULTS, FILE_CEILING } from "../../src/lib/filestore.js";
import { R2_PLAN, opKeys, resetOpsCache } from "../../src/lib/r2budget.js";
import { makeCtx, drainWaits, seedUser, readAll, ORIGIN } from "../helpers.js";
import type { Env, UserRow } from "../../src/types.js";

// 「開通了 R2 的環境」。FILES_TEST 是 vitest.config.mjs 裡另外綁的記憶體桶。
const r2Env = () =>
  ({ ...env, FILES: (env as unknown as { FILES_TEST: R2Bucket }).FILES_TEST }) as unknown as Env;

function fakeWebp(bytes: number): string {
  const u = new Uint8Array(Math.max(16, bytes));
  const sig = [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50];
  for (let i = 0; i < sig.length; i++) u[i] = sig[i];
  for (let i = sig.length; i < u.length; i++) u[i] = (i * 31) & 255;
  let s = "";
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s);
}

async function upCtx(user: UserRow, b64: string, useEnv?: Env) {
  const sess = await createSession(env, user, new URL(ORIGIN + "/"));
  return makeCtx({
    url: ORIGIN + "/api/playground/files?mime=image/webp&name=a.webp&w=10&h=10",
    env: useEnv,
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

// 直接把本月的操作計數設成某個值（模擬「額度快用完」）
async function setOps(cls: "a" | "b", n: number) {
  const k = cls === "a" ? opKeys().a : opKeys().b;
  await env.DB.prepare("INSERT OR REPLACE INTO settings (k,v) VALUES (?1,?2)").bind(k, String(n)).run();
  resetOpsCache(); // 額度快取是 isolate 內的，測試之間要清掉
}

beforeEach(() => resetOpsCache());

describe("模式判斷", () => {
  it("沒有 FILES 綁定＝純 D1 模式，有＝R2 模式", () => {
    expect(activeStore(env as unknown as Env)).toBe("d1");
    expect(activeStore(r2Env())).toBe("r2");
  });

  it("兩種模式各自帶一組配額（單檔 1400KB vs 5MB）", async () => {
    expect((await fileLimits(env as unknown as Env)).maxKb).toBe(FILE_DEFAULTS.d1.pgfile_max_kb);
    expect((await fileLimits(r2Env())).maxKb).toBe(FILE_DEFAULTS.r2.pgfile_max_kb);
  });
});

describe("R2 模式的上傳與回讀", () => {
  it("附件進 R2 桶、D1 只留鍵名，回讀拿得到原內容", async () => {
    const u = await approved();
    const b64 = fakeWebp(3000);
    const ctx = await upCtx(u, b64, r2Env());
    const r = await uploadFile(ctx);
    await drainWaits(ctx);
    expect(r.status).toBe(200);
    const d = (await r.json()) as { id: number; store: string };
    expect(d.store).toBe("r2");

    const row = await env.DB.prepare("SELECT * FROM pg_files WHERE id=?1").bind(d.id).first<any>();
    expect(row.storage).toBe("r2");
    expect(row.b64).toBeNull(); // 內容不在 D1
    expect(row.r2_key).toMatch(/^pgfile\/\d+\//);

    // 桶裡真的有那個物件，而且存的是 base64 字串本身（不是二進位）
    const obj = await r2Env().FILES!.get(row.r2_key);
    expect(await obj!.text()).toBe(b64);

    // 回讀端點還原成二進位圖片（Uint8Array.fromBase64 那條路）
    const gctx = makeCtx({
      url: ORIGIN + "/api/playground/files/" + d.id,
      env: r2Env(),
      params: { id: String(d.id) },
      init: { headers: { cookie: ctx.request.headers.get("cookie") || "" } }
    });
    const gr = await getFile(gctx);
    await drainWaits(gctx);
    expect(gr.status).toBe(200);
    expect(gr.headers.get("content-type")).toBe("image/webp");
    const bytes = new Uint8Array(await gr.arrayBuffer());
    expect(bytes[0]).toBe(0x52); // RIFF
    expect(bytes.length).toBe(3000);
  });

  it("上傳記 1 次 Class A、回讀記 1 次 Class B", async () => {
    const u = await approved();
    await setOps("a", 0);
    await setOps("b", 0);
    const ctx = await upCtx(u, fakeWebp(500), r2Env());
    const d = (await (await uploadFile(ctx)).json()) as { id: number };
    await drainWaits(ctx);
    const a = await env.DB.prepare("SELECT v FROM settings WHERE k=?1").bind(opKeys().a).first<any>();
    expect(parseInt(a.v, 10)).toBe(1);

    const gctx = makeCtx({
      url: ORIGIN + "/api/playground/files/" + d.id,
      env: r2Env(),
      params: { id: String(d.id) },
      init: { headers: { cookie: ctx.request.headers.get("cookie") || "" } }
    });
    await readAll(await getFile(gctx));
    await drainWaits(gctx);
    const b = await env.DB.prepare("SELECT v FROM settings WHERE k=?1").bind(opKeys().b).first<any>();
    expect(parseInt(b.v, 10)).toBe(1);
  });

  it("D1 時代存的舊檔，在 R2 模式下照樣讀得到（不必搬資料）", async () => {
    const u = await approved();
    const b64 = fakeWebp(400);
    // 純 D1 模式先傳一張
    const ctx = await upCtx(u, b64);
    const d = (await (await uploadFile(ctx)).json()) as { id: number };
    await drainWaits(ctx);
    expect(
      (await env.DB.prepare("SELECT storage FROM pg_files WHERE id=?1").bind(d.id).first<any>()).storage
    ).toBe("d1");

    // 之後才開通 R2 —— 那一列自己記得 storage='d1'，讀取走 D1 欄位
    const gctx = makeCtx({
      url: ORIGIN + "/api/playground/files/" + d.id,
      env: r2Env(),
      params: { id: String(d.id) },
      init: { headers: { cookie: ctx.request.headers.get("cookie") || "" } }
    });
    const gr = await getFile(gctx);
    await drainWaits(gctx);
    expect(gr.status).toBe(200);
    expect(new Uint8Array(await gr.arrayBuffer()).length).toBe(400);
  });

  it("R2 的檔在退回純 D1 模式後讀不到，但不會炸站（回 404 讓前端畫佔位）", async () => {
    const u = await approved();
    const ctx = await upCtx(u, fakeWebp(300), r2Env());
    const d = (await (await uploadFile(ctx)).json()) as { id: number };
    await drainWaits(ctx);

    const gctx = makeCtx({
      url: ORIGIN + "/api/playground/files/" + d.id,
      env: env as unknown as Env, // 綁定拿掉了
      params: { id: String(d.id) },
      init: { headers: { cookie: ctx.request.headers.get("cookie") || "" } }
    });
    const gr = await getFile(gctx);
    await drainWaits(gctx);
    expect(gr.status).toBe(404);
  });
});

describe("免費額度守門", () => {
  it("Class A 預算用完 → 新檔退回 D1，單檔上限跟著縮回 1400KB", async () => {
    await setOps("a", R2_PLAN.classA);
    const plan = await uploadPlan(r2Env());
    expect(plan.store).toBe("d1");
    expect(plan.degraded).toBe(true);
    expect(plan.maxKb).toBe(FILE_DEFAULTS.d1.pgfile_max_kb);

    // 實際上傳也要真的落在 D1
    const u = await approved();
    const ctx = await upCtx(u, fakeWebp(800), r2Env());
    const d = (await (await uploadFile(ctx)).json()) as { id: number };
    await drainWaits(ctx);
    const row = await env.DB.prepare("SELECT * FROM pg_files WHERE id=?1").bind(d.id).first<any>();
    expect(row.storage).toBe("d1");
    expect(row.b64).toBeTruthy();
  });

  it("Class A 預算用完後，超過 D1 上限的檔會被擋下並說明原因", async () => {
    await setOps("a", R2_PLAN.classA);
    const u = await approved();
    // 2MB 在 R2 模式本來收得下（上限 5MB），退回 D1 之後就超過 1400KB 了
    const ctx = await upCtx(u, fakeWebp(2 * 1024 * 1024), r2Env());
    const r = await uploadFile(ctx);
    await drainWaits(ctx);
    expect(r.status).toBe(413);
    const body = (await r.json()) as { error: string; hint: string };
    expect(body.error).toBe("too-large");
    expect(body.hint).toContain("R2 寫入額度");
  });

  it("Class B 預算用完 → 回讀當成讀不到（降級，不是 500）", async () => {
    const u = await approved();
    const ctx = await upCtx(u, fakeWebp(300), r2Env());
    const d = (await (await uploadFile(ctx)).json()) as { id: number };
    await drainWaits(ctx);

    await setOps("b", R2_PLAN.classB);
    const gctx = makeCtx({
      url: ORIGIN + "/api/playground/files/" + d.id,
      env: r2Env(),
      params: { id: String(d.id) },
      init: { headers: { cookie: ctx.request.headers.get("cookie") || "" } }
    });
    const gr = await getFile(gctx);
    await drainWaits(gctx);
    expect(gr.status).toBe(404);
  });

  it("單檔上限 5MB 的圖收得下（R2 模式）", async () => {
    const u = await approved();
    await setOps("a", 0);
    const ctx = await upCtx(u, fakeWebp(5 * 1024 * 1024), r2Env());
    const r = await uploadFile(ctx);
    await drainWaits(ctx);
    expect(r.status).toBe(200);
  });
});

describe("設定天花板 — 管理員不能把額度調到超過免費方案", () => {
  const TOK = "test-admin-token";
  // 管理金鑰走 LOGS_TOKEN（跟其他 admin 端點測試同一套）
  const adminEnv = (useEnv: Env) => Object.assign({}, useEnv, { LOGS_TOKEN: TOK }) as Env;

  async function putCtx(useEnv: Env, body: Record<string, unknown>) {
    return makeCtx({
      url: ORIGIN + "/api/admin/settings",
      env: adminEnv(useEnv),
      init: {
        method: "PUT",
        headers: {
          origin: ORIGIN,
          "content-type": "application/json",
          authorization: "Bearer " + TOK
        },
        body: JSON.stringify(body)
      }
    });
  }

  it("R2 模式下 pgfile_total_mb 超過天花板 → 400，訊息點名免費額度", async () => {
    const ctx = await putCtx(r2Env(), { pgfile_total_mb: 999999 });
    const r = await putSettings(ctx);
    await drainWaits(ctx);
    expect(r.status).toBe(400);
    const b = (await r.json()) as { hint: string; ceiling: number };
    expect(b.ceiling).toBe(FILE_CEILING.r2.pgfile_total_mb);
    expect(b.hint).toContain("免費額度");
  });

  it("純 D1 模式下單檔超過 D1 單值上限 → 400（否則要等寫入才炸）", async () => {
    const ctx = await putCtx(env as unknown as Env, { pgfile_max_kb: 5120 });
    const r = await putSettings(ctx);
    await drainWaits(ctx);
    expect(r.status).toBe(400);
    expect(((await r.json()) as { ceiling: number }).ceiling).toBe(FILE_CEILING.d1.pgfile_max_kb);
  });

  it("天花板以內的值照常收下", async () => {
    const ctx = await putCtx(r2Env(), { pgfile_total_mb: 1000 });
    const r = await putSettings(ctx);
    await drainWaits(ctx);
    expect(r.status).toBe(200);
    expect((await fileLimits(r2Env())).totalMb).toBe(1000);
    await env.DB.prepare("DELETE FROM settings WHERE k='pgfile_total_mb'").run();
  });

  it("就算 settings 裡躺著超標的舊值，讀出來也會被夾回天花板", async () => {
    await env.DB.prepare("INSERT OR REPLACE INTO settings (k,v) VALUES ('pgfile_total_mb','999999')").run();
    expect((await fileLimits(r2Env())).totalMb).toBe(FILE_CEILING.r2.pgfile_total_mb);
    await env.DB.prepare("DELETE FROM settings WHERE k='pgfile_total_mb'").run();
  });
});
