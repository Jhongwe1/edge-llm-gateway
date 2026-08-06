# Threat Model / 威脅模型

> STRIDE analysis of every trust boundary in uaip.cc.cd. Written at **v2.0.0 (2026-07)**;
> §2.7c and §4.5–4.6 added at **v2.6.0 (2026-08)** — changelog at the end of §4.
> English first; 繁體中文在後半。Scope: the Cloudflare Workers app (worker + D1 + Durable Objects + static assets).
> Out of scope: Cloudflare platform itself, Google OAuth infrastructure, upstream LLM/VPN providers' internals.

## 1. System sketch

```
Browser ──(HTTPS)── Cloudflare Workers
  ├─ static SPA (/, /ip, /ua)            ← _headers CSP (sha256)
  ├─ SSR pages via src/lib/site.ts html() ← per-request nonce CSP
  └─ Worker routes (src/routes/)
      ├─ router.ts      visitLog() runs BEFORE dispatch → one D1 row per HTML request (§4.5)
      ├─ /auth/*        Google OAuth code flow, HttpOnly session cookie (sid hashed in D1)
      ├─ /api/*         member APIs (cookie + Origin check) / admin APIs (Bearer LOGS_TOKEN or admin cookie)
      ├─ /relay/*       LLM gateway: member key (uak-) → upstream key swap, streaming passthrough
      └─ /vpn/sub/*     subscription mirror: capability token in URL
Durable Objects — reachable ONLY through a binding, never routable from outside (§2.7c)
  ├─ RateLimiter  u:<member> · demo-ip:<ip> · demo:global · csp-ip:<ip>  atomic quota counting
  └─ PgStream     pg:u:<member>  playground SSE transform (30 s CPU); receives ch.api_key
D1 (single database): users, sessions, req_log, errlog, audit_log, visits, content tables
R2 (optional): FILES (attachments) · BACKUPS (daily JSONL — see §4.2)
Secrets: GOOGLE_CLIENT_ID/SECRET, ADMIN_EMAILS, LOGS_TOKEN (wrangler secrets)
```

## 2. Entry points × STRIDE

### 2.1 Google OAuth (`/auth/login`, `/auth/callback`)
| Threat | Analysis | Mitigation |
|---|---|---|
| **S**poofing | Forged callback / CSRF login | `state` random value pinned in HttpOnly cookie, 10-min lifetime; `redirect_uri` fixed to own origin; `aud` claim must equal our client id |
| **T**ampering | Modified id_token | Token obtained server-to-server over TLS directly from Google (no signature check needed for direct exchange); `email_verified` enforced |
| **R**epudiation | — | Login failures recorded to errlog (`oauth.callback`) |
| **I**nfo disclosure | Secrets in code | CLIENT_SECRET only in wrangler secret; never logged |
| **D**oS | Login flood | Cloudflare edge absorbs; no unauthenticated D1 writes in login path until token verified |
| **E**levation | Anyone becomes admin | Admin only via `ADMIN_EMAILS` (env) match; web UI cannot promote to the root admin set |

### 2.2 Session cookie (`ipua_sess`)
- HttpOnly + Secure + SameSite=Lax; value is 160-bit random base32.
- **D1 stores only the SHA-256 of the sid** — a database leak yields no usable cookies.
- Expiry enforced on read; expired rows purged on each login; `revoke_sessions` (admin) and `/api/account/logout-all` (self) invalidate all devices.
- CSRF: all state-changing cookie-authenticated endpoints check the `Origin` header (`goodOrigin`), allowing only own origins; `Origin: null` rejected.

### 2.3 Member API key (`uak-…`, relay)
- Displayed once at generation; D1 stores SHA-256 + display hint only.
- Format-checked (`^uak-[a-z2-7]{16,64}$`) before any DB lookup (cheap reject).
- Key accepted from Authorization/x-api-key/x-goog-api-key/?key= — all four locations are **stripped** before forwarding upstream (DROP list) and `?key=` deleted from the query string.
- Compromise blast radius: relay only, capped by per-user daily quota + rate limit; owner regenerates key (old hash dead instantly).

### 2.4 Relay passthrough (`/relay/{slug}/…`)
| Threat | Analysis | Mitigation |
|---|---|---|
| Spoofing | Using service without approval | uak- key → user row → `hasService(relay)`; blocked/pending → 403 |
| Tampering | Header smuggling to upstream | DROP regex strips connection/CF/identity headers; path segments re-encoded (`encodeURIComponent`, `:`/`@` preserved for Gemini) |
| Repudiation | "I never made those calls" | req_log row per request (user, channel, model, status, latency, tokens) |
| Info disclosure | Upstream identity/keys leaking to member | Upstream key never echoed; `set-cookie` stripped from responses; upstream error bodies pass through **as-is by design** (member-facing relay is transparent) — upstream base_url is admin-only data |
| Info disclosure | Member request bodies | Metering scans the **response** tail only; request bodies are never buffered or parsed |
| DoS / cost burn | Member floods paid upstream | Daily quota + rolling 60s rate limit (429 + Retry-After); admin exempt; client disconnect cancels the upstream read (pump, not tee) |
| Elevation | slug traversal to other origins | Target = channel.base_url (admin-configured) + re-encoded path; no user-controlled host |

### 2.5 VPN subscription (`/vpn/sub/{token}`)
- Capability token in URL (uvt-…) — inherent trade-off for VPN-app compatibility (apps can't send cookies). Token is regenerable; format-checked; blocked/pending users rejected even with valid token.
- Upstream airport URLs never appear in responses; multi-channel merge returns node lists only.
- v1.0.0: `/vpn` page is **invisible** to anyone without the vpn service (menu filtered, page serves the SPA shell, `/api/me` omits vpn fields) — see ADR-0003/plan Phase F.
- Rate: edge cache 5 min per upstream; per-user `vpn_pulls` counter.

### 2.6 Admin API (`/api/admin/*`, `/api/logs`)
- Two identities: `Bearer LOGS_TOKEN` (curl/agents) or admin session cookie (browser, Origin-checked).
- LOGS_TOKEN plaintext lives only in gitignored ADMIN.local.md; rotated at v1.0.0 release. Old value exists in git history → **must** filter-repo before the repo ever goes public (DEBT).
- Every mutation writes audit_log (actor, action, target, summary); summaries never contain secrets (channel keys/URLs recorded as presence only).
- Root-admin accounts (ADMIN_EMAILS) cannot be blocked/demoted/deleted from the web; self-lockout guards.

### 2.7 SSE streaming (playground `/api/playground/chat`)
- Upstream errors are sanitized for members (provider identity hidden); admins see raw detail.
- Client abort → upstream reader cancelled (no orphaned paid generation).
- Persistence failures logged (`pg.persist`); partial responses saved.
- Output rendered client-side with marked + a DOM sanitizer that removes the `<script>`, `<style>`, `<iframe>`, `<object>`, `<embed>`, `<link>`, `<meta>`, `<form>` and `<base>` **elements**, all `on*` attributes, and `javascript:`/`vbscript:`/`data:` in `href`/`src`. The chat area is script-free content, so a malicious upstream injecting HTML gets no nonce and is blocked by CSP.
- ⚠ That sanitizer is a **blacklist**, unlike the server-side whitelist in `lib/sanitize.ts`, and it does **not** strip the `style` **attribute** (distinct from the `<style>` element above). Script execution is still prevented, but CSS-only UI redress inside the authenticated origin is not — see §4.6.

### 2.7b Anonymous demo mode (v2.0.0, ADR-0009)
- Attack surface: unauthenticated `POST /api/playground/chat` pointed at a paid upstream.
- Channel lock is checked **before** any DB lookup (no channel-slug probing); model allowlist; 4k input chars; optional per-reply `max_tokens` cap (`demo_max_tokens`, unset by default since 2026-07-21).
- Double **fail-closed** rate limit in the RateLimiter DO (per-IP minute/day + site-wide day); DO failure → 503, never allow — the inverse of the member path's fail-open, deliberately.
- Conversations and accounting both go to a synthetic `demo:public` user row that can never log in. Visitors have **no read path** (list/read/delete all run `pgUser` → 401 for anonymous, own-`user_id` for members), so no visitor can read their own or another visitor's demo chat; only the admin log shows them.
- Worst-case daily burn is bounded by `demo_global_day ×` the per-reply cap; with `demo_max_tokens` unset the request-count half is the whole backstop (it is the half that always held anyway). One settings write kills the surface without a deploy.

### 2.7c Worker → Durable Object handoff (v2.6.0, ADR-0015)

Since v2.6 the playground's streaming transform runs in a `PgStream` Durable Object rather
than in the Worker. That introduces a boundary the original model did not have, and the
property that makes it safe is **inherited from the platform**, so it is worth stating
explicitly rather than leaving implicit.

| Threat | Analysis | Mitigation |
|---|---|---|
| **S**poofing | Something other than our Worker invokes `PgStream` with a forged job | **Not reachable.** A DO namespace has no URL and no route; the only way to obtain a stub is `env.PG_STREAM` inside this Worker. The `https://pg-stream.internal/chat` in `chat.ts` is a label for `wrangler tail`, not an address |
| **T**ampering | Member alters the handoff envelope | The envelope is `<job JSON>\n<raw body>`. **Only the raw-body half is member-controlled**, and the DO re-validates it with the same `cleanChat()`. Channel, model, `userId`, `isAdm`, `demo` and `demoMaxTokens` are always taken from the job half — never from the re-parsed body, which is what makes dumb-mode's server-side override survive the hop |
| **R**epudiation | — | `req_log` is written by the DO with the job's `userId`; `errlog` rows carry the same |
| **I**nfo disclosure | `ch.api_key` now crosses a process boundary | It travels inside the Cloudflare runtime between two of our own compute instances; it is never in a response. The DO's `Response` is returned verbatim by the Worker, and its contents are the already-sanitized unified SSE — this is precisely what passthrough (ADR-0014) gave up and what ADR-0015 bought back |
| **D**oS | Cost/quota bypass by going "straight to the DO" | Impossible for the same reason as spoofing. Quota and demo gating run in the Worker **before** the handoff, so there is no path that reaches upstream without passing them |
| **E**levation | `job.isAdm` decides whether raw upstream errors are shown | It is a **privilege claim carried in a message body**, not a lookup. Sound today because the sender is trusted-by-construction; it is the assumption a second caller of `PG_STREAM` would silently break |

**Two consequences for reviewers**, both of which are why this section exists:

1. The playground's entire authorization surface is now in `routes/api/playground/chat.ts`.
   `PgStream` re-derives nothing. A reviewer who reads the DO looking for checks will not
   find them and should not conclude they are missing.
2. Moving a check "down into the DO for symmetry" would move a trust boundary that nothing
   in the code marks. Adding a second caller of the binding does the same.

Availability note: the handoff is wrapped in try/catch and falls back to running the same
`lib/pgchat.ts` in the Worker, writing an `errlog` row (`pg.do`). `settings.pg_do='0'`
forces that path with no deploy. The fallback is a **degradation** (long replies hit the
10 ms wall again), never a different behaviour.

### 2.8 D1 (single database)
- All queries use bound parameters (no string-built SQL with user input; LIMIT/OFFSET are parseInt-validated).
- Media BLOBs capped at 1.8 MB; text columns length-clamped at write time.
- Observability writes (req_log/errlog/audit_log) are fire-and-forget and never fail the request.
- Backups: daily cron exports every table as JSONL to a private R2 bucket (media BLOBs excluded, 14 copies retained, src/cron.ts); manual `wrangler d1 export` remains as a second line (see ADMIN.md).

### 2.9 Browser surface (XSS / clickjacking / MIME)
- **Stored-XSS via markdown (fixed v2.0.0):** admin-authored article/page markdown is rendered server-side with `marked`, which passes **raw embedded HTML through verbatim**. A stolen admin token (or a future lower-privilege author role) could store `<script>`/`onerror=` in a post. Two independent defenses now stand between content and execution:
  1. **Whitelist sanitizer** (`src/lib/sanitize.ts`, zero-dep, ~130 lines) runs on every `marked.parse()` output — SSR article/page bodies and the `?html=1` APIs. Tag whitelist, per-tag attribute whitelist (drops `on*`/`style`), dangerous containers (`script`/`style`/`iframe`/`svg`/…) dropped with their contents, and href/src scheme whitelist with entity-decoding + control-char stripping (blocks `javascript:`, `data:text/html`, `&#106;avascript:`, `java\tscript:`).
  2. **Nonce marking (not blanket stamping):** `html()` now stamps the per-request nonce **only on shell-authored `<script data-nonce>` tags**, not on every `<script>` in the body. Any script that reaches the body from content has no nonce → blocked by `script-src 'self' 'nonce-…'`. This is the load-bearing control even if the sanitizer ever misses something.
- Static SPA: CSP with sha256 of the single inline script (drift-checked in CI by tools/check-csp.mjs).
- `style-src 'unsafe-inline'` retained (large inline-style surface, DEBT); zero inline `on*=` handlers site-wide (audited).
- All user/content interpolation goes through `esc()`; only markdown bodies allow HTML, and those are sanitized as above.
- `frame-ancestors 'none'`, `nosniff`, HSTS, COOP on every SSR response; CSP violations reported to `/api/csp-report` (10% sampled → errlog).

## 3. Non-goals / accepted risks
- No WAF rules beyond Cloudflare defaults; no bot management.
- VPN token-in-URL can leak via shoulder-surfing/history — mitigated by regeneration, accepted for app compatibility.
- Upstream providers see relayed request contents (inherent to a relay).
- Single D1 region; availability bound to Cloudflare.

## 4. Known accepted risks — stated, not fixed (2026-07-22)

The list above is the short form. These four are written out because each is a real
weakness that a reader could find, and "we didn't notice" and "we decided" look identical
from the outside unless the decision is written down. Each says what is traded for what,
and **what would change the decision** — a risk without a reversal condition is just an
excuse.

### 4.1 `goodOrigin` accepts a localhost `Origin` on the production site

`auth.ts:237` allows `http://localhost:*` and `http://127.0.0.1:*` as CSRF origins
regardless of the deployment. `test/unit/auth.test.ts` pins this as intended, so it is a
decision, not an accident.

**The risk is real but narrow**: an attacker must get a logged-in *admin* to load a page
they control **on the admin's own loopback interface** — a local dev server, a running
Electron app, a locally-served HTML file with a listener. That is a meaningfully harder
precondition than a normal CSRF, but it is not impossible for a developer's machine, which
is exactly the population that has admin cookies here.

**What it buys**: developing against the production API from `wrangler dev` without
maintaining a second origin allowlist.
**Not fixed because** the maintainer is the only admin and does that regularly.
**Reversal condition**: a second admin account exists, or admin cookies are ever held by
someone who is not the developer. At that point the loopback exception should be gated on
`isDevEnv(env)` like the `adminOk` bypass already is (see §4.4).

### 4.2 Daily R2 backups contain plaintext secrets

`cron.ts:91-108` backs up `relay_channels`, `users`, `settings` and `vpn_channels` with
`cols: "*"`. So each daily JSONL contains **upstream API keys in plaintext, the Telegram
bot token, and every member's VPN token** — and 14 copies are retained.

**This is not a code bug.** The keys must be plaintext in D1 for the relay to forward at
all (ADR-0003), so a faithful backup necessarily contains them. What makes it worth
recording is the *blast-radius shift*: `media.data` was carefully excluded for CPU
reasons, which shows the column list was thought about — but only for size, never for
sensitivity. The result is 14 rolling copies of every credential in the system sitting in
a **different storage product with a different access-control surface** from the one the
threat model actually reasons about.

**Reversal condition**: anyone other than the maintainer gains R2 read access. The cheaper
partial fix — redacting secret columns at backup time — has a real cost: the backup stops
being restorable into a working system, which is most of why it exists. (DEBT #20)

### 4.3 `vpn_token` is stored in plaintext

`0001_baseline.sql:103`. In the same table, `sessions.sid` and `api_key_hash` are both
hashed, and the schema comment explains why. `vpn_token` is equally a bearer credential
and is not. Lookups are exact-match, so hashing works with no query changes and the index
still applies — this is cheap, it simply hasn't been done.

**Combined with §4.2, one R2 backup is every member's VPN subscription.** That
combination, not either item alone, is the reason both are written here.
**Reversal condition**: the next migration that touches `users` (DEBT #21).

### 4.4 Correction to §2.4 — path re-encoding is not traversal protection

§2.4 claims path segments are "re-encoded (`encodeURIComponent`)" as a tampering
mitigation. That is **imprecise as stated**: `encodeURIComponent` does not escape `.`, so
`.` and `..` survive re-encoding (`relay/[[path]].ts:83-86`).

It is not currently exploitable — the host comes from the admin-configured `base_url` and
is never user-controlled, so the worst case is reaching a different path *on an upstream
the admin already authorized*. It becomes a real issue the moment a channel's `base_url`
carries a path prefix (`https://host/api/v1`), because `..` could then climb out of that
prefix. Tracked as DEBT #22; the fix is to reject segments equal to `.` or `..`.

### 4.5 `visits` logging is an unmetered anonymous D1 write, on a budget it shares 1:1 with everything that matters

Added 2026-08 ([review F1](./REVIEW-2026-08.md)). **✅ Fixed in v2.6.1** — kept here rather than
deleted because the reasoning is what makes the fix legible, and because §2.8 was built on the
assumption this section corrects. The fix is described at the end.

`router.ts:107` calls `visitLog()` before dispatch, writing one `visits` row for any request
carrying `Accept: text/html` — including paths that do not exist, which also defeats edge
caching. There is no sampling and no rate limit. `/api/csp-report` — the *other* anonymous
D1 write path, and the one this document's §2.8 reasoning was built around — has both, plus
fail-closed behaviour, and its source comment claims to be the only such path.

Why the asymmetry matters: the free tiers are **100,000 Worker requests/day** and
**100,000 D1 rows written/day**. Visit logging consumes them one-for-one, so the site's
least valuable write has first claim on the budget that also has to cover sessions, chat
persistence and `req_log` (~4 rows per playground turn). On exhaustion, D1 returns errors
for **all queries, not just writes** ([D1 pricing][d1p]).

The failure is silent by construction: `errlog` is a D1 table, `tgAlertScan` reads `errlog`
from D1, and `runJob` records outcomes into `settings` — also D1. **The alert channel
depends on the subsystem whose failure it would have to report.** Fail-open is correct
everywhere it appears here; the gap is that nothing reserves headroom, and nothing can say
so afterwards.

`cron.ts:274-278` names this risk exactly and says it is recorded in DEBT. It was not —
DEBT #18 covers `visits` only as long-term table growth, a different time constant that the
180-day retention already addresses.

**Fix shipped in v2.6.1** — two layers, neither adding I/O to the user's critical path:

- **L1, a page allowlist** (`_middleware.ts`). Only paths the site actually serves are logged.
  The trigger used to be "carries `Accept: text/html`", which meant *any* path including ones
  that do not exist; scanners hitting `/wp-admin`, `/.env`, `/phpmyadmin` each cost a row.
  Zero-cost, and it removes the unbounded-cardinality case entirely.
- **L2, a site-wide daily cap** (`VISIT_GUARD`, 40,000 rows = 40 % of the free-tier write
  budget) counted in the existing `RateLimiter` DO under `visit:global`, consulted on a 1-in-20
  sample with the verdict cached per isolate for the rest of the UTC day. Normal traffic
  (~123 views/day) makes about six DO calls a day; a flood converges within a sampling interval
  and then costs nothing at all. Denial **or** limiter failure both stop logging — the inverse
  of `lib/quota.ts`'s fail-open, for the same reason `csp-report` is fail-closed: what is being
  protected is the *paid-for* writes' budget, so the cheapest write yields.

The part that matters most is not the cap but its **observability**: tripping it writes one
`visits.cap` row to `errlog`, which the existing five-minute `tgAlertScan` pushes to Telegram —
**while D1 is still healthy**, because the self-imposed cap sits 60 % below the platform limit.
That is the answer to this section's core problem: the alert fires on the leading indicator,
not on the failure that would have silenced the alert channel.

Independently, `/api/health` now classifies its D1 error as `quota` vs `error` vs `unbound`
(`db_error`). It needs no D1 *write* to answer, so it remains the one endpoint that can still
report the state — and the two situations demand opposite responses (wait for UTC midnight or
upgrade the plan, vs. check the platform status page).

### 4.6 The client-side sanitizer permits `style` on model-generated HTML

Added 2026-08 ([review F2](./REVIEW-2026-08.md)). Also open.

Two sanitizers guard two content paths on opposite principles: `lib/sanitize.ts` (server,
admin markdown) is a **whitelist** whose global attribute list is `class`/`title` only;
`playgroundpage.ts:293-306` (client, model output) is a **blacklist** of nine elements plus
`on*`. The `style` attribute passes the second one.

Model output is attacker-influenceable — prompt injection through a pasted document, a
quoted web page, or a compromised upstream — and lands in `md.innerHTML`. Combined with
`style-src 'unsafe-inline'` (DEBT #9), a reply can paint a full-viewport fixed overlay
**inside the genuine, logged-in origin**, e.g. a fake "session expired, sign in again" card
whose link the sanitizer itself decorates with `target="_blank" rel="noopener noreferrer"`.
No script runs, so CSP is not violated and §2.9's nonce control — which is the load-bearing
one for *script* injection — does not apply to this.

What makes it worth fixing rather than accepting: the hijacked page is the one where members
legitimately expect Google sign-in prompts.

**Fix**: strip `style` in the attribute loop (one line), and consider dropping `<svg>`/
`<math>` to match the server-side `DROP_CONTENT`. A related latent issue — the blacklist's
uppercase `tagName` comparison does not match SVG-namespace elements, so `<svg><script>`
survives it (harmless today: `innerHTML` never executes scripts and CSP has no
`unsafe-inline`) — is recorded as review F3.

### Changelog

| Added | Sections | Reason |
|---|---|---|
| 2026-07-22 | §4.1–4.4 | Round 2 of [AUDIT-2026-07](./AUDIT-2026-07.md) — accepted risks written out with reversal conditions |
| 2026-08-06 | §1 sketch, §2.7c, §2.7 wording, §4.5–4.6 | v2.6 added a trust boundary (ADR-0015); [REVIEW-2026-08](./REVIEW-2026-08.md) found two open items |
| 2026-08-06 | §4.5 marked fixed | v2.6.1 shipped the page allowlist, the daily visit cap and the `/api/health` D1 classification. §4.6 remains open |

[d1p]: https://developers.cloudflare.com/d1/platform/pricing/

---

# 繁體中文版

> 對 uaip.cc.cd（v2.0.0）每一條信任邊界做 STRIDE 分析。
> 範圍：Cloudflare Workers 應用本體（worker＋D1＋靜態資產）；
> 不含 Cloudflare 平台、Google OAuth 基礎設施、上游 LLM／機場的內部。

## 入口 × 威脅重點

**Google OAuth**：`state` 亂數綁 HttpOnly cookie（10 分鐘）防 CSRF 登入；token 由伺服器直連
Google 交換（TLS、來源可信）；`aud` 必須是自己的 client id；`email_verified` 必須為真；
管理員身分只認 `ADMIN_EMAILS` 環境變數，網頁上動不了。登入失敗進站內錯誤日誌。

**Session cookie**：HttpOnly＋Secure＋SameSite=Lax；**資料庫只存 sid 的 SHA-256** —
資料庫外洩拿不到能用的 cookie。過期即失效；管理員可 `revoke_sessions` 踢人、
會員可 `/api/account/logout-all` 自救。所有 cookie 身分的寫入端點都驗 `Origin`。

**會員金鑰（uak-）**：產生當下顯示一次，庫內只有雜湊＋提示；先過格式檢查再查庫；
四個擺放位置在轉發前全部剝除、`?key=` 從查詢字串刪掉。外洩影響面＝relay 一項，
且被日配額＋每分鐘限流鎖住；重生金鑰立即讓舊的失效。

**中轉直通**：DROP 名單剝掉連線層／CF／身分標頭；路徑重新編碼防注入；上游目標＝
管理員設定的 base_url，會員控制不了主機；計量只掃「回應」尾端，絕不緩衝會員請求本體；
會員斷線立即 cancel 上游（pump 不用 tee，不燒錢）；每請求一列 req_log 可追帳。

**VPN 訂閱**：token 放網址是為了 VPN App 相容性（App 不會帶 cookie）的必要取捨 —
可重生、有格式檢查、封鎖／未批准者即使 token 對也拿不到內容；上游網址永不出現在回應；
v1.0.0 起無 vpn 權限者連 `/vpn` 頁面存在都看不到（隱形）。

**管理員 API**：雙身分（Bearer 金鑰／管理員 cookie＋Origin）；金鑰明文只在 gitignored 的
ADMIN.local.md、v1.0.0 發佈時輪替（舊值在 git 歷史裡 — repo 公開前必須 filter-repo，記 DEBT）；
所有變更寫 audit_log 且絕不含秘密；root 管理員帳號網頁上不可封鎖／降級／刪除。

**SSE 串流**：上游錯誤對會員淨化（不洩提供商身分）、管理員看原文；會員中斷 → 上游取消；
輸出在瀏覽器端經 marked＋DOM 消毒（去 script／on*／js: 網址），聊天區是無 script 的內容 —
惡意上游注入的 HTML 拿不到 nonce，CSP 直接封殺。

**匿名體驗模式（v2.0.0，ADR-0009）**：未驗證的聊天端點直指付費上游＝燒錢面。渠道鎖
在查庫**之前**就擋（探測不到其他渠道 slug）、模型白名單、輸入 4k 字、每則回覆長度上限選填
（demo_max_tokens，2026-07-21 起預設不填＝不限）；
DO 雙保險 **fail-closed** 限流（每 IP 分鐘/日＋全站日），DO 壞→503 絕不放行 — 與會員路徑的
fail-open 刻意相反。對話與記帳都掛在永遠無法登入的 `demo:public` 合成帳號下，訪客**沒有任何
讀取管道**（列表／讀取／刪除都先過 pgUser：匿名 401、會員綁自己的 user_id），所以看不到自己
也看不到別人的試聊，只有管理員的 /logs 看得到。最壞日燒錢
＝全站日上限×每則回覆上限（後者預設不限，真正扛住的一直是全站日上限）；settings 一鍵關閉免部署。

**D1**：全部參數綁定（無字串拼 SQL）；寫入長度上限；觀測性寫入永不影響請求本體；
每日 cron 全庫 JSONL 備份進私有 R2（BLOB 排除、保留 14 份，src/cron.ts）；手動 export 當第二保險（ADMIN.md）。

**瀏覽器面（Stored-XSS，v2.0.0 修復）**：管理員寫的文章／頁面 Markdown 由伺服器用 marked
轉 HTML，而 marked **會原樣放行內嵌的原始 HTML** — 管理 token 失竊（或日後低權限作者角色）
就能在文章裡存 `<script>`／`onerror=`。內容與執行之間現在有兩道獨立防線：
① **白名單消毒器**（`src/lib/sanitize.ts`，零依賴、約 130 行）套在每個 `marked.parse()` 輸出上
（SSR 文章／頁面內文與 `?html=1` API）：標籤白名單、逐標籤屬性白名單（剝 `on*`／`style`）、
危險容器連內容整段丟、href/src scheme 白名單（先實體解碼＋去控制字元，擋 `javascript:`／
`data:text/html`／`&#106;avascript:`／`java\tscript:`）。
② **nonce 標記制**（不再全體蓋章）：`html()` 只對外殼自己標記的 `<script data-nonce>` 蓋 nonce，
不再蓋 body 裡所有 `<script>`；任何從內容層混進來的 script 都沒有 nonce → 被
`script-src 'self' 'nonce-…'` 封殺。就算消毒器哪天漏了，這一層仍撐得住。
靜態 SPA 用 sha256 hash（CI 防漂移）；`frame-ancestors 'none'`＋nosniff＋HSTS＋COOP；
全站零 inline 事件屬性；`style-src 'unsafe-inline'` 暫留（記 DEBT）；CSP 違規 10% 取樣進錯誤日誌。

## 明知且接受的風險
Cloudflare 預設之外無 WAF／bot 管理；VPN token 網址可能被偷看（可重生）；
中轉內容上游必然看得到（中轉的本質）；D1 單區域，可用性綁 Cloudflare。

## 明知且接受的風險（2026-07-22 展開版）

上面那段是短版。下面四條特別寫開，因為每一條都是讀者找得到的真實弱點，而
**「沒注意到」跟「想過之後決定不修」從外面看起來一模一樣**——除非決策被寫下來。
每條都寫清楚拿什麼換什麼，以及**什麼情況會改變這個決定**：沒有反轉條件的風險評估只是藉口。

**① `goodOrigin` 在正式站放行 localhost Origin**（`auth.ts:237`，`test/unit/auth.test.ts`
記錄了這是刻意的）。風險真實但很窄：攻擊者得讓**已登入的管理員**在自己的迴環介面上載入
他控制的頁面（本機開發伺服器、Electron App、自己起的 listener）。這個前提比一般 CSRF
難得多，但對開發者的機器不是不可能——而那正好就是持有管理員 cookie 的族群。
換到的是：能從 `wrangler dev` 直接打正式 API，不必再維護第二份 origin 白名單。
**反轉條件**：出現第二個管理員帳號，或管理員 cookie 落在開發者以外的人手上——
屆時這條例外應該比照 `adminOk` 改成閘在 `isDevEnv(env)`（見 ④）。

**② 每日 R2 備份含明文機密**（`cron.ts:91-108`）：`relay_channels`／`users`／`settings`／
`vpn_channels` 都用 `cols:"*"`，所以每份日備份含**上游明文 API key、TG bot token、
全體會員的 VPN token**，而且保留 14 份。**這不是 code bug**——金鑰本來就得明文存 D1 才能
轉發（ADR-0003），忠實的備份必然含它。值得記下來的是**爆炸半徑的位移**：`media.data`
為了 CPU 被細心排除，代表欄位清單是想過的——但只想了大小，沒想過敏感度。結果是
14 份滾動副本躺在**另一個存取控制面完全不同的儲存系統**裡，而威脅模型推理的並不是那一個。
**反轉條件**：維護者以外的人拿到 R2 讀權限。比較便宜的半套修法（備份時遮罩機密欄位）
有真實代價：備份會不再能直接還原成可用系統，而那正是備份存在的大半理由。（DEBT #20）

**③ `vpn_token` 明文存**（`0001_baseline.sql:103`）：同一張表的 `sessions.sid` 與
`api_key_hash` 都雜湊了，schema 註解還寫了理由；`vpn_token` 同樣是 bearer credential
卻是明文。查詢是精確比對，改雜湊不必動查詢、索引照用——便宜，只是一直沒做。
**配上 ②，一份 R2 備份 ＝ 全體會員的 VPN 訂閱**；是這個組合、而不是單獨任一條，
讓兩者都被寫進來。**反轉條件**：下一次動到 `users` 表的 migration（DEBT #21）。

**④ 更正 §2.4——路徑重新編碼不等於防 traversal**：§2.4 把「path 片段重新編碼
（`encodeURIComponent`）」寫成防篡改手段，**這個說法不精確**：`encodeURIComponent`
不轉義 `.`，所以 `.` 與 `..` 原封不動地通過（`relay/[[path]].ts:83-86`）。
目前打不到——host 來自管理員設定的 `base_url`、使用者控制不了，最糟也只是打到
「管理員已經授權的那個上游」的別條路徑。但只要有渠道的 `base_url` 帶了路徑前綴
（`https://host/api/v1`），`..` 就能爬出那個前綴。記在 DEBT #22；修法是直接拒收
等於 `.` 或 `..` 的片段。

## v2.6 新增的信任邊界：Worker → Durable Object（§2.7c 中文版）

v2.6 起 Playground 的串流轉譯跑在 `PgStream` Durable Object 裡（ADR-0015），這是原本的
威脅模型沒有的一條邊界。**讓它安全的那個性質是繼承自平台的**，所以必須明講而不是留給人猜：

**DO 命名空間沒有網址、沒有路由，唯一取得 stub 的方式是本 Worker 裡的 `env.PG_STREAM`。**
`chat.ts` 裡那個 `https://pg-stream.internal/chat` 只是給 `wrangler tail` 認的標籤，不是位址。
因此「繞過 Worker 直接打 DO」不存在，配額與體驗模式閘門都在交棒**之前**跑完。

交棒信封是 `<job JSON>\n<原始本體>`，**只有後半是會員可控的**，而 DO 會用同一支 `cleanChat()`
重新驗一次。渠道、模型、`userId`、`isAdm`、`demo`、`demoMaxTokens` **一律以 job 為準**，
絕不取自重新解析的本體 —— 這正是 dumb mode 的伺服器端覆寫能撐過這一跳的原因。

兩個給後續 reviewer 的提醒（這一節存在的理由）：
① Playground 的授權面現在**完全**在 `routes/api/playground/chat.ts`，`PgStream` 一項都不重推導；
去 DO 裡找檢查的人會找不到，但那不代表少做了。
② 「為了對稱把檢查搬進 DO」會移動一條程式裡沒有標記的信任邊界；多一個 `PG_STREAM` 的呼叫端也一樣。
另外 `job.isAdm` 決定會員看不看得到上游錯誤原文 —— 它是**在訊息本體裡旅行的權限主張**而不是一次查詢，
今天成立是因為寄件人可信，而那正是第二個呼叫端會安靜打破的假設。

可用性：交棒包在 try/catch 裡，叫不動就退回在 Worker 裡跑同一支 `lib/pgchat.ts` 並寫 `errlog`；
`settings.pg_do='0'` 免部署強制走那條。退路是**降級**（長回覆會再撞 10ms）而不是另一種行為。

## 明知且尚未修的風險（2026-08 第三輪稽核新增）

上面四條是「想過之後決定不修」；下面兩條不同 —— **它們是還沒有負責人的活風險**，
寫進來是為了不讓它們停在某個人的腦袋裡。全文見 [REVIEW-2026-08.md](./REVIEW-2026-08.md)。

**⑤ ✅ v2.6.1 已修 — `visits` 是不計量的匿名 D1 寫入，而且跟所有有價值的寫入 1:1 共用同一個預算。**
（原文保留：推理過程才是讓修法看得懂的東西，而 §2.8 當初正是建立在這一節所更正的假設上。）
`router.ts:107` 在路由分派**之前**就呼叫 `visitLog()`，只要請求帶 `Accept: text/html`
就寫一列 —— **連不存在的路徑都算**，而且每個路徑都不同，順便讓邊緣快取失效。
沒有取樣、沒有限流。而 `/api/csp-report`（本文件 §2.8 的推理所圍繞的那個匿名寫入口）
兩樣都有，還是 fail-closed，它的原始碼註解甚至聲稱自己是全站唯一。

不對稱為什麼要緊：免費額度是 **Workers 每日 10 萬請求**與 **D1 每日 10 萬列寫入**，
而瀏覽紀錄是一比一在吃它。也就是說**全站最沒價值的那筆寫入，對「同時要供養 session、
對話落地、`req_log`（一輪聊天約 4 列）」的預算有優先權**。額度用完時，D1
**連查詢都會回錯誤，不只寫入**。

而那一刻站台講不出話：`errlog` 是 D1 的表、`tgAlertScan` 要從 D1 讀它、`runJob` 把結果寫回
D1 的 settings。**告警管道依賴的正是那個它必須回報其故障的子系統。** fail-open 在這裡
每一處都是對的，缺的是「沒有任何東西替有價值的寫入保留額度」，以及事後沒有任何東西說得出口。

`cron.ts:274-278` 把這個風險寫得很精確，並說「記在 DEBT」——**但它沒有進 DEBT**：
#18 只涵蓋 `visits` 的長期列數成長，那是不同的時間尺度，而且 180 天保留期已經處理掉了。
修法由便宜到貴：不記沒命中的路徑 → 比照 csp-report 取樣 → 用既有 `RateLimiter` DO 的
`visit` 命名空間（`RateCheckArg.svc` 本來就是為這種切分存在）替使用者資料保留多數額度 →
`/api/health` 要能把「D1 寫入額度爆了」講出來，因為正常告警路徑證明講不出來。

**⑥ 客戶端消毒器放行模型輸出裡的 `style` 屬性。**
兩個消毒器守兩條路、原理相反：`lib/sanitize.ts`（伺服器、管理員 Markdown）是**白名單**，
全域屬性只有 `class`／`title`；`playgroundpage.ts:293-306`（客戶端、模型輸出）是**黑名單**，
只擋九個元素加 `on*` —— `style` 通過。模型輸出是可被影響的（貼進來的文件、被引用的網頁、
被打下來的上游），最後進 `md.innerHTML`。配上 `style-src 'unsafe-inline'`（DEBT #9），
一則回覆就能在**真正的登入中網域**上蓋一張滿版固定定位的假「登入逾時」卡，
而那個連結還會被消毒器自己加上 `target="_blank" rel="noopener noreferrer"`。
沒有 script 執行，所以 CSP 不會擋，§2.9 的 nonce 管制（那是擋**腳本**注入的承重牆）
對這件事不適用。值得修而不是接受的理由：被劫持的正是「會員本來就預期看到 Google 登入提示」的那一頁。
修法：屬性迴圈裡一併移除 `style`（一行），並考慮比照伺服器端把 `<svg>`／`<math>` 也丟掉。
相關的潛伏問題（黑名單用大寫比對 `tagName`，對 SVG 命名空間不成立，`<svg><script>` 會活下來；
今天無害，因為 `innerHTML` 插入的 script 不執行、CSP 也沒有 `unsafe-inline`）記在稽核 F3。
