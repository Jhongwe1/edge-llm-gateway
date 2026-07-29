// /api/admin/relay/channels/<編號> — 管理員專用：PUT 更新管道、DELETE 刪除管道。
// PUT 整包覆蓋，唯一例外：本體「沒帶 api_key 欄位」＝上游金鑰保留舊值
//（帶空字串 ""＝清掉金鑰）。這樣改名／換網址不用重貼金鑰。
import { json } from "../../../../../lib/site.js";
import { adminOk } from "../../../../../lib/auth.js";
import { audit } from "../../../../../lib/observe.js";
import { cleanChannel, maskRow } from "./index.js";
import type { RouteCtx } from "../../../../../types.js";

function idOf(params: RouteCtx["params"]): number | null {
  const id = parseInt(String(params.id), 10);
  return id > 0 ? id : null;
}

export async function onRequestPut(context: RouteCtx): Promise<Response> {
  const { request, env, params } = context;
  const url = new URL(request.url);
  if (!(await adminOk(request, env, url))) return json({ error: "unauthorized" }, 401);
  const id = idOf(params);
  if (!id || !env.DB) return json({ error: "bad-id" }, 400);

  let body: any = null;
  try {
    body = await request.json();
  } catch (e) {}
  const c = cleanChannel(body);
  if (c.err !== undefined) return json({ error: "bad-input", hint: c.err }, 400);

  try {
    const old = await env.DB.prepare("SELECT * FROM relay_channels WHERE id=?1")
      .bind(id)
      .first<{ api_key: string; slug: string; sort_order?: number }>();
    if (!old) return json({ error: "not-found" }, 404);
    const key = c.ch.api_key === undefined ? old.api_key : c.ch.api_key;
    const sortOld = old.sort_order == null ? 0 : Number(old.sort_order);
    const slug = c.ch.slug || old.slug; // 沒帶 slug＝沿用舊代稱（會員的 /relay 網址不變）
    await env.DB.prepare(
      "UPDATE relay_channels SET slug=?1,name=?2,kind=?3,base_url=?4,api_key=?5,models=?6,system_prompt=?7,extra_body=?8,vision_models=?9,sort_order=?10,enabled=?11 WHERE id=?12"
    )
      .bind(
        slug,
        c.ch.name,
        c.ch.kind,
        c.ch.base_url,
        key,
        c.ch.models,
        c.ch.system_prompt,
        c.ch.extra_body,
        c.ch.vision_models,
        // 沒帶 sort_order＝維持原本的排序（普通的欄位編輯不該把管道位置洗掉）
        c.ch.sort_order === undefined ? sortOld : c.ch.sort_order,
        c.ch.enabled,
        id
      )
      .run();
    const row = await env.DB.prepare("SELECT * FROM relay_channels WHERE id=?1").bind(id).first();
    // 稽核不落金鑰本體，只記這次動作有沒有動到金鑰
    const keyNote = c.ch.api_key === undefined ? "保留" : c.ch.api_key ? "更新" : "清除";
    audit(
      env,
      function (p) {
        context.waitUntil(p);
      },
      request,
      "relay.channel.update",
      slug,
      c.ch.name + " enabled=" + c.ch.enabled + " 金鑰:" + keyNote
    );
    return json({ row: maskRow(row) });
  } catch (e: any) {
    const msg = String((e && e.message) || e);
    if (msg.indexOf("UNIQUE") >= 0)
      return json({ error: "slug-taken", hint: "slug「" + c.ch.slug + "」已有管道在用" }, 409);
    return json({ error: "update-failed", detail: msg }, 500);
  }
}

export async function onRequestDelete(context: RouteCtx): Promise<Response> {
  const { request, env, params } = context;
  const url = new URL(request.url);
  if (!(await adminOk(request, env, url))) return json({ error: "unauthorized" }, 401);
  const id = idOf(params);
  if (!id || !env.DB) return json({ error: "bad-id" }, 400);
  try {
    const old = await env.DB.prepare("SELECT slug,name FROM relay_channels WHERE id=?1")
      .bind(id)
      .first<{ slug: string; name: string }>();
    await env.DB.prepare("DELETE FROM relay_channels WHERE id=?1").bind(id).run();
    audit(
      env,
      function (p) {
        context.waitUntil(p);
      },
      request,
      "relay.channel.delete",
      (old && old.slug) || id,
      (old && old.name) || ""
    );
    return json({ ok: true });
  } catch (e: any) {
    return json({ error: "delete-failed", detail: String((e && e.message) || e) }, 500);
  }
}
