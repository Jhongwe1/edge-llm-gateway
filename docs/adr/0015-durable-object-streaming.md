# ADR-0015: Move the streaming transform into a Durable Object — don't delete it

**Status**: accepted · **Date**: 2026-07-31 · **Supersedes** [ADR-0014](0014-native-passthrough-streaming.md)
(shipped and withdrawn the same day) · **and the CPU strategy in** [ADR-0011](0011-streaming-cpu-budget.md)
· **Repays** DEBT #13, #16 · **dissolves** DEBT #28–32

## Context

The free Workers plan gives **10 ms of CPU per invocation**. Since v2.1 the Playground has
read every upstream SSE chunk into JS, parsed it, merged deltas and written a unified event
stream back to the browser. ADR-0011 made that loop as cheap as it can be — batching
flushes, and a regex fast path that skips `JSON.parse` on the common shape.

It was not enough. Long answers still blew the limit: the isolate was killed mid-stream,
the browser saw a silent truncation, and nothing reached D1 — not even a `req_log` row.

An online multi-arm measurement (`wrangler tail --format json`, arms spaced ~30 s apart so
the free plan's elastic allowance couldn't contaminate the next run) settled where the cost
actually is:

| arm | how the body is delivered | chunks | wall | **CPU** |
|---|---|---|---|---|
| transform | JS reads + parses + batched writes | ~3000 | 20.3 s | **626 ms** |
| `new TransformStream()` + `pipeTo` | JS-backed pipe | 3683 | 23.9 s | **1001 ms** |
| `IdentityTransformStream` + `pipeTo` | native pipe | 3068 | 20.8 s | **5 ms** |
| `new Response(resp.body)` | native passthrough | 5422 | 33.4 s | **4 ms** |

The cost is **JS touching the bytes at all** — not how many times we flush. 626 ms is 62×
the Worker budget. Two designs follow from that number, and they are opposites.

### The design this ADR reverses: native passthrough ([ADR-0014](0014-native-passthrough-streaming.md))

Hand the upstream body straight to the browser and let the runtime pump it. That shipped as
v2.5.0 and was withdrawn the same day. It works — 626 ms → 6 ms, verified in production —
but it buys the CPU win by **deleting the transform**, and the transform was doing four jobs:

1. **`safeHint()` sanitation.** Raw upstream chunks carry `"model":"<real name>"` in every
   frame; OpenRouter adds `provider`, Groq adds `x_groq`, Venice appends `cost:{usd,diem}`
   to the final frame. Passthrough puts all of it in front of the member. Hiding the
   upstream was never a security boundary (`lib/playground.ts` says so — the real
   protection is that members never get `base_url` or the key), but it *was* an intent,
   and passthrough cancels it architecturally rather than by choice.
2. **Server-side persistence.** If the Worker cannot see the reply, only the client can
   save it — a new `POST /api/playground/chat/save` endpoint, idempotent, trusted.
3. **Server-side token accounting.** Same: relayed by the client.
4. **Background continuation** (ADR-0012). Gone entirely; replaced by `pagehide` +
   `sendBeacon`, capped at 64 KB.

A sniff-then-pipe whitelist can gate #1 at the *head* of the stream, but not fields an
upstream appends at the *end* — by then the bytes are on the wire. #2–#4 are not
recoverable at all: they are properties of the Worker not seeing the bytes.

## Decision

**Keep the transform exactly as it is. Change where it runs.**

Durable Objects get **30 seconds of CPU per incoming request — on the free plan too**; the
10 ms cap is a Worker-only limit ([DO limits][lim]). The same 626 ms goes from 6260 % of
budget to 2 % of budget, and every property above survives untouched.

```
Browser → Worker (10 ms budget)
          ├ auth · CSRF · demo gate · quota · validate      (I/O-bound)
          ├ create conversation · store user message        (I/O-bound)
          └ stub.fetch(job)  →  PgStream DO (30 s budget)
                                 ├ load images from R2, splice into upstream body
                                 ├ fetch upstream
                                 ├ transform SSE → unified events   ← the 626 ms
                                 └ persist to D1
          ← DO's Response returned verbatim — runtime moves the bytes, JS never sees them
```

The Worker keeps exactly the shape that measured 6 ms in the passthrough experiment. The
difference is that the expensive part was **relocated, not removed**.

### Why the 30 s ceiling is not the problem it sounds like

It is **CPU time, not wall time**:

> "CPU time is active processing time: not time spent waiting on network requests, storage
> calls, or other general I/O" · "No hard limit while the caller stays connected to the
> Durable Object." — [DO limits][lim]

A model that thinks for 90 seconds before emitting a token costs **zero**; that is I/O
wait. Only emitted tokens cost CPU, at ~0.2 ms/chunk measured. Saturating 30 s would take
~150,000 chunks in one reply — 50–1000× more than any real answer. The ceiling binds on
output volume, not on latency, and no realistic reply approaches it.

### Worker CPU must not scale with input either

The handoff envelope is `<job JSON on one line>\n<original request body verbatim>`.
Serializing `{job, messages}` instead would make the Worker re-stringify up to 300,000
characters of conversation — milliseconds it does not have. Appending the raw body is an
O(1) cons-string in V8, so the Worker's only size-dependent work is the one `JSON.parse` it
cannot avoid (it must validate the input and store the user message). The DO re-parses on
its own budget. Channel and model always come from the job, never from the re-parsed body —
dumb mode overrides them and the body holds what the user typed.

### Sharding: one instance per member

`idFromName("pg:u:<id>")`, matching `lib/quota.ts`'s `"u:<id>"`. A member's second message
hits an already-warm instance, and the instance lives near that member. Concurrent streams
on one instance interleave at `await` points and each incoming request gets its **own** 30 s
budget. The one accepted trade: anonymous demo traffic all bills to `demo:public` and
therefore shares a single instance. Demo volume on a personal site is negligible; shard
randomly if that ever stops being true.

### Background work inside a DO has different rules

`waitUntil` **has no effect** in a Durable Object; the object stays alive "as long as there
is ongoing work or pending I/O". That is a better guarantee than the Worker's — ADR-0012's
`waitUntil` 30-second ceiling simply does not exist here — but it has a precondition worth
stating, because it cost a test failure to find:

- **Streaming path**: the pump holds the upstream reader and the response stream. Both are
  in-flight I/O. Do not await it; it stays alive on its own.
- **Error path**: `runChat` returns a JSON error and stops. Nothing is in flight, so the
  floating `errlog` / `learnImgLimit` writes get reclaimed — observed as
  `IoContext timed out due to inactivity, waitUntil tasks were cancelled without completing`.
  Those must be awaited before returning. Losing the trace exactly when upstream failed is
  the worst possible time to lose it.

`do/pg-stream.ts` collects background promises and awaits them only when the response is
not an event stream.

## Consequences

**What we gained.** DEBT #13 is repaid: streaming CPU is no longer a function of how long
the model talks, without moving to a paid plan and without giving anything up.
`safeHint()`, server-side persistence, server-side token accounting and background
continuation all keep working unchanged — the client-side `chat/save` endpoint that
passthrough required does not exist in this design.

DEBT #16 is repaid as designed: its stated threshold was *"upgrade to Workers Paid, or move
generation into a Durable Object (ADR-0007 already depends on one) and manage the lifetime
ourselves."* The `BG` budget constants are **deliberately unchanged** in this version —
the 30-second ceiling they were sized against is gone, but widening them is a behaviour
change (more billed GB-s, longer upstream run-on after "stop") that deserves its own
decision rather than riding along with this one.

**What it costs.**

- **One extra hop.** Worker → DO adds a few ms of latency before the upstream call. Against
  a TTFB dominated by the model, this is not observable; a member's *second* message hits a
  warm instance and pays less.
- **DO duration billing.** Free tier is 100,000 requests/day and **13,000 GB-s/day**
  ([pricing][pri]). A DO holds 128 MB, so a 20-second stream costs 20 × 0.125 = 2.5 GB-s →
  roughly **5,200 streams/day** inside the free tier. Well clear of this site's volume, but
  it is a new resource that can run out, and unlike CPU it is billed on wall time — a slow
  model costs more than a fast one.
- **A second place where "is it live?" can be wrong.** Deployment drift between the Worker
  and the DO class is now possible. The handoff is wrapped in try/catch: if the stub cannot
  be reached the request falls back to running in the Worker and writes an `errlog` row.

**Escape hatch.** `settings.pg_do='0'` restores v2.4 behaviour site-wide with no deploy —
same convention as `quota_do='0'` (ADR-0007) and `relay_meter`. Removing the `PG_STREAM`
binding does the same thing. Both paths run the **same** `lib/pgchat.ts`, so the fallback is
a degradation (long replies hit the 10 ms wall again), never a different behaviour — and
the existing test suite, which runs the Worker path, is therefore covering the DO path's
logic too.

## Alternatives rejected

- **Native passthrough** — [ADR-0014](0014-native-passthrough-streaming.md), which this ADR
  supersedes. 4–6 ms and genuinely elegant, but see Context: it buys the win by deleting the
  transform, and takes sanitation, server-side persistence, token accounting and background
  continuation with it. Worth revisiting only if the DO's duration billing ever becomes the
  binding constraint — ADR-0014 is kept in the repo rather than deleted precisely so that
  option stays documented, along with its three hard-won workerd streaming traps.
- **`tee()` the body: pipe one branch, read the other for persistence.** Keeps the
  features, but the JS branch still touches every chunk — which *is* the cost.
- **Loosen the flush thresholds.** Shipped once on the per-flush theory and rejected by the
  owner in production: jumpier UI, no CPU improvement. The `new TransformStream()` result
  explains why — the cost is not how many times we write.
- **Workers Paid ($5/mo, 30 s CPU).** Still the honest answer if this ever needs to work
  without a DO. It buys the same 30 s that the DO already provides for free here.
- **Run the whole handler in the DO, including auth.** Would drop Worker CPU further, but
  moves CSRF/session/quota logic — the security-critical, well-tested part — across a
  boundary for a few ms that are not the constraint.

[lim]: https://developers.cloudflare.com/durable-objects/platform/limits/
[pri]: https://developers.cloudflare.com/durable-objects/platform/pricing/
