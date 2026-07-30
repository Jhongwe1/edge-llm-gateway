# ADR-0014: Stream passthrough — sniff the head, then let the runtime pump the rest

**Status**: ~~accepted~~ **superseded by [ADR-0015](0015-durable-object-streaming.md)** (2026-07-31, same
day) · **Date**: 2026-07-31 · **Superseded the approach in** [ADR-0011](0011-streaming-cpu-budget.md)

> **Why this was reversed within a day.** The measurements below are correct and the
> implementation worked — 626 ms → 6 ms, verified in production. It was withdrawn because of
> what it *cost*, which this document argued was tolerable and the owner judged was not:
> passthrough puts raw upstream bytes in front of the member, so `safeHint()`'s sanitation is
> bypassed by the architecture rather than by choice, and the server can no longer see the
> reply — which moved persistence and token accounting to the client and deleted background
> continuation (ADR-0012) outright.
>
> ADR-0015 keeps the same goal and pays for it differently: **the transform is not deleted,
> it is relocated** into a Durable Object, where the CPU budget is 30 s instead of 10 ms.
>
> **Everything below stays accurate and is worth reading**, in particular the arm-by-arm CPU
> table and the three workerd streaming traps (`new TransformStream()` is JS-backed and
> *slower* than doing nothing; `void write()` + `releaseLock()` silently drops a chunk on a
> standard TransformStream; `await`-ing that write deadlocks). Those cost real measurement
> time to find and apply to anyone touching streams on Workers.

## Context

The free Workers plan gives **10 ms of CPU per invocation**. Since v2.1 the Playground
has read every upstream SSE chunk into JS, parsed it, merged deltas and written a unified
event stream back to the browser. ADR-0011 made that loop as cheap as it can be — batching
flushes, and a regex fast path that skips `JSON.parse` on the common shape.

It was not enough. Long answers — and especially the multi-image, multi-turn requests the
site owner reported — still blew the limit: the isolate was killed mid-stream, the browser
saw a silent truncation, and nothing reached D1. Not even a `req_log` row.

Two competing explanations survived every measurement we had (see the header of
`test/bench/stream.bench.ts`): cost-per-flush and cost-per-delta. They imply opposite
fixes, and a flush-threshold change shipped on the per-flush theory was rejected by the
owner in production — worse UX, no improvement. **The local workerd bench could not settle
it either: it under-reports by ~95×, because it has no HTTP/2 framing, no TLS, no socket.**

The question underneath both theories: does the JS side have to touch the bytes at all?

## The measurement that decided it

Five arms, same prompt, same upstream model, spaced ~30 s apart so the free plan's elastic
allowance couldn't contaminate the next run. CPU read from `wrangler tail --format json`:

| arm | how the body is delivered | chunks | wall | **CPU** |
|---|---|---|---|---|
| transform | JS reads + parses + batched writes (v2.4) | ~3000 | 20.3 s | **626 ms** |
| `std` | `new TransformStream()` + `pipeTo` | 3683 | 23.9 s | **1001 ms** |
| `pipe` | `new IdentityTransformStream()` + `pipeTo` | 3068 | 20.8 s | **5 ms** |
| `sniff` | read 1 chunk in JS, then as `pipe` | 7895 | 51.5 s | **6 ms** |
| `raw` | `new Response(resp.body)` | 5422 | 33.4 s | **4 ms** |

Two facts fall out, and only one of them was expected:

1. **A native pipe makes CPU independent of stream length.** The `sniff` arm pushed 43×
   more chunks over 2.5× more wall time than the transform arm and spent 1 % of the CPU.
2. **`new TransformStream()` is not a native pipe.** It is JS-backed: every chunk crosses
   into JS and back. Writing the obvious thing would have made v2.5 **worse than doing
   nothing** (1001 ms vs 626 ms) while looking completely correct in review and in tests.
   Only `IdentityTransformStream` — Cloudflare's byte-oriented, natively implemented
   variant — gets the win.

The reported failure case — four 1.4 MB images plus a long prompt — was measured the same
way after shipping: **615 ms on the transform path, 59 ms on passthrough.** The residual
59 ms is not streaming; a text-only passthrough request costs 5–6 ms. It is the *request*
side: reading four objects out of R2 and splicing 5.75 MB of base64 into the upstream body.
That cost is proportional to image bytes and is paid once, before the stream starts — it is
what `pg_img_total_kb` governs (ADR-0011), and passthrough does not address it. What v2.5
removes is the part that grew with how long the model talks.

A third fact showed up in local testing, and it is a silent-data-loss trap:
on a standard `TransformStream`, `void writer.write(x)` followed by `releaseLock()`
**drops `x` without an error**. The rest of the stream is fine; only that chunk vanishes.
On `IdentityTransformStream` the same pattern is ordered and safe. (`await`-ing the write
instead deadlocks: nothing is reading yet, so backpressure never clears.)

## Decision

**Sniff the first chunks in JS; if the shape is clean, hand the rest to the runtime.**

```
read ≤3 chunks → verdict
  ok      → IdentityTransformStream: write our {conv} prefix + replay the sniffed bytes,
            releaseLock, resp.body.pipeTo(ts.writable)          ← JS never sees a byte again
  reject  → fall through to the v2.4 transform loop, seeded with the same reader,
            the same TextDecoder and the bytes already consumed
```

Passthrough requires **all** of: channel `kind` is `openai`/`custom`; upstream really
returned `text/event-stream`; not dumb mode; not demo mode; site setting `pg_passthrough`
not `'0'`; and the sniff verdict is `ok`. Anything else — including "not enough bytes to
decide" — takes the transform path. The expensive path is always the safe default.

The sniff is a **whitelist** of top-level keys, in the same spirit as `lib/fastsse.ts`:
if in doubt, give up. `provider` (OpenRouter) and `x_groq` (Groq) name the upstream in
every single chunk, and passthrough puts raw bytes in front of the member. The whitelist
was calibrated against real traffic, not the spec — without `prompt_token_ids` (null, sent
by vLLM-family upstreams on every chunk) **no real channel would have passed**.

dumb mode and demo mode are hard blocks for the same reason: raw chunks carry
`"model":"<real name>"`, and hiding the model is the entire point of those two modes.

## Consequences

**What we gained.** The CPU ceiling stops being a function of how long the model talks.
DEBT #13 — "streaming runs right up against the 10 ms limit" — is closed for the paths that
qualify, without moving to a paid plan.

**What it costs.** The Worker cannot see the reply, so three things moved or died:

| | before | after (passthrough only) |
|---|---|---|
| reply persisted by | server | **client** (`POST /api/playground/chat/save`) |
| token usage from | upstream `usage` frame, read server-side | same frame, **relayed by the client** |
| close-the-tab behaviour | server finishes generating in the background (ADR-0012) | **gone** — `pagehide` + `sendBeacon` saves what arrived |

Losing background continuation is a real regression and is recorded as such. It is
accepted because the requests it protected are exactly the ones that were being killed
by the CPU limit — where the old behaviour delivered nothing at all.

Integrity is kept where it matters: the `req_log` row is written **before** the pipe starts,
so a client that never reports back still cannot make a request disappear (quota's D1
fallback counts those rows). The client's token numbers can only be written once, and only
onto its own row. Quota enforcement counts requests, not tokens, so under-reporting buys a
member nothing; the cost report loses some precision (DEBT).

**Residual exposure.** The sniff only sees the head of the stream. Fields an upstream
appends at the end — Venice sends `cost:{usd,diem}` alongside the final `usage` frame —
cannot be gated: by then the bytes are already on the wire. A member with devtools open can
read them. This is a property of passthrough itself, not a gap in the check. It is tolerable
here because the codebase already states that hiding the provider is *not* a security
boundary (`lib/playground.ts`) — the real protection is that members never get `base_url`
or the upstream key — but it is a genuine change in what is visible, and the owner can turn
the whole thing off with one setting if that trade is unwanted.

**Escape hatch.** `settings.pg_passthrough='0'` restores v2.4 behaviour site-wide with no
deploy — same semantics as `relay_meter` for the relay pump. Admins can also force either
path per request with `?stream=transform|passthrough` for A/B and debugging.

## Alternatives rejected

- **`tee()` the body: pipe one branch, read the other in JS for persistence.** Keeps every
  feature, but the JS branch still touches every chunk — which is the cost. Measured `std`
  (1001 ms) is what that shape looks like.
- **Loosen the flush thresholds.** Already shipped once and rejected by the owner in
  production: the UI became jumpy and CPU did not improve. The `std` result explains why —
  the cost is not dominated by how many times we write.
- **Move to Workers Paid ($5/mo, 30 s CPU).** Still the honest answer to "what if the
  transform path is needed at full length", and remains the trigger in DEBT #13 for
  anthropic/gemini channels. But it buys headroom, not a fix: at 626 ms per 20-second
  stream the old design was 60× over budget by design.
- **Trust the client for everything and skip `req_log` at stream start.** Would let a
  member erase a request from the ledger by never calling `save`.
