// /api/admin/relay/channels — 管理員專用：API 中轉站的上游管道管理。
//   GET  列出全部管道（上游金鑰一律遮罩，只回 has_key 與提示）
//   POST 新增管道 { slug, name, kind, base_url, api_key?, enabled? }
// kind：openai（OpenAI 與所有 OpenAI 相容服務，含本地 AI）/ anthropic / gemini / custom。
// custom 與 openai 的差別只在顯示，驗證方式同樣是 Authorization: Bearer。
import { json, SLUG_RE } from "../../../../../lib/site.js";
import { adminOk, keyHint, randToken } from "../../../../../lib/auth.js";
import { audit } from "../../../../../lib/observe.js";
import type { RouteCtx } from "../../../../../types.js";

export const KINDS: Record<string, number> = { openai: 1, anthropic: 1, gemini: 1, custom: 1 };

// 模型名稱規則：英數開頭，之後允許英數與 . _ / : -（涵蓋 gpt-4o、models/gemini-2.5、accounts/…/models/…）
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._/:-]{0,119}$/;

export type CleanModelsResult = { list: string[]; err?: undefined } | { err: string; list?: undefined };

// models 欄位（字串用逗號／換行分隔，或直接給陣列）→ 去重陣列；回 { list } 或 { err }
export function cleanModels(v: unknown): CleanModelsResult {
  const arr = Array.isArray(v) ? v : String(v == null ? "" : v).split(/[\n,]/);
  const out: string[] = [];
  for (let i = 0; i < arr.length; i++) {
    const s = String(arr[i] == null ? "" : arr[i]).trim();
    if (!s) continue;
    if (!MODEL_RE.test(s))
      return { err: "模型名稱「" + s.slice(0, 40) + "」含不允許的字元（限英數與 . _ / : -）" };
    if (out.indexOf(s) < 0) out.push(s);
    if (out.length > 40) return { err: "模型太多了（一個渠道上限 40 個）" };
  }
  return { list: out };
}

export function modelList(r: { models?: unknown } | null | undefined): string[] {
  return String((r && r.models) || "")
    .split(",")
    .map(function (s) {
      return s.trim();
    })
    .filter(Boolean);
}

// 名稱 → 自動網址代稱：能轉英數就用名稱（gemini official → gemini-official），
// 轉不出來（中文名等）就給隨機代稱。管理員介面 2026-07-14 起不再要求填 slug。
export function autoSlug(name: string): string {
  let s = String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
    .replace(/-+$/, "");
  if (!SLUG_RE.test(s)) s = "";
  return s || "ch-" + randToken("", 6);
}

// 整理後的管道欄位。api_key 缺席（undefined）＝「保留舊值」；slug 缺席＝POST 自動產生、PUT 保留舊值。
export interface RelayChannelInput {
  slug?: string;
  name: string;
  kind: string;
  base_url: string;
  models: string;
  system_prompt: string;
  extra_body: string;
  vision_models: string;
  enabled: number;
  api_key?: string;
}
export type CleanRelayChannelResult =
  { ch: RelayChannelInput; err?: undefined } | { err: string; ch?: undefined };

// 欄位整理：回 { ch } 或 { err }。models 必填（新增渠道時就要先把模型名稱設定好）。

export function cleanChannel(b: any): CleanRelayChannelResult {
  if (!b || typeof b !== "object") return { err: "需要 JSON 本體" };
  const slugRaw = String(b.slug == null ? "" : b.slug)
    .trim()
    .toLowerCase();
  let slug: string | undefined;
  if (slugRaw) {
    if (!SLUG_RE.test(slugRaw)) return { err: "slug 只能用小寫英數與連字號（頭尾不能是連字號）" };
    slug = slugRaw;
  }
  const name = String(b.name == null ? "" : b.name)
    .trim()
    .slice(0, 60);
  if (!name) return { err: "名稱不能是空的" };
  const kind = KINDS[b.kind] ? b.kind : "openai";
  const base = String(b.base_url == null ? "" : b.base_url)
    .trim()
    .replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s]+$/.test(base)) return { err: "base_url 要是 http(s):// 開頭的網址" };
  const m = cleanModels(b.models);
  if (m.err !== undefined) return { err: m.err };
  if (!m.list.length) return { err: "至少要填一個模型名稱（一行一個）" };
  // Playground 系統提示詞（選填，只作用在 /playground — /relay 中轉不讀）。
  // 太長「退回」而不是像 name 那樣默默 slice：這欄是人一字一句寫的，
  // 悄悄砍掉尾巴會讓提示詞語意壞掉、而且完全查不出原因。
  const sysPrompt = String(b.system_prompt == null ? "" : b.system_prompt).trim();
  if (sysPrompt.length > 8000)
    return { err: "系統提示詞太長（上限 8000 字，目前 " + sysPrompt.length + " 字）" };
  // 額外請求參數（選填）：合併進 playground 送給上游的請求本體，處理各家專屬參數。
  // 存檔當下就驗合法性 — 讓錯誤在管理員按「儲存」時就跳出來，
  // 而不是等某個會員去聊天才發現整條上游請求壞掉、還不知道為什麼。
  const extraBody = String(b.extra_body == null ? "" : b.extra_body).trim();
  if (extraBody.length > 4000) return { err: "額外請求參數太長（上限 4000 字）" };
  if (extraBody) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(extraBody);
    } catch (e: any) {
      return { err: "額外請求參數不是合法 JSON：" + String((e && e.message) || e) };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return { err: "額外請求參數要是 JSON 物件（{ … }），不能是陣列或單一數值" };
  }
  // 吃得下圖片的模型（選填，migration 0007）。必須是 models 的子集 —— 填了一個沒開放的
  // 模型名，多半是打錯字，而後果是會員按了附件鈕、送出才被上游打回來。
  // 這種錯誤要在管理員按「儲存」的當下就講清楚，不要留到會員踩到。
  const vm = cleanModels(b.vision_models);
  if (vm.err !== undefined) return { err: vm.err };
  for (const one of vm.list) {
    if (m.list.indexOf(one) < 0) {
      return { err: "視覺模型「" + one + "」不在這個渠道的模型清單裡 — 請先把它加進上面的模型欄位" };
    }
  }
  const ch: RelayChannelInput = {
    slug: slug,
    name: name,
    kind: kind,
    base_url: base.slice(0, 300),
    models: m.list.join(","),
    system_prompt: sysPrompt,
    extra_body: extraBody,
    vision_models: vm.list.join(","),
    enabled: b.enabled === false || b.enabled === 0 ? 0 : 1
  };
  if (b.api_key !== undefined)
    ch.api_key = String(b.api_key == null ? "" : b.api_key)
      .trim()
      .slice(0, 500);
  return { ch: ch };
}

export function maskRow(r: any) {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    kind: r.kind,
    base_url: r.base_url,
    models: modelList(r),
    system_prompt: r.system_prompt || "", // 管理員專用端點才回這欄；會員的 /api/relay/channels 是指定欄位 SELECT，不會外洩
    extra_body: r.extra_body || "", // 同上，只有管理員看得到
    // 陣列形式（跟 models 一致）—— 管道視窗的 textarea 直接 join("\n") 就能顯示
    vision_models: String(r.vision_models || "")
      .split(",")
      .map(function (s: string) {
        return s.trim();
      })
      .filter(Boolean),
    enabled: r.enabled,
    created_at: r.created_at,
    has_key: !!r.api_key,
    key_hint: r.api_key ? keyHint(r.api_key) : ""
  };
}

export async function onRequestGet({ request, env }: RouteCtx): Promise<Response> {
  const url = new URL(request.url);
  if (!(await adminOk(request, env, url))) return json({ error: "unauthorized" }, 401);
  if (!env.DB) return json({ error: "no-db" }, 500);
  try {
    const res = await env.DB.prepare("SELECT * FROM relay_channels ORDER BY id").all();
    return json({ rows: (res.results || []).map(maskRow) });
  } catch (e: any) {
    return json({ error: "query-failed", detail: String((e && e.message) || e) }, 500);
  }
}

export async function onRequestPost(context: RouteCtx): Promise<Response> {
  const { request, env } = context;
  const url = new URL(request.url);
  if (!(await adminOk(request, env, url))) return json({ error: "unauthorized" }, 401);
  if (!env.DB) return json({ error: "no-db" }, 500);

  let body: any = null;
  try {
    body = await request.json();
  } catch (e) {}
  const c = cleanChannel(body);
  if (c.err !== undefined) return json({ error: "bad-input", hint: c.err }, 400);

  // 沒帶 slug＝自動產生；自動產生撞名就補隨機尾碼重試（手動指定的照樣回 409 讓人自己改）
  const explicit = !!c.ch.slug;
  let slug = c.ch.slug || autoSlug(c.ch.name);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await env.DB.prepare(
        "INSERT INTO relay_channels (slug,name,kind,base_url,api_key,models,system_prompt,extra_body,vision_models,enabled,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)"
      )
        .bind(
          slug,
          c.ch.name,
          c.ch.kind,
          c.ch.base_url,
          c.ch.api_key || "",
          c.ch.models,
          c.ch.system_prompt,
          c.ch.extra_body,
          c.ch.vision_models,
          c.ch.enabled,
          new Date().toISOString()
        )
        .run();
      // 稽核 summary 絕不含金鑰本體，只記「有沒有設」
      audit(
        env,
        function (p) {
          context.waitUntil(p);
        },
        request,
        "relay.channel.create",
        slug,
        c.ch.name + " kind=" + c.ch.kind + " base=" + c.ch.base_url + " 金鑰:" + (c.ch.api_key ? "有" : "無")
      );
      return json({ id: r.meta.last_row_id, slug: slug, url: "/relay/" + slug });
    } catch (e: any) {
      const msg = String((e && e.message) || e);
      if (msg.indexOf("UNIQUE") >= 0) {
        if (explicit) return json({ error: "slug-taken", hint: "slug「" + slug + "」已有管道在用" }, 409);
        slug = (autoSlug(c.ch.name) + "-" + randToken("", 4)).slice(0, 64);
        continue;
      }
      return json({ error: "insert-failed", detail: msg }, 500);
    }
  }
  return json({ error: "slug-taken", hint: "自動產生代稱一直撞名，請改個名稱再試" }, 409);
}
