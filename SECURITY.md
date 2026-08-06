# Security Policy / 安全政策

## Reporting a vulnerability

This is a personal project run by a single maintainer. If you find a security issue,
please **do not** open a public issue. Email **zwwe1f@gmail.com** with:

- What you found and where (URL / endpoint / code path)
- Steps to reproduce
- Impact as you understand it

You will get a reply as soon as possible (usually within a few days). Please give the
maintainer reasonable time to fix the issue before any public disclosure. Good-faith
research against your **own** account/data is welcome; do not access other users' data,
do not run denial-of-service tests, and do not test the upstream providers through the relay.

## Scope

In scope: everything served from `uaip.cc.cd` (the Worker, D1-backed APIs, static SPA).
Out of scope: Cloudflare platform, Google OAuth, upstream LLM/VPN providers.

## Design overview

See [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md) for the full STRIDE analysis, and
[docs/AUDIT-2026-07.md](docs/AUDIT-2026-07.md) / [docs/REVIEW-2026-08.md](docs/REVIEW-2026-08.md)
for the review history — **known-but-unfixed weaknesses are published rather than hidden**,
so please check those first. Something already listed there is not a new finding; showing
that our stated impact assessment is *wrong* very much is. Highlights:

- Session ids and member API keys are stored **hashed** (SHA-256) — the database never
  holds usable credentials.
- Every state-changing cookie-authenticated endpoint checks the `Origin` header.
- Admin mutations are audit-logged; audit entries never contain secrets.
- CSP: per-request nonce on SSR pages, sha256 on the static SPA, violations sampled to
  an in-site error log.
- Relay: member identity headers are stripped before forwarding; metering reads the
  response only; per-user quotas cap cost exposure.

---

# 繁體中文

這是單人維護的個人專案。發現安全問題請 **不要** 開公開 issue，
直接寄信到 **zwwe1f@gmail.com**，附上：

- 發現了什麼、在哪裡（網址／端點／程式路徑）
- 重現步驟
- 你理解的影響範圍

維護者會盡快回覆（通常幾天內）。公開揭露前請給合理的修復時間。
歡迎針對**自己的**帳號與資料做善意研究；請勿存取其他使用者的資料、
請勿做阻斷服務測試、請勿透過中轉站去測試上游供應商。

**範圍**：`uaip.cc.cd` 上的一切（Worker、Durable Objects、D1 API、靜態 SPA）。
不含：Cloudflare 平台、Google OAuth、上游 LLM／機場。

完整威脅分析見 [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md)；
**已知但尚未修的弱點是公開的**，見 [docs/AUDIT-2026-07.md](docs/AUDIT-2026-07.md)（兩輪稽核＋自報漏檢率）
與 [docs/REVIEW-2026-08.md](docs/REVIEW-2026-08.md)（第三輪，對 v2.6）。
回報之前可以先翻這兩份 —— 已經寫在裡面的不算新發現，但**如果你能證明我們對影響範圍的判斷是錯的，那非常有價值**。
