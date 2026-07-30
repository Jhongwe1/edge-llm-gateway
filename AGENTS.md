# AGENTS.md — 給 AI agent 的網站操作指南

這份文件給接手操作 **uaip.cc.cd** 的 AI agent（Claude Code、其他 agent 皆可）看。
人類管理員的維護筆記在 [ADMIN.md](./ADMIN.md)；完整的逐端點 API 文件在 [API.md](./API.md)。

## 你要知道的第一件事

這個網站的**內容操作全部走 HTTP API**，不需要改程式碼、不需要部署：

| 想做什麼 | 走哪裡 |
|---|---|
| 發新聞/文章、改文、刪文 | `POST/PUT/DELETE /api/admin/articles…` |
| 開新頁面（新連結，例如「關於本站」） | `POST /api/admin/pages` → 上線在 `/p/{slug}` |
| 上傳圖片 | `POST /api/admin/media` |
| 改側邊欄選單、改站名 | `PUT /api/admin/menu`、`PUT /api/admin/settings` |
| Playground 開放給所有登入會員 | `PUT /api/admin/settings {"pg_open":true}`（false＝關閉，回到逐人批准） |
| 改 Playground 的預設系統提示詞（一次管全部沒自己填的渠道） | `PUT /api/admin/settings {"pg_default_system":"…"}`（空字串＝還原程式內建那段；單一渠道要不一樣就改該渠道的 `system_prompt`） |
| 看流量 | `GET /api/logs` |
| 看站內錯誤／用量（v1.0.0） | `GET /api/admin/errors`、`GET /api/admin/stats?days=7`；健康檢查 `GET /api/health`（公開） |
| 看全站會員的 Playground 對話 | `GET /api/admin/conversations`（`?q=` 找人）→ `GET /api/admin/conversations/{id}` 讀內容（唯讀） |
| 批准／管理會員（可分服務） | `GET /api/admin/users`、`PUT /api/admin/users/{id} {"action":"approve"}` 或 `{"action":"set_services","services":[…]}` |
| 設會員／全域配額（v1.0.0） | `PUT /api/admin/users/{id} {"action":"set_quota",…}`（個人）、`PUT /api/admin/settings {"quota_relay_day":…}`（全域） |
| 加／改 API 中轉管道（含模型清單） | `POST/PUT/DELETE /api/admin/relay/channels…`（`models` 必填） |
| 加／改 VPN 渠道 | `POST/PUT/DELETE /api/admin/vpn/channels…` |
| 測 Playground | `POST /api/playground/chat`（管理金鑰可直接測，SSE 串流；`{r}`＝思考、`{d}`＝正文） |

> **v1.0.0（2026-07-14）新增**：中轉／Playground 有**每人每日配額＋每分鐘限流**（管理員豁免；超額 429＋Retry-After），
> 用量記在 req_log、看得到 token 與延遲；所有管理員變更寫**稽核日誌**；VPN 對未授權者**隱形**
> （選單／頁面／API 欄位全隱藏）；SSR 頁面有 **per-request nonce CSP**。這些對「內容操作」多半透明，
> 但若你用管理金鑰大量打 relay 測試而撞到 429，那是配額（管理員帳號不會，見 §5d）。

只有「改程式或版型」才需要動這個 repo 並部署（見文末）。

**2026-07-11 起新增會員系統**（Google 登入）；**2026-07-13 起改分服務批准**：三個服務 `relay`（API 中轉站 /relay）、`vpn`（VPN 訂閱 /vpn）、`playground`（Playground /playground）由管理員分別批准（`set_services` 整包覆蓋；`approve`＝一次全給）。**2026-07-14 起 playground 另有全站開關 `pg_open`**（設定後所有登入會員免逐一批准；relay/vpn 不受影響），開關在 /members 頁最上方或 `PUT /api/admin/settings`。管理員身分＝ADMIN_EMAILS 指定的信箱或 is_admin 帳號。逐端點細節見 [API.md](./API.md) 的 §5b–§5f。用管理金鑰（LOGS_TOKEN）就能操作全部管理員 API，不需登入。

## 連線與驗證

- 正式站：`https://uaip.cc.cd`（等同 `https://uaip.pages.dev`）
- 本機開發：`http://localhost:8787`（`npx wrangler dev`；**localhost 免金鑰**，想先試就在本機試）
- 管理員 API（路徑含 `/admin` 的與 `/api/logs`）要帶標頭：`Authorization: Bearer <管理金鑰>`
- **管理金鑰**：讀本機 `ADMIN.local.md`（gitignored；2026-07-14 起 ADMIN.md 不再放明文）

## 三條鐵則（違反會出事）

1. **PUT 一律整包覆蓋**（文章、頁面、選單）：先 GET 現況 → 只改要改的欄位 → 整包 PUT。漏帶的欄位會被清空。
2. **圖片編號（`/img/{id}`）永遠不能重複使用**：掛一年 immutable 邊緣快取且清不掉。換圖＝上傳拿新編號＋更新引用；絕不重設 media 表流水號、不重用刪過的編號。
3. **中文必走 UTF-8 檔案**：JSON 先寫進 UTF-8 檔，`curl --data-binary @檔案` 送出。中文直接寫在 Windows 指令列會亂碼。

內容規範：轉貼別站新聞要**用自己的話改寫＋文末附來源連結**，不可整篇照抄。

## 常用流程（可直接照抄）

以下範例是 bash 語法（`$TOKEN`＝管理金鑰）；Windows cmd 把行尾 `\` 換成 `^`。

### 發一篇新聞／文章

```bash
# （可選）先傳封面圖，拿 /img/{id}；圖要先壓到 1.8MB 以下、建議最寬 1400-1600px
curl -X POST "https://uaip.cc.cd/api/admin/media?w=1400&h=788" \
  -H "Authorization: Bearer $TOKEN" -H "content-type: image/jpeg" --data-binary @cover.jpg

# art.json（UTF-8）：category 是 news 或 article；status 給 draft 就是存草稿
# { "category":"news", "status":"published", "title":"標題",
#   "summary":"一兩句摘要（列表與 SEO 用）", "cover":"/img/5", "body_md":"內文 **Markdown**" }
curl -X POST https://uaip.cc.cd/api/admin/articles \
  -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json; charset=utf-8" --data-binary @art.json
# 回 { "id":12, "status":"published" } → 上線在 /news/12（article 分類則是 /articles/12）
```

`body_md` 是 Markdown（breaks 模式：單一 Enter 就換行）；內文插圖寫 `![說明](/img/{id})`。

### 修改文章

```bash
curl https://uaip.cc.cd/api/admin/articles/12 -H "Authorization: Bearer $TOKEN" > cur.json
# 取 cur.json 的 row，改完把「六個欄位都帶齊」（category/status/title/summary/cover/body_md）存成 art.json
curl -X PUT https://uaip.cc.cd/api/admin/articles/12 \
  -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json; charset=utf-8" --data-binary @art.json
```

### 開一個新頁面（新連結）

自訂頁面上線在 `/p/{slug}`，適合「關於本站」「隱私權政策」這類獨立頁：

```bash
# page.json（UTF-8）：slug 只能小寫英數與連字號（頭尾不能是連字號），重複會回 409
# { "slug":"about", "status":"published", "title":"關於本站",
#   "summary":"SEO 描述", "body_md":"## 內容\n\n……" }
curl -X POST https://uaip.cc.cd/api/admin/pages \
  -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json; charset=utf-8" --data-binary @page.json
# 回 { "id":1, "slug":"about", "status":"published", "url":"/p/about" }
```

- 發佈後自動進 sitemap，但**不會自動進側邊欄** — 要入口就接著做下一個流程。
- 更新用 `PUT /api/admin/pages/about`（編號或 slug 都可）；PUT 可改 slug＝搬網址（已被收錄的頁面別亂改）。

### 把連結掛進側邊欄選單

```bash
curl https://uaip.cc.cd/api/menu > menu.json
# 在 menu.json 的 items 適當位置插入（kind:"section" 是分組小標題、"link" 是連結）：
#   { "kind":"link", "label":"關於本站", "label_en":"About", "url":"/p/about" }
# url 必須以 / 或 http(s):// 開頭；整份 items 就是選單的最終樣子（整包覆蓋）
curl -X PUT https://uaip.cc.cd/api/admin/menu \
  -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json; charset=utf-8" --data-binary @menu.json
```

### 查流量

```bash
curl "https://uaip.cc.cd/api/logs?limit=50&since=2026-07-08T16:00:00Z" \
  -H "Authorization: Bearer $TOKEN"
# 回 { rows, total, today, todayIps }；q= 可模糊搜 ip/ua/path/country/isp
```

## 做完怎麼驗證（一定要做）

- 發文後：開 `/news/{id}`（或 `/articles/{id}`）確認 200 且內容正確；列表頁 `/news` 應出現該篇。
- 開頁面後：開 `/p/{slug}` 確認 200；`GET /api/pages` 應列出它。
- 改選單後：任一頁重新整理，左側側邊欄應反映新選單（先 `GET /api/menu` 確認資料）。
  注意 v2.2 的渲染規則：第一個 section 的連結會平鋪、第二個以後的 section 變成可展開群組
  （預設收合，要點開才看得到裡面的連結）—— 資料是對的但「看不到」通常是這個原因。
- 草稿驗證：公開 API（`/api/articles/{id}`、`/api/pages/{slug}`）對草稿回 404 才是對的。

## 錯誤格式

`{ "error":"代碼", "hint":"中文提示?", "detail":"技術細節?" }` — 常見：
400 bad-input/bad-slug（看 hint）、401 unauthorized（金鑰）、404 not-found（不存在或是草稿）、
409 slug-taken、413 too-large（圖 >1.8MB）、415 bad-type（圖片格式）。
完整的參數與欄位規則見 [API.md](./API.md)。

## 要改到程式碼時（僅限改功能/版型，內容操作不需要）

v1.0.0 起本專案有工具鏈（`npm ci` 裝 vitest／wrangler／tsc；**執行期仍零依賴**）：

- **改任何程式前先跑測試**摸清現狀：`npm test`（跑在 workerd 裡，真 D1）；`npm run checks`＝typecheck＋測試。
- **schema 改動走 migration**：新增檔案 `migrations/000N_描述.sql`（**別再改** `migrations/0001_baseline.sql`；
  `db/schema.sql` 已退役刪除）。本機套用 `npm run migrate:local`、正式 `npm run migrate:remote`（純增量，
  先於部署）。測試會自動套 `migrations/` 全部，所以新表新欄記得補測試。
- **改了任何 API（三件套同步，v2.0.0 Phase L 起）**：同步更新 `API.md` ＋ `docs/openapi.yaml`，
  跑 `npm run apidoc` 與 `npm run openapi` 重新產生 `src/lib/apidoc.ts`／`src/lib/openapi.ts`（皆自動產生勿手改）。
  CI 三道防漂移：apidoc、openapi、以及「路由表 × openapi paths 雙向核對」測試（test/int/openapi.test.ts）—
  新路由沒寫進 openapi.yaml 會直接紅燈。必要時也更新本檔與 README 的流程範例。
- **改了 `public/index.html` 的 inline script**：跑 `node tools/check-csp.mjs --print` 拿新 hash 更新
  `public/_headers`（CI 有 CSP 防漂移檢查，忘了會紅燈）。
- 部署：`npm run deploy`（＝重建 apidoc＋openapi＋`wrangler deploy`；不能用後台拖曳上傳）。
- 本機開發：`npm run migrate:local` 建表 →（選用）`npm run seed` 塞種子 → `npm run dev`（localhost 免金鑰）。
- 更完整的架構論述見 [README.md](./README.md) 與 `docs/`（ADR、威脅模型、對照、報告骨架）；
  維護眉角（金鑰更換、備份、圖片快取地雷）見 [ADMIN.md](./ADMIN.md)；已知債務見 [DEBT.md](./DEBT.md)。
