// GET /api/relay/channels — 會員看得到的管道清單（要登入；不含任何金鑰）。
// /relay 頁面用它列出「有哪些入口可以用」；models 是該管道可用的模型名稱（可直接複製）。
import { json } from "../../../lib/site.js";
import { getSessionUser, hasService } from "../../../lib/auth.js";
import { modelList } from "../admin/relay/channels/index.js";
import type { RouteCtx } from "../../../types.js";

export async function onRequestGet({ request, env }: RouteCtx): Promise<Response> {
  const user = await getSessionUser(request, env);
  if (!user) return json({ error: "unauthorized", hint: "請先登入" }, 401);
  if (!env.DB) return json({ error: "no-db" }, 500);
  try {
    const res = await env.DB.prepare(
      "SELECT slug,name,kind,models FROM relay_channels WHERE enabled=1 ORDER BY sort_order, id"
    ).all();
    const rows = (
      (res.results || []) as { slug: string; name: string; kind: string; models?: unknown }[]
    ).map(function (r) {
      return { slug: r.slug, name: r.name, kind: r.kind, models: modelList(r) };
    });
    return json({ rows: rows, approved: hasService(user, env, "relay") });
  } catch (e: any) {
    return json({ error: "query-failed", detail: String((e && e.message) || e) }, 500);
  }
}
