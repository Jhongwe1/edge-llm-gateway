// GET /api/playground/models — Playground 可選的模型清單（依渠道分組）。
// 要有 playground 服務（或管理員金鑰）；不含任何上游金鑰與網址。
// Phase K：demo 開著時，匿名訪客拿得到「demo 渠道 × 白名單模型」這一組（渠道顯示名遮成「體驗模式」，
// 不洩漏管理員取的渠道名）；demo 關 → 照舊 401。
import { json } from "../../../lib/site.js";
import { pgUser, chModels, chVisionModels, modelSeesImages, dumbCfg } from "../../../lib/playground.js";
import { isAdminUser } from "../../../lib/auth.js";
import { demoCfg } from "../../../lib/demo.js";
import type { ChannelRow, RouteCtx } from "../../../types.js";

export async function onRequestGet({ request, env }: RouteCtx): Promise<Response> {
  const url = new URL(request.url);
  if (!env.DB) return json({ error: "no-db" }, 500);
  const who = await pgUser(request, env, url);
  if (who.err) {
    if (!request.headers.get("authorization")) {
      const cfg = await demoCfg(env);
      if (cfg.on) {
        // Dumb mode 開著時體驗模式也一起噤聲（2026-07-22）：匿名訪客同樣看不到模型選單。
        // 實際跑哪個模型由 chat.ts 用「體驗模式自己的設定」決定（見 demoLockedModel）—
        // demo 的燒錢上限綁在 demo_channel 上，不能被 dumb 的渠道蓋掉。
        {
          const dumb = await dumbCfg(env);
          if (dumb.on) {
            // 模型名不能說，但「能不能附圖」要說 —— 否則前端只能把附件鈕一律關掉
            // （多數模型不吃圖）或一律開著（送出才發現不行）。這個布林不洩漏任何身分。
            const dch = await env.DB.prepare(
              "SELECT vision_models FROM relay_channels WHERE slug=?1 AND enabled=1"
            )
              .bind(cfg.channel)
              .first<ChannelRow>();
            let dm = cfg.models[0] || "";
            if (!dm) {
              const c2 = await env.DB.prepare("SELECT models FROM relay_channels WHERE slug=?1 AND enabled=1")
                .bind(cfg.channel)
                .first<ChannelRow>();
              dm = chModels(c2)[0] || "";
            }
            return json({ demo: true, rows: [], dumb: true, vision: modelSeesImages(dch, dm) });
          }
        }
        try {
          const ch = await env.DB.prepare(
            "SELECT slug,models,vision_models FROM relay_channels WHERE slug=?1 AND enabled=1"
          )
            .bind(cfg.channel)
            .first<ChannelRow>();
          let models = ch ? chModels(ch) : [];
          if (cfg.models.length) models = models.filter((m) => cfg.models.indexOf(m) >= 0);
          const vis = chVisionModels(ch);
          return json({
            demo: true,
            rows: models.length
              ? [
                  {
                    slug: cfg.channel,
                    name: "體驗模式",
                    models: models,
                    vision: models.filter((m) => vis.indexOf(m) >= 0)
                  }
                ]
              : []
          });
        } catch (e) {
          return json({ demo: true, rows: [] });
        }
      }
    }
    return who.err;
  }
  // Dumb mode（v2.2）：非管理員一律拿不到模型清單 — 前端據 dumb:true 隱藏模型選單、
  // 送聊天時不帶 channel/model（伺服器端在 chat.ts 蓋成指定值）。
  if (!isAdminUser(who.user, env)) {
    const dumb = await dumbCfg(env);
    if (dumb.on) {
      // 同 demo 分支：模型名保密，但「能不能附圖」得讓前端知道
      const dch = await env.DB.prepare("SELECT vision_models FROM relay_channels WHERE slug=?1 AND enabled=1")
        .bind(dumb.channel)
        .first<ChannelRow>();
      return json({ rows: [], dumb: true, vision: modelSeesImages(dch, dumb.model) });
    }
  }
  try {
    const res = await env.DB.prepare(
      "SELECT slug,name,models,vision_models FROM relay_channels WHERE enabled=1 ORDER BY id"
    ).all();
    // 不回 kind：kind 等於標示真實提供商（openai/anthropic/gemini），Playground 前端也用不到
    const rows = (
      (res.results || []) as {
        slug: string;
        name: string;
        models?: unknown;
        vision_models?: unknown;
      }[]
    )
      .map(function (r) {
        const vis = chVisionModels(r);
        return {
          slug: r.slug,
          name: r.name,
          models: chModels(r),
          // 這個渠道裡吃得下圖的那幾個（前端據此決定附件鈕要不要變灰）
          vision: chModels(r).filter(function (m) {
            return vis.indexOf(m) >= 0;
          })
        };
      })
      .filter(function (r) {
        return r.models.length;
      });
    return json({ rows: rows });
  } catch (e: any) {
    return json({ error: "query-failed", detail: String((e && e.message) || e) }, 500);
  }
}
