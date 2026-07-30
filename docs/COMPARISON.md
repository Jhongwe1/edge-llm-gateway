# Comparison / 誠實對照

> How uaip's relay relates to the established LLM-gateway projects. This is not a
> "we win" table — those tools are mature, multi-maintainer, and solve problems uaip
> deliberately doesn't. The point is to be clear about **what the zero-server, zero-dependency,
> single-D1 architecture buys and what it gives up.**

## The field

| | **uaip /relay** | **one-api / new-api** | **LiteLLM** | **OpenRouter** | **Cloudflare AI Gateway** |
|---|---|---|---|---|---|
| Shape | 1 Worker + 1 D1 + 1 DO | Go server + MySQL/Redis | Python proxy + DB | Hosted SaaS | Managed edge in front of your keys |
| Deploy | `wrangler deploy` | container + DB | container/pip + DB | nothing (it's hosted) | dashboard config |
| Multi-provider | OpenAI/Anthropic/Gemini/OpenAI-compat | very broad | very broad (100+) | very broad | broad |
| Key model | shared upstream keys | shared, with billing/tokens | BYOK or shared | their keys, you top up | your keys |
| Routing/failover | none (one channel = one upstream) | load-balance, retries | load-balance, fallbacks, retries | automatic | caching, some fallback |
| Billing/credits | none — quotas enforce **request counts**; tokens are priced for *reporting* only | full credit system | usage tracking, budgets | real credits/pricing | usage analytics |
| Metering | req_log rows, p50/p95, tokens, estimated USD | extensive | extensive | dashboards | dashboards |
| Portal/CMS/members | **yes, integrated** | admin UI only | no | no | no |
| Runtime deps | **zero** | many | many | n/a | n/a |
| Self-hosted & fully owned | **yes** | yes | yes | no | no (Cloudflare) |

> Architecture note: this table said "Pages Functions + `wrangler pages deploy`" until
> 2026-07-22 — nine months out of date relative to the code, which moved to a single Worker
> on 2026-07-16 ([ADR-0006](./adr/0006-pages-to-workers.md)). It was caught by an audit,
> not by a reader, which is exactly the problem with prose that nothing verifies. The
> test-count claim below and the two rows above are now asserted in CI by
> `tools/check-docs.mjs` — the Shape row must say Worker and the Deploy row must say
> `wrangler deploy`, or the build fails.

## What they have that uaip does not

- **BYOK** (LiteLLM): members bringing their own keys removes the operator's cost liability
  entirely. uaip chose shared-keys-plus-quotas instead (ADR-0003); BYOK is deferred (DEBT #3).
- **Routing & failover** (one-api, LiteLLM, OpenRouter): load-balancing across keys,
  automatic fallback to a second provider, retry policies. uaip has none — one channel maps
  to exactly one upstream; if it's down, the request fails (logged, but not retried).
- **Billing in money** (OpenRouter, one-api): real credit systems with per-model pricing,
  where running out of credit stops the request. uaip *does* price tokens — `model_prices`
  turns them into estimated USD per channel and per member in the dashboards (DEBT #10,
  half-settled) — but pricing is **reporting, not enforcement**: quotas still count
  requests, so a member with an expensive model burns more money for the same quota.
  That asymmetry is a deliberate trade-off, not an oversight; it becomes wrong the moment
  the operator's bill is driven by model choice rather than request volume.
- **Provider breadth** (LiteLLM's 100+): uaip speaks three native shapes plus OpenAI-compat.
  Anything OpenAI-compatible works; exotic providers don't without code.
- **Operational maturity**: these are multi-maintainer projects with issue trackers, plugins,
  and years of edge cases handled. uaip is one person's site.

## What the uaip architecture buys in return

- **Zero servers, zero runtime dependencies.** Nothing to patch, no CVE feed to watch, no
  container registry, no DB to operate. Cold starts are edge-fast because there's no framework
  to boot (ADR-0001).
- **One database, one mental model.** Members, sessions, channels, metering, audit and the
  entire content portal are joinable in one query and back up as one file (ADR-0002).
- **Gateway *and* portal in one system.** The relay isn't a standalone proxy bolted next to a
  website — it shares identity, session, member approval, quota and audit with the news CMS,
  the playground and the VPN service. A member is approved once; every service reads the same
  `services` grant.
- **Fully owned, fully readable.** Every line that runs in production is in this repo and
  reviewable in an afternoon. No hosted dependency can change pricing, deprecate an endpoint,
  or read the traffic.
- **Honest engineering evidence.** 572 tests in the real runtime, a threat model, thirteen
  ADRs, a two-round security audit that reports its own first-round miss rate, and this
  comparison — the artifact is meant to be defensible, not just functional.

## Honest verdict

If you need routing, failover, billing, or 100 providers, **use LiteLLM or one-api** — uaip
isn't trying to replace them. uaip's niche is: *one person wants to give a handful of trusted
people gated access to a few LLM providers, plus a VPN and a website, on free-tier edge
infrastructure they fully own and can reason about end-to-end.* For that, a ~10k-line
zero-dependency codebase you understand completely beats a feature-rich server you operate but
don't.

---

**中文摘要**：這不是「我們贏」的表。one-api／LiteLLM／OpenRouter／AI Gateway 都成熟、
多人維護，解的是 uaip 刻意不解的問題（BYOK、路由容錯、真實計費、上百家供應商廣度）。
uaip 的架構換到的是：零伺服器零依賴、一顆 D1 一個心智模型、中轉與門戶／會員／配額／
稽核一體、全碼自持可審、可論述的工程證據（572 條測試＋威脅模型＋13 份 ADR＋
會自報漏檢率的兩輪稽核）。**計價只做報表、不做執法**：配額算的仍是「次數」，
所以同一個額度下用貴模型就是燒比較多錢 —— 那是刻意的取捨，不是漏做。
需要路由／容錯／計費／百家供應商 → 用 LiteLLM 或 one-api；uaip 的定位是「一個人想在
自己完全掌握的免費邊緣基建上，給少數信任的人閘門化的 LLM＋VPN＋網站」。
