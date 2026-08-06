# Production report — real numbers from a small, real deployment

> Written 2026-07-17 for the v2.0.0 release, following the method fixed in
> [REPORT-SKELETON.md](./REPORT-SKELETON.md). Data source: production D1
> (`req_log` / `visits`; queries listed at the bottom for reproducibility).
> **This is a personal site with a handful of users — the numbers are small and
> reported honestly.** The point is the *measurement machinery*, not the scale.
>
> **Appended 2026-07-31 (v2.6.0):** a streaming-CPU section measured in production with
> `wrangler tail`. It is appended rather than merged because the v2.0.0 numbers above are
> still what they were — a report that silently rewrites itself is not a report.

## Window

Site live since **2026-07-06** (11 days at time of writing). LLM metering
(`req_log`) live since **2026-07-14** (3 days of request data). 90-day rolling
retention; `usage_daily` (migration 0003) preserves aggregates beyond that.

## Traffic

| metric | value |
|---|---|
| page views (11 days) | 1,355 |
| unique IPs | 161 |
| busiest day | 2026-07-15 (201 views) |
| quietest day | 2026-07-10 (46 views) |

## LLM requests (playground, 2026-07-14 → 2026-07-16)

| metric | value |
|---|---|
| requests | 10 (all `svc=pg`; relay had no member traffic in this window) |
| error rate | **0 / 10** (0%) |
| model | `gemini-3.1-flash-lite` (single channel configured) |
| tokens | 1,525 in / 2,405 out (upstream-reported) |

### Latency (n=10 — treat as anecdote, not distribution)

| percentile | TTFB (ms) | total duration (ms) |
|---|---|---|
| p50 | 502 | 761 |
| p95 | 704 | 3,725 |

Reading it the way the skeleton prescribes: **TTFB is tight** (419–704 ms —
upstream responsiveness plus one edge hop), while **total duration spreads with
output length** (the 3.2 s / 3.7 s outliers are simply longer generations, not
slowness). This is exactly the pattern the pump architecture predicts: the
worker adds no buffering, so total time ≈ upstream generation time.

### Cost shape (estimated)

At the provider's public list price for this model class (illustrative
$0.10 / $0.40 per M tokens in/out — set your own in `model_prices`):

> 1,525 × $0.10/M + 2,405 × $0.40/M ≈ **$0.0011 for the window** — effectively
> zero. The machinery matters at scale: `/logs` now shows per-channel and
> per-member estimated cost live, and `unpriced_models` nags about anything
> missing a price row.

## Reliability observations

- `errlog` total since launch: **5 rows** (OAuth experiments and one CSP
  violation sample during development — none from the relay/playground path).
- The v2 quota path (Durable Object) has served every counted request since
  2026-07-17 with zero `quota.do` degradation entries — the D1 fallback has
  never fired in production.
- Daily cron (rollup + backup + purge) and 5-minute alert scan report into
  `settings.cron_last_*`; first live runs verified 2026-07-17.

## Synthetic load test — local, **not** production traffic (added 2026-07-22)

Everything above is production data. This section is not: it is `wrangler dev` on a
desktop, driven by [`tools/loadtest.mjs`](../tools/loadtest.mjs) against
[`tools/mock-upstream.mjs`](../tools/mock-upstream.mjs). It is labelled separately
because mixing synthetic numbers into a production report is how reports start lying.

**Why it exists:** the rate limiter's only prior evidence was
`test/unit/rate-limiter.test.ts` — 30 in-process calls through `Promise.all`. That test
proves the *method body* never interleaves (no `await` inside `check()`), which is the
crux of ADR-0007. It does **not** prove the property survives 200 separate HTTP
connections, each carrying a router dispatch, a key lookup, a D1 read and a DO RPC
round-trip. Those are exactly the layers where a concurrency claim usually dies.

### Rate limiter under real HTTP concurrency

200 requests fired without waiting for any response, one member, `rl_per_min = 30`:

| outcome | count |
|---|---|
| `200` (allowed) | **30** |
| `429` (limited) | **170** |

Exactly the limit, never one more — the DO's single-threaded `check()` holds under real
concurrency, and blocked requests do not consume quota (`check()` increments only on the
allow path). Re-run with `node tools/loadtest.mjs`.

### Gateway overhead (n=400, upstream delay subtracted)

The mock upstream sleeps a fixed 25 ms, so `total − 25 ms` isolates what this worker
costs: auth, quota DO, channel lookup, header rewrite, and the metering pump.

| p50 | p95 | p99 | min | max |
|---|---|---|---|---|
| 36.5 ms | 49.7 ms | 56.1 ms | 22.3 ms | 69.4 ms |

**Read these as an upper bound on a bad day, not as production latency.** `wrangler dev`
runs a local workerd with none of the edge's warm-isolate advantages, D1 is a local SQLite
file rather than the managed service, and client, gateway and upstream share one machine's
CPU. The production TTFB table above (p50 502 ms including a real upstream) is the number
that describes reality. What this table is good for is *relative* comparison — re-run it
after changing the request path and see which direction it moves.

### Parse-side CPU (`tools/bench-sse.mjs`)

Reproduces ADR-0011 on demand: 5,982 synthetic deltas at 184 bytes each, full `JSON.parse`
versus `fastDelta`, with a correctness check that both paths emit byte-identical text
before any timing is reported. On the author's desktop the fast path is ~1.5× faster and —
the more interesting column — triggers **zero GC events** where the full parse triggers
several. That is ADR-0011's "allocation is billed twice" claim made visible: the fast path
allocates one string instead of an object tree, so there is nothing to collect.

## Streaming CPU in production (v2.6.0, measured 2026-07-31)

Production data again, and the only measurement in this document that could not be obtained
from D1: **exceeding the 10 ms CPU budget produces no application-visible evidence at all** —
the isolate is killed, the browser sees a stream stop mid-sentence, and not even a `req_log`
row survives. `wrangler tail --format json` is the only instrument that reports it.

Method: same prompt, same model, same channel; arms spaced ~30 s apart so the free plan's
elastic CPU allowance could not carry over between runs.

### Where the cost actually is (the measurement that decided ADR-0014/0015)

| arm | how the response body is delivered | chunks | wall | **CPU** |
|---|---|---|---|---|
| transform | JS reads + parses + writes batched events | ~3,000 | 20.3 s | **626 ms** |
| `new TransformStream()` + `pipeTo` | JS-backed pipe | 3,683 | 23.9 s | **1,001 ms** |
| `IdentityTransformStream` + `pipeTo` | native pipe | 3,068 | 20.8 s | **5 ms** |
| `new Response(resp.body)` | native passthrough | 5,422 | 33.4 s | **4 ms** |

The cost is **JS touching the bytes**, not how often we flush. Row 2 is the one worth
keeping: the obvious implementation is *worse than doing nothing*, and it looks correct in
review, in tests, and in the local bench.

### After moving the transform into a Durable Object

| invocation | CPU | budget | % of budget |
|---|---|---|---|
| Worker `POST /api/playground/chat` | **3 ms** | 10 ms | 30 % |
| Durable Object `PgStream` | **663 ms** | 30,000 ms | **2.2 %** |

Same work, relocated rather than removed: 6,260 % of budget → 2.2 % of budget, with
sanitation, server-side persistence, token accounting and background continuation all still
running ([ADR-0015](./adr/0015-durable-object-streaming.md)).

### The number that replaced it as the binding constraint

CPU is no longer the ceiling; **Durable Object duration billing** is. Free tier is
13,000 GB-s/day and a DO holds 128 MB, so a 20-second stream costs 20 × 0.125 = 2.5 GB-s —
roughly **5,200 streams/day**. Two things follow that did not apply to the CPU limit:

- it is billed on **wall time**, so a slow model costs more than a fast one for identical
  output — the constraint moved from *how much the model says* to *how long it takes*;
- it is **not measured anywhere yet** (DEBT #33). `req_log.dur_ms` already contains
  everything needed: `SELECT SUM(dur_ms)/1000.0*0.125 FROM req_log WHERE svc='pg' AND ts>=…`
  is the estimate, and the threshold to start watching is a daily total near 8 hours.

### Method note — why the local bench is not in this section

`npm run bench` measures the parse path in isolation on a desktop and **under-reports by
roughly 95×** against production: no HTTP/2 framing, no TLS, no socket, no shared CPU. It is
kept because it is reproducible and directionally right (it proved the fast path is
allocation-free), but every number above came from the edge. Conflating the two is how the
pre-v2.5 conclusion "4.2 ms, plenty of headroom" survived for a week while production was
spending 626 ms.

## Caveats (as promised by the skeleton)

n=10 supports no statistical claim — the percentile table demonstrates the
reporting pipeline works end-to-end (raw `dur_ms` → client-side percentiles →
this document), not a latency benchmark. Token counts are upstream-reported.
Cost is an estimate (tokens × admin-maintained prices), not a bill. Single
region D1; the operator and most visitors are in Taiwan (`colo` mostly TPE).

## Reproduce

```sql
-- traffic
SELECT COUNT(*), COUNT(DISTINCT ip), MIN(ts) FROM visits;
SELECT substr(ts,1,10) d, COUNT(*) FROM visits GROUP BY d ORDER BY d;
-- llm requests
SELECT svc, COUNT(*), SUM(CASE WHEN status>=400 OR status=0 THEN 1 ELSE 0 END),
       SUM(tokens_in), SUM(tokens_out) FROM req_log GROUP BY svc;
SELECT dur_ms, ttfb_ms FROM req_log WHERE dur_ms IS NOT NULL ORDER BY dur_ms;
```
or `GET /api/admin/stats?days=30` (admin) — the same numbers the `/logs` usage
tab renders.

---

**中文摘要**：這是 v2.0.0 發佈時（2026-07-17）用正式站真實數據寫的報告 — 個人站、
用戶數一隻手數得完，**數字小但誠實**；重點是量測管線而非規模。上線 11 天 1,355 次瀏覽、
161 個不重複 IP。LLM 計量 3 天窗口：10 次請求、0 錯誤、tokens 1,525/2,405；
TTFB p50 502ms／p95 704ms 很緊，總耗時 p95 3.7s 是輸出長度拉的 — 正是 pump 架構
預測的形狀（worker 不緩衝，總時長≈上游生成時長）。估算成本 ≈ $0.0011（示意單價）。
n=10 不構成統計主張 — 展示的是「原始值→百分位→報告」這條管線全通。
2026-07-22 新增一節**本機合成壓測**（與正式數據分開標示，不混在一起講）：200 條真 HTTP
併發打限流器，恰好 30 個過、170 個 429 — ADR-0007 的原子性在真併發下成立，被擋的不吃額度。
gateway overhead 扣掉上游延遲後 p50 36.5ms／p99 56.1ms，但那是 wrangler dev 的本機
workerd，要當成「壞天氣的上限」而不是正式站延遲（正式站 TTFB p50 502ms 那張表才是現實）。

2026-07-31 追加**串流 CPU** 一節（v2.6.0），是本文件唯一無法從 D1 取得的量測 ——
因為**燒穿 10ms CPU 不會留下任何應用層可見的證據**：isolate 被砍、瀏覽器看到串流講到一半
消失、連 `req_log` 都寫不進去，只有 `wrangler tail` 看得到。多臂對照（每臂間隔 30 秒，
免費方案的彈性配額才不會汙染下一輪）結論是：**成本來自「JS 有沒有碰到那些位元組」，
不是 flush 幾次** —— 而最直覺的寫法 `new TransformStream()`＋`pipeTo` 量到 1001ms，
**比什麼都不改還糟**，且它在 code review、測試、本機 bench 三關都看起來是對的。
搬進 Durable Object 之後：Worker 3ms／10ms、DO 663ms／30000ms，從預算的 6260% 變成 2.2%，
而且淨化、伺服器落地、token 記帳、背景續跑一項都沒犧牲。
**新的天花板換成 DO 的 GB-s 計費**（免費 13,000 GB-s/日 ≈ 5200 趟串流）：它按**牆鐘**計價，
所以同樣的輸出，慢的模型比快的模型貴 —— 限制從「模型講多少」變成「模型講多久」，
而這件事目前**沒有任何量測**（DEBT #33），雖然 `req_log.dur_ms` 早就夠算了。
最後補一條方法論註記：`npm run bench` 是本機孤立量測，**比線上低估約 95 倍**（沒有 HTTP/2
框架、沒有 TLS、沒有 socket），留著是因為可重現且方向正確，但上面每個數字都來自邊緣。
把兩者混為一談，正是「4.2ms，還很寬裕」這個結論能撐一個星期、而線上其實在花 626ms 的原因。
