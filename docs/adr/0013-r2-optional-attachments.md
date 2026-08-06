# ADR-0013: R2 is optional — attachments run in two storage modes

**Status**: accepted · **Date**: 2026-07-30 (R2 enabled on the account 2026-07-29)

## Context

Playground attachments (v2.3.0) stored image content as base64 **text in D1**, because
D1 was the only durable store the account had. That decision came with a hard ceiling:
D1 caps a single value at 2,000,000 bytes, so after base64's 4/3 inflation the largest
image the site could accept was ~1,464 KB — the shipped limit was 1400 KB.

R2 was then enabled on the account. The obvious move is "put attachments in R2 and raise
the limit". The non-obvious question is what happens to the D1 path: deleting it makes
the codebase simpler, but it also makes the project un-runnable for anyone who clones it
without an R2 bucket, and it makes "turn R2 off again" a migration rather than a config
change.

## Decision

**Both modes stay, selected by whether the `FILES` binding exists.** No flag, no setting,
no migration:

```
env.FILES present  → new attachments go to R2, single-file limit 5 MB
env.FILES absent   → new attachments go to D1's b64 column, single-file limit 1400 KB
```

The switch works because **every row records where its own content lives**
(`pg_files.storage` = `d1` | `r2`, added in migration 0007 before R2 existed). Reads
dispatch per row, so:

- enabling R2 needs no data migration — old D1 rows keep being served from D1;
- disabling R2 does not break the site — R2-backed rows degrade to the existing
  "file was deleted" placeholder, which every caller already handles.

Quota defaults and their hard ceilings are **per mode**, because the constraints have
different origins (`lib/filestore.ts`):

| | single file | per member | site total |
|---|---|---|---|
| D1 mode | 1400 KB | 30 MB | 300 MB |
| R2 mode | 5 MB | 200 MB | 6144 MB raw ( = 8 GB in R2) |

Content is stored as **base64 text in R2 too**, not binary. This looks wasteful (+33%
space) and is deliberate: all three upstreams accept only base64, so storing binary means
re-encoding on every single turn — measured at 8.11 ms/MB, against a 10 ms CPU budget per
request. Space is paid once; CPU is paid every turn. Same reasoning as the original D1
decision, unchanged by the move.

### Staying inside the free tier is code, not a promise

R2's free tier is three independent lines: 10 GB storage, 1M Class A ops/month,
10M Class B ops/month. Each fails differently, so each is guarded differently
(`lib/r2budget.ts`):

- **Storage** is the only one that overruns *silently* — no error, just a bill. Guarded
  by a hard ceiling admins cannot raise past, plus a daily cron that measures real usage
  (attachments + backup objects) and evicts oldest-first against what is actually left.
- **Class A** (writes) comes only from uploads. When the monthly budget is spent, uploads
  **fall back to D1** instead of failing — mixed storage is already a supported state, so
  the degradation costs nothing architecturally. The single-file limit drops to D1's
  1400 KB at the same time, so the user gets "image too large", never "save failed".
- **Class B** (reads) comes only from re-opening old conversations, and browsers cache
  those 7 days `immutable`. Exhausting it requires a logged-in loop; when it happens reads
  degrade to the same placeholder path as a missing object.

Deletes are free in R2, so cleanup paths never consult a budget.

**The 4/3 conversion is the load-bearing detail.** Quotas are compared against
`pg_files.bytes` (the *original* file size, which is what a user recognises), but R2 holds
base64. Setting the site total to 8192 MB would occupy ~10.9 GB in R2 — past the free
tier, silently. The budget therefore converts explicitly: 8 GB of R2 space = 6144 MB of
raw image data.

### Raising the limit forced a second change

Serving a stored image back to `<img>` requires decoding base64 to binary. The original
code used `atob()` plus a `charCodeAt` loop, measured on this project's V8 baseline:

| | 1 MB | 2 MB | 5 MB |
|---|---|---|---|
| `atob` + loop | 2.93 ms | 5.53 ms | **11.31 ms** |
| `Uint8Array.fromBase64` | 0.48 ms | 1.15 ms | 2.96 ms |

At the new 5 MB limit the old path exceeds the free plan's 10 ms CPU budget — history
images would have died exactly like ADR-0011, and only for the users who uploaded big
files. The read route now uses native `fromBase64`, keeping the old loop as a fallback.
**A storage limit and its decode cost are one decision, not two.**

## Consequences

**Won**: 5 MB attachments; `git clone` still works with zero R2 setup; R2 can be turned
off as easily as it was turned on; free-tier compliance is enforced by ceilings and a
measuring cron rather than by remembering to check a dashboard.

**Paid**: two storage paths to keep working, and the tests to prove both (the vitest
config deliberately binds the test bucket as `FILES_TEST`, *not* `FILES`, so the default
suite keeps exercising D1 mode); quota numbers that read oddly until you know about the
4/3 conversion; a monthly counter in `settings` that costs one extra D1 write per upload
and per conversation-with-images load.

**Not solved by this**: *storing* 5 MB is not *sending* 5 MB. `PG_LIMITS.maxImgBytesTotal`
still caps images sent upstream per request at 1.5 MB, because assembling that body costs
CPU before streaming starts (ADR-0011). The front-end therefore still compresses toward
the model budget, not the storage limit. Lifting that needs a paid plan, not a bigger
bucket.

**Revisit when**: the account leaves the free plan (raise `maxImgBytesTotal` first — it is
the binding constraint on what the model can actually see), or article media (still D1
BLOBs, ADR-0002 / DEBT #1) approaches 1 GB and wants the same treatment.

> **Addendum, 2026-08-06 — the "Not solved by this" paragraph above is now out of date.**
> It is kept verbatim because it was correct when written and its *reasoning* still holds;
> only its number moved. `maxImgBytesTotal` was raised to **16 MB** (ceiling 32 MB, live-tunable
> via `pg_img_total_kb`) in two steps: the owner widened it on 2026-07-29 to collect a real
> distribution in `req_log.img_bytes`, and v2.6 removed the constraint that set it in the
> first place — assembling the upstream body now happens inside a Durable Object with a 30 s
> CPU budget, not in the Worker's 10 ms ([ADR-0015](0015-durable-object-streaming.md)).
> So the sentence "lifting that needs a paid plan, not a bigger bucket" was wrong about the
> *only* available lever, which is the more interesting error: the paid plan was one way to
> buy 30 s of CPU, and it turned out not to be the only one.
> Found by [REVIEW-2026-08](../REVIEW-2026-08.md) F4a.

---

**中文摘要**：R2 是**可選**的 —— `FILES` 綁定在就寫 R2（單檔 5MB），拿掉就寫 D1（1400KB），
靠 `pg_files.storage` 逐列記錄，切換不必搬資料、不必停機。三層配額與硬天花板兩種模式各一組，
因為限制來源不同（D1 卡單值 2MB／R2 卡免費額度 10GB）。免費額度用程式守：儲存空間有天花板
＋每日量真實用量回收，Class A 用完退回 D1，Class B 用完走既有的佔位降級，刪除免費不計數。
**關鍵細節是 4/3 換算** —— R2 存 base64，8GB 空間只等於 6144MB 原始圖片，忘了換算就會實佔
10.9GB 而毫無錯誤訊息。放寬到 5MB 同時必須換掉回讀的解碼方式（`atob`＋迴圈 5MB 要 11.31ms，
超過免費方案 10ms CPU；改用原生 `Uint8Array.fromBase64` 只要 2.96ms）——上限與解碼成本是同一個決定。
最後：**存得下 5MB 不等於模型看得到 5MB**，單次請求送上游的圖片總量仍受 CPU 限制在 1.5MB。

> **2026-08-06 補記**：上面那句的**數字**已經過時（現在預設 16MB、天花板 32MB），
> 但**道理沒過時** —— 那條線限的仍然是 CPU 而不是儲存。原文保留不改，因為寫的當下是對的。
> 會變是因為 v2.6 把「組上游 body」整段搬進了 30 秒 CPU 的 Durable Object（ADR-0015），
> 那筆花費不再從 Worker 的 10ms 出。順帶一提，原文英文版寫「要放寬只能升付費方案，
> 不是換更大的桶子」—— **那句話錯的地方比數字有意思**：付費方案只是買到 30 秒 CPU 的
> 其中一條路，結果它不是唯一一條。
