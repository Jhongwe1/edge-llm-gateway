# uaip.cc.cd API 文件

> **這份檔案是 API 文件的敘事原稿。** 線上版 <https://uaip.cc.cd/api-docs>（公開）顯示的內容
> 就是本檔 — 改完本檔要執行 `npm run apidoc` 重新產生 `src/lib/apidoc.ts`，再部署。
> 機器可讀的 OpenAPI 3.1 規格在 [docs/openapi.yaml](./docs/openapi.yaml)（線上 `/openapi.json`、
> /api-docs 有互動式參考）— **改 API 要三件套同步**（本檔＋openapi.yaml＋重產），CI 會核對。
> 給 AI agent 的操作指南（含常用流程與眉角）見 [AGENTS.md](./AGENTS.md)。

網頁後台能做的每一件事，這裡都有對應的 HTTP API — 用 curl、排程或 AI agent 都能操作整個網站。

## 1. 開始之前

| 項目 | 值 |
|---|---|
| 正式站 | `https://uaip.cc.cd`（Cloudflare Workers） |
| 本機開發 | `http://localhost:8787`（`npx wrangler dev`） |
| 回應格式 | 一律 JSON（UTF-8） |
| 時間欄位 | 一律 UTC 的 ISO 8601（例 `2026-07-09T03:00:00.000Z`），顯示時自行轉時區 |

**三種身分**：

1. **公開**：免驗證（whoami、已發佈內容、選單、站名）。
2. **管理員**：路徑含 `/admin` 的、以及 `/api/logs`。兩種通過方式（擇一）：
   - 請求標頭 `Authorization: Bearer <管理金鑰>`（curl／排程／AI agent 用）。管理金鑰＝Cloudflare Workers secret **LOGS_TOKEN**，跟 /logs、/admin 網頁登入同一把；值記在 ADMIN.md（不會上網）。
   - 管理員 Google 帳號的登入 cookie（瀏覽器用）：管理員信箱登入後，管理頁與管理員 API 免金鑰。管理員信箱＝環境變數 **ADMIN_EMAILS**（逗號分隔，例 `admin@example.com`；沒設定＝沒有信箱直升管理員，只認資料庫 users.is_admin）。
   - **本機開發（localhost）免金鑰**；正式站沒帶或帶錯一律回 401。用 cookie 身分時，跨網站送出的請求會被 Origin 檢查擋掉（防 CSRF）。
   - 換金鑰：`printf '新金鑰' | npx wrangler secret put LOGS_TOKEN`，設定後立即生效（Workers secret 不需重新部署）。
3. **會員**：任何人用 Google 登入即為會員（見 `/auth/login`）。會員功能（API 中轉、VPN 訂閱）要**管理員核准**（status=approved）後才生效。
   - 網頁操作靠登入 cookie；**API 中轉**另用會員自己的金鑰 `uak-…`（在 /relay 頁產生，帶法同各家 AI API）。

### 30 秒上手：發一篇新聞

```bat
:: 1) 文章存成「UTF-8 編碼」的 art.json（中文寫在指令列會變亂碼，一定要走檔案）：
::    { "category":"news", "status":"published", "title":"標題",
::      "summary":"一兩句摘要", "cover":"/img/5", "body_md":"內文 **Markdown**" }
:: 2) 送出（Windows cmd 換行符是 ^；Linux/macOS 改用 \）：
curl -X POST https://uaip.cc.cd/api/admin/articles ^
  -H "Authorization: Bearer 管理金鑰" ^
  -H "content-type: application/json; charset=utf-8" ^
  --data-binary @art.json
```

回 `{ "id": 12, "status": "published" }` → 文章立即上線在 `/news/12`。

## 2. 端點總覽

### 公開（免金鑰）

| 方法與路徑 | 用途 |
|---|---|
| `GET /api/whoami` | 訪客自己的連線資訊（IP、UA、地理位置） |
| `GET /api/articles` | 已發佈文章列表（分頁、可篩分類） |
| `GET /api/articles/{id}` | 單篇已發佈文章（含 Markdown 原稿） |
| `GET /api/pages` | 已發佈自訂頁面列表 |
| `GET /api/pages/{slug}` | 單一已發佈自訂頁面 |
| `GET /api/menu` | 側邊欄選單 |
| `GET /api/settings` | 網站公開設定（站名、Playground 是否全員開放、聯絡連結） |
| `GET /api/health` | 健康檢查 `{ ok, version, db }`（部署後 smoke 測試用） |
| `POST /api/csp-report` | CSP 違規回報收集端（瀏覽器自動送；10% 取樣進錯誤日誌；永遠 204） |
| `GET /img/{id}` | 圖片（D1 讀出、邊緣快取一年） |
| `GET /feed` | RSS 訂閱源（最新 20 篇） |
| `GET /sitemap` | 搜尋引擎網址清單（含文章與自訂頁面） |

### 會員（要登入 cookie）

| 方法與路徑 | 用途 |
|---|---|
| `GET /api/me` | 我是誰（登入狀態、被批准的服務清單 `services`、是否管理員；未登入回 `{user:null}`） |
| `POST /api/account/key` | 產生／重生自己的中轉金鑰 `uak-…`（明文只回一次） |
| `DELETE /api/account/key` | 撤銷自己的中轉金鑰 |
| `POST /api/account/vpn-token` | 重生自己的 VPN 訂閱代碼（舊訂閱網址立即失效） |
| `GET /api/relay/channels` | 目前可用的中轉管道清單（含各管道的模型名稱 `models`；不含金鑰） |
| `GET /api/playground/models` | Playground 可選的模型清單（依渠道分組；要有 playground 服務） |
| `POST /api/playground/chat` | Playground 聊天（SSE 串流；要有 playground 服務，見 §5f） |
| `GET /api/playground/conversations` | 自己的 Playground 對話列表 |
| `GET/PUT/DELETE /api/playground/conversations/{id}` | 讀取訊息／改名／刪除自己的對話 |
| `POST /api/playground/files` | 上傳聊天附件圖片（本體＝raw base64，見 §5f） |
| `GET /api/playground/files/{id}` | 讀回附件圖片（只能讀自己的） |

### 會員服務端點（不同驗證）

| 方法與路徑 | 驗證 | 用途 |
|---|---|---|
| `ANY /relay/{管道}/{上游路徑…}` | 會員金鑰 `uak-…` | API 中轉：轉發到上游、串流直通（見 §6） |
| `GET /vpn/sub/{token}` | 訂閱 token 本身 | VPN 訂閱鏡像：給 Clash／v2rayN 直接訂閱（見 §7） |
| `GET /auth/login?next=…` | — | 導向 Google 登入（localhost 提供測試登入表單） |
| `POST /auth/logout` | 登入 cookie | 登出 |

### 管理員（要金鑰）

| 方法與路徑 | 用途 |
|---|---|
| `GET /api/admin/articles` | 全部文章（**含草稿**，依更新時間排序，最多 500 筆） |
| `POST /api/admin/articles` | 新增文章 |
| `GET /api/admin/articles/{id}` | 讀單篇（含草稿、含原稿） |
| `PUT /api/admin/articles/{id}` | 更新文章（**整包覆蓋**） |
| `DELETE /api/admin/articles/{id}` | 刪除文章（不可復原） |
| `GET /api/admin/pages` | 全部自訂頁面（**含草稿**） |
| `POST /api/admin/pages` | **新增自訂頁面（開新連結就靠這支）** |
| `GET /api/admin/pages/{id或slug}` | 讀單頁（含草稿、含原稿） |
| `PUT /api/admin/pages/{id或slug}` | 更新頁面（**整包覆蓋**，可改 slug） |
| `DELETE /api/admin/pages/{id或slug}` | 刪除頁面（不可復原） |
| `POST /api/admin/media` | 上傳圖片 |
| `PUT /api/admin/menu` | 覆蓋側邊欄選單 |
| `GET /api/admin/settings` | 目前存的網站設定原況（給 /settings 管理頁當編輯初值；數字鍵沒設過回 `null`，另附 `defaults`） |
| `PUT /api/admin/settings` | 改網站設定（站名、Playground 全員開放、配額全域預設、計量開關） |
| `GET /api/logs` | 訪客紀錄查詢 |
| `GET /api/admin/errors` | 站內錯誤日誌（`?limit&offset&src`；relay/playground/OAuth/CSP 埋點） |
| `DELETE /api/admin/errors` | 清空錯誤日誌 |
| `GET /api/admin/stats` | 用量統計（`?days=7`；每日×服務、渠道×模型、每人彙總、原始耗時值供算 p95、估算成本）— /logs 用量分頁的數據源 |
| `GET /api/admin/conversations` | 全站 Playground 對話總表（`?limit&offset&q&user_id`；新→舊，帶會員信箱）— /logs 總對話紀錄分頁的數據源 |
| `GET /api/admin/conversations/{id}` | 讀任一會員的單則對話（含全部訊息） |
| `GET /api/admin/prices` | 模型定價表（成本記帳用） |
| `PUT /api/admin/prices` | 覆蓋模型定價表（**整包覆蓋**；pattern 尾端 `*`＝前綴匹配） |
| `GET /api/admin/apidoc` | 這份文件的 Markdown 原稿（`{ md }`） |
| `GET /api/admin/users` | 全部會員（狀態、已批准服務、用量、最後登入） |
| `PUT /api/admin/users/{id}` | 批准／封鎖／升降管理員／分服務批准（`{ action }`，見 §5c） |
| `DELETE /api/admin/users/{id}` | 刪除會員 |
| `GET /api/admin/relay/channels` | 全部中轉管道（上游金鑰遮罩） |
| `POST /api/admin/relay/channels` | 新增中轉管道 |
| `PUT /api/admin/relay/channels/{id}` | 更新管道（整包覆蓋；沒帶 api_key＝保留舊金鑰） |
| `DELETE /api/admin/relay/channels/{id}` | 刪除管道 |
| `GET /api/admin/vpn/channels` | 全部 VPN 渠道（上游訂閱網址遮罩） |
| `POST /api/admin/vpn/channels` | 新增 VPN 渠道（機場訂閱或手動節點） |
| `PUT /api/admin/vpn/channels/{id}` | 更新渠道（整包覆蓋；沒帶 url＝保留舊網址） |
| `DELETE /api/admin/vpn/channels/{id}` | 刪除渠道 |

## 3. 三條鐵則（先讀這個再動手）

1. **PUT 是整包覆蓋**（文章、頁面、選單都是）：先 GET 拿舊資料 → 改要改的欄位 → 整包 PUT 回去。沒帶的欄位會被清空。
2. **圖片編號永遠不能重複使用**：`/img/{id}` 掛一年 immutable 邊緣快取，而 uaip.cc.cd 的快取清除權在 cc.cd 網域主手上、我們清不掉。刪過的編號作廢；換圖＝上傳拿新編號＋更新文章裡的網址。也**不要**重設 media 表的流水號。
3. **中文內容一定走 UTF-8 檔案**：curl 用 `--data-binary @檔案` 傳送；把中文直接寫在 Windows 指令列會變亂碼（實測踩過）。

## 4. 公開 API 詳細

### GET /api/whoami

回傳由 Cloudflare 邊緣節點觀測到的請求資訊。欄位：`ip`、`ua`、`lang`、`country`、`city`、`region`、`region_code`、`postal`、`latitude`、`longitude`、`timezone`、`asn`、`isp`、`colo`、`http`、`tls`。

### GET /api/articles — 已發佈文章列表

| 參數 | 說明 |
|---|---|
| `category` | `news` 或 `article`；省略＝全部 |
| `p` | 頁碼，預設 1 |
| `per` | 每頁筆數 1–50，預設 10 |

回 `{ rows, total, page, per, pages }`；rows 每筆含 `id`、`category`、`title`、`summary`、`cover`、`views`、`published_at`，依發佈時間新到舊。草稿一律看不到；用 API 讀**不會**增加瀏覽數（views 只算真人看文章頁）。

### GET /api/articles/{id} — 單篇已發佈文章

回 `{ row }`，含 `body_md`（Markdown 原稿）。加 **`?html=1`** 多回 `body_html`（伺服器轉好的 HTML，跟正式文章頁同設定）。找不到或還是草稿 → 404。

### GET /api/pages — 已發佈自訂頁面列表

回 `{ rows }`，每筆含 `slug`、`title`、`summary`、`updated_at`。每頁的公開網址＝ **`/p/{slug}`**（例 slug=about → `https://uaip.cc.cd/p/about`）。

### GET /api/pages/{slug} — 單一已發佈自訂頁面

回 `{ row }`，含 `body_md`。加 **`?html=1`** 多回 `body_html`。找不到或還是草稿 → 404。

### GET /api/menu — 側邊欄選單

回 `{ items, custom }`。items 是「由上到下」的平面陣列，每項：

| 欄位 | 說明 |
|---|---|
| `kind` | `section`（分類標題）或 `link`（連結） |
| `label` | 中文名稱 |
| `label_en` | 英文名稱（空字串＝英文介面也顯示中文） |
| `url` | 連結網址（section 為空字串） |

`custom:false` 表示還沒自訂過，回的是內建預設選單。

VPN 過濾（v2.2）：跟頁面外殼同一套規則 — `/vpn` 項只回給「管理員／被批准 vpn 服務的登入會員」，或管理員開了 `vpn_public`（對外展示）。帶管理金鑰（`Authorization: Bearer`）呼叫一律回**未過濾**的完整清單（選單編輯器要用）。

### GET /api/settings — 網站公開設定

回 `{ brand, custom, pg_open, contact_url, demo }`。brand＝站名（用在分頁標題、og:site_name、JSON-LD、RSS 頻道名）；`custom:false` 表示用內建預設（＝正式網址主機名）。`pg_open`＝Playground 是否對所有登入會員開放（見 §5 的網站設定）。`contact_url`＝管理員聯絡連結（會員頁登入閘門的「聯絡管理員」鈕；空字串＝沒設定、前端不顯示該鈕）。`demo`＝Playground 體驗模式是否開放匿名試聊（布林；渠道與額度細節不公開）。

## 5. 管理員 API 詳細

### 文章：/api/admin/articles

POST（新增）與 PUT（更新）共用同一組 JSON 欄位：

| 欄位 | 規則 |
|---|---|
| `category` | `news`（新聞）或 `article`（文章）；預設 news |
| `status` | `draft`（草稿）或 `published`（發佈）；預設 draft |
| `title` | **必填**，最長 200 字 |
| `summary` | 最長 500 字 — 列表兩行摘要，也是搜尋結果與分享卡描述 |
| `cover` | 縮圖網址，最長 300 字（通常是 `/img/{id}`，也可貼外部網址） |
| `body_md` | 內文 Markdown，最長 200KB（空一行分段、`## 小標`、`**粗體**`、`[文字](網址)`、插圖 `![說明](/img/{id})`；breaks 模式：按一次 Enter 就是換行） |

- POST 回 `{ id, status }`；PUT 回 `{ id, status }`；DELETE 回 `{ ok:true }`。
- `published_at` 在**第一次發佈**時寫入，之後再編輯、轉草稿再發佈都不變（列表排序穩定）。
- 文章上線網址：`/news/{id}` 或 `/articles/{id}`（依 category）。

### 自訂頁面：/api/admin/pages — 用 API 開新連結

新增一個頁面＝網站多一個公開網址 **`/p/{slug}`**。適合「關於本站」「隱私權政策」「聯絡方式」這類獨立頁。

POST 與 PUT 共用欄位：

| 欄位 | 規則 |
|---|---|
| `slug` | **必填** — 網址代稱：小寫英數與連字號（頭尾不能是連字號），最長 64 字。例 `about`、`privacy-policy` |
| `title` | **必填**，最長 200 字（頁面大標＋分頁標題） |
| `status` | `draft`（草稿）或 `published`（發佈）；預設 draft。**草稿對外看不到** |
| `summary` | 最長 500 字 — meta description（SEO 與分享卡描述） |
| `body_md` | 內文 Markdown，最長 200KB（規則同文章） |

- POST 回 `{ id, slug, status, url }`；slug 已被用回 **409 `{ error:"slug-taken" }`**。
- 單頁路由 `/{id或slug}`：純數字當編號、其他當 slug，兩種都可以（agent 用 slug 比較直覺）。
- PUT 可以改 slug（頁面搬新網址，舊網址會變 404 — 已被收錄或被連結的頁面不建議改）。
- 發佈後自動進 `/sitemap`；**不會**自動出現在側邊欄 — 要掛選單就再 `PUT /api/admin/menu` 加一條 url 為 `/p/{slug}` 的連結（見下）。

建立並發佈一個「關於本站」頁：

```bat
:: page.json（UTF-8）：
::   { "slug":"about", "status":"published", "title":"關於本站",
::     "summary":"這個網站是誰、在做什麼。", "body_md":"## 哈囉\n\n這裡是……" }
curl -X POST https://uaip.cc.cd/api/admin/pages ^
  -H "Authorization: Bearer 管理金鑰" ^
  -H "content-type: application/json; charset=utf-8" --data-binary @page.json
:: 回 { "id":1, "slug":"about", "status":"published", "url":"/p/about" }
```

### 圖片：POST /api/admin/media

- 請求本體＝圖片**二進位**（不是表單、不是 base64），Content-Type 帶 `image/webp`、`image/jpeg`、`image/png` 或 `image/gif`。
- 大小上限 **1.8MB**（D1 單值限 2MB）。走 API 上傳**不會自動壓縮**，請先自己縮好（建議最寬 1400–1600px、JPEG 品質 85 左右）；網頁後台上傳才有自動壓縮。
- 可選參數 `?w=寬&h=高`（記尺寸，後台顯示用）。
- 回 `{ id, url, bytes, w, h }`，url 形如 `/img/9` — 填進文章 cover，或以 `![說明](/img/9)` 插進內文。

```bat
curl -X POST "https://uaip.cc.cd/api/admin/media?w=1400&h=788" ^
  -H "Authorization: Bearer 管理金鑰" ^
  -H "content-type: image/jpeg" --data-binary @cover.jpg
```

### 選單：PUT /api/admin/menu

本體 `{ "items": [ … ] }`，格式同 GET /api/menu 的 items；整份選單照陣列順序**覆蓋**寫入。

- 每項規則：`label` 必填最長 60 字；`label_en` 選填最長 60 字；link 的 `url` 必填最長 300 字，**必須以 `/` 或 `http://` 或 `https://` 開頭**；最多 60 項。
- 傳 **`{ "items": [] }`（空陣列）＝清掉自訂選單＝還原內建預設**。
- 回 `{ ok, count, custom }`。
- 側邊欄的「管理員區」（管理員設定、訪客紀錄、API 文件）不在選單資料裡 — 那是登入過的裝置由前端動態長出來的，改不到也不用管。

標準流程（先拿現況、改完整包放回）：

```bat
curl https://uaip.cc.cd/api/menu > menu.json
:: 編輯 menu.json，例如 items 尾端加 { "kind":"link", "label":"關於本站",
::   "label_en":"About", "url":"/p/about" }，然後：
curl -X PUT https://uaip.cc.cd/api/admin/menu ^
  -H "Authorization: Bearer 管理金鑰" ^
  -H "content-type: application/json; charset=utf-8" --data-binary @menu.json
```

### 網站設定：GET / PUT /api/admin/settings

**GET**（2026-07-17，/settings 管理頁的數據源）回目前**存的**原況：`{ ok, brand, custom, contact_url, pg_open, pg_default_system, relay_meter, quota_relay_day, quota_pg_day, rl_per_min, demo_mode, demo_active, demo_channel, demo_models, demo_per_min, demo_per_ip_day, demo_global_day, demo_max_tokens, tg_chat_id, tg_token_set, tg_token_hint, tg_env_set, tg_active, defaults }` — 數字鍵沒設過回 `null`（不是內建預設值），內建預設放在 `defaults` 物件；`demo_mode` 是開關本身的儲存值、`demo_active` 才是真正生效與否（開關＋`demo_channel` 都要有）；Telegram bot token **絕不回明文**（只回 `tg_token_set` 與尾 4 碼 `tg_token_hint`）。

**PUT：本體帶哪個鍵就改哪個鍵，沒帶的不動**（2026-07-14 起；跟文章／選單的整包覆蓋不同）。回 `{ ok, brand, custom, contact_url, pg_open, pg_default_system, quota_relay_day, quota_pg_day, rl_per_min, relay_meter, demo_* }`（改完的現況；配額鍵沒設過時顯示內建預設）。

| 鍵 | 說明 |
|---|---|
| `brand` | 站名，最長 60 字；**傳空字串＝還原內建預設**（＝正式網址主機名）。改完立即生效（分頁標題、og:site_name、JSON-LD、RSS 頻道名；主站首頁的「IP·UA 查詢」標題不受影響） |
| `contact_url` | 管理員對外聯絡連結（`http(s)://` 開頭，最長 300 字）；顯示在會員頁登入閘門的「聯絡管理員」鈕。**空字串＝移除＝不顯示聯絡鈕** |
| `pg_open` | `true`／`false` — **Playground 開放給所有登入會員**：開啟後任何登入會員不用逐一批准就能用 Playground（被封鎖的帳號照樣擋；只影響 playground，relay 與 vpn 照舊看個人批准）。`false`＝回到逐人批准。網頁上在 /members 頁最上方也有這顆開關 |
| `pg_default_system` | **Playground 的預設系統提示詞**（2026-07-21；最長 4000 字，超過截斷）：所有**沒有自己填** `system_prompt` 的渠道共用這一段 — 改一次等於一次換掉全部渠道，不必逐個開視窗。渠道自己填了就以渠道為準（不疊加）。**空字串＝刪鍵＝還原程式內建的 `PG_DEFAULT_SYSTEM`**；GET 的 `defaults.pg_default_system` 就是那段內建值（網頁上拿它當灰字）。**只作用在 `/playground`**，`/relay` 中轉照樣不注入任何東西。網頁在 /settings 的「Playground 預設系統提示詞」卡 |
| `quota_relay_day` | 中轉每日請求數的**全域預設**（正整數）；`null` ＝ 回到內建預設 500。個人覆寫（§5c 的 `set_quota`）優先於這個值；**管理員完全不吃配額** |
| `quota_pg_day` | Playground 每日訊息數的全域預設；`null` ＝ 內建預設 200 |
| `rl_per_min` | 每分鐘請求數上限（滾動 60 秒、中轉＋Playground 合併計）；`null` ＝ 內建預設 30 |
| `relay_meter` | `false` ＝ 中轉退回**純直通**（不掃 usage、不寫 req_log）— 計量出怪問題時的免部署保險；`true` ＝ 恢復計量（預設）。平常不要動 |
| `tg_bot_token` | Telegram 告警的 bot token（2026-07-17 起可存這裡；最長 100 字，**空字串＝刪鍵**）。cron 每 5 分鐘掃 errlog 推播時**這裡優先**、Cloudflare secrets（TG_BOT_TOKEN）後備。回讀一律遮罩（`tg_token_set`／`tg_token_hint`）、audit 不落明文。網頁在 /settings 的「Telegram 告警」卡 |
| `tg_chat_id` | Telegram 告警的 chat id（最長 50 字，空字串＝刪鍵；同樣 D1 優先、secrets TG_CHAT_ID 後備）。token 與 chat id **都設好**告警才會發送 |
| `demo_mode` | `true`／`false` — **Playground 體驗模式**（2026-07-17 v2.0.0）：開啟後**未登入訪客**可直接在 /playground 試聊。要同時設好 `demo_channel` 才生效。fail-closed 限流（詳見 ADR-0009）：每 IP 每分鐘／每日＋全站每日三道上限，限流器故障時直接 503 絕不放行 |
| `demo_channel` | 體驗模式鎖定的渠道 slug（**必設**，沒設＝demo 不生效）；訪客只能用這個渠道 |
| `demo_models` | 體驗模式的模型白名單（逗號分隔）；空＝該渠道全部模型 |
| `demo_per_min` | 體驗模式每 IP 每分鐘上限；`null`＝內建預設 3 |
| `demo_per_ip_day` | 每 IP 每日上限；`null`＝內建預設 10 |
| `demo_global_day` | **全站**每日上限（燒錢保險）；`null`＝內建預設 200 |
| `demo_max_tokens` | 體驗模式每則回覆的 token 上限；**`null`（留空）＝不限** — 跟會員路徑一樣不對上游設 `max_tokens`（anthropic 例外：那家必填，維持 4096）。要硬性壓每則成本才填正整數 |
| `dumb_mode` | `true`／`false` — **Dumb mode**（2026-07-22 v2.2）：把所有會員鎖在單一「隱藏」模型。開啟且 `dumb_channel`＋`dumb_model` 都設好才生效（GET 回 `dumb_active` 表示實際生效與否）。生效時非管理員會員：`/api/playground/models` 只回 `{ rows:[], dumb:true }`、聊天請求的 channel/model 一律被伺服器蓋成指定值、對話列表與內頁的 channel/model 遮空 — 會員不知道也改不了正在用什麼模型。**體驗模式也會跟著隱藏模型選單**，但訪客實際跑的仍是 `demo_channel`＋`demo_models` 第一個（成本上限不被蓋掉，見 §5f）。**管理員不受限**；不影響 API 中轉。網頁在 /settings 的「Playground」卡 |
| `dumb_channel` | Dumb mode 鎖定的渠道 slug（空字串＝刪鍵＝不生效） |
| `dumb_model` | Dumb mode 鎖定的模型名（要在該渠道的模型清單裡；空字串＝刪鍵） |
| `vpn_public` | `true`／`false` — **VPN 對外展示**（2026-07-22 v2.2）：開啟後側邊欄選單與 /vpn 頁對**所有訪客**可見（未批准者看到登入／等待批准閘門；訂閱本身仍要逐人批准 vpn 服務）。`false`（預設）＝維持 VPN 隱形：選單不渲染、/vpn 裝成不存在。網頁在 /settings 的「VPN」卡 |

```bat
curl -X PUT https://uaip.cc.cd/api/admin/settings ^
  -H "Authorization: Bearer 管理金鑰" ^
  -H "content-type: application/json" --data-binary "{\"brand\":\"新站名\"}"

:: Playground 開放給所有登入會員（false＝關閉）：
curl -X PUT https://uaip.cc.cd/api/admin/settings ^
  -H "Authorization: Bearer 管理金鑰" ^
  -H "content-type: application/json" --data-binary "{\"pg_open\":true}"
```

### 模型定價（成本記帳）：/api/admin/prices

成本記帳（2026-07-17 v2.0.0）：req_log 早就記了每次請求的 token 數，這張定價表讓 stats 與 /logs 用量分頁能把 token 換算成**估算**美元成本。定價只影響報告顯示，不影響配額（配額算次數，見 §網站設定）。

- `GET` → `{ items: [ { pattern, input_usd_per_m, output_usd_per_m, note, updated_at }, … ] }`
- `PUT` 本體 `{ items: [ … ] }`，**整包覆蓋**（跟選單同款：先 GET → 改 → 整包 PUT；空陣列＝清空）。

| 欄位 | 說明 |
|---|---|
| `pattern` | 模型名稱；尾端 `*` ＝前綴匹配（例 `gpt-4o*`）。**精確名優先於前綴、前綴取最長**（`gpt-4o-mini*` 贏過 `gpt-4o*`） |
| `input_usd_per_m` | 每百萬 input tokens 的美元價（≥0） |
| `output_usd_per_m` | 每百萬 output tokens 的美元價（≥0） |
| `note` | 備註（例：官網牌價日期），最長 200 字 |

```bat
curl -X PUT https://uaip.cc.cd/api/admin/prices ^
  -H "Authorization: Bearer 管理金鑰" ^
  -H "content-type: application/json" ^
  --data-binary "{\"items\":[{\"pattern\":\"gpt-4o*\",\"input_usd_per_m\":2.5,\"output_usd_per_m\":10}]}"
```

沒對上定價的模型在 stats 回應的 `unpriced_models` 陣列與 /logs 用量分頁會被點名提醒。

### 訪客紀錄：GET /api/logs

| 參數 | 說明 |
|---|---|
| `limit` | 1–200，預設 50 |
| `offset` | 分頁位移 |
| `q` | 模糊搜尋（ip / ua / path / country / city / isp） |
| `since` | ISO 時間 — 額外回傳該時間之後的瀏覽數與不重複 IP 數（today / todayIps） |

回 `{ rows, total, today?, todayIps? }`。

### 總對話紀錄：/api/admin/conversations

管理視角看**全站會員**在 Playground 存下的對話（2026-07-20 上線）——會員版 `/api/playground/conversations` 只看得到自己的，這兩支不限擁有者。網頁在 **/logs 的「總對話紀錄」分頁**。

`GET /api/admin/conversations`

| 參數 | 說明 |
|---|---|
| `limit` | 1–200，預設 50 |
| `offset` | 分頁位移 |
| `q` | 模糊搜尋（標題／會員信箱／姓名／模型／渠道；**不搜訊息內容**）。網頁上沒有這個欄位，只給 curl／agent 用 |
| `user_id` | 只看某個會員的對話 |

回 `{ rows, total }`，`rows` 依 `updated_at` **新→舊**；每列：`id`、`user_id`、`email`、`name`（對話是誰的）、`title`、`channel`、`model`、`msgs`（訊息則數）、`created_at`、`updated_at`。帳號已刪除時 `email`／`name` 是 `null`。

`GET /api/admin/conversations/{id}` → `{ conv, messages }`：`conv` 是那列（額外帶 `email`、`name`），`messages` 依時間**舊→新**（聊天的閱讀順序）、上限 500 則，每則 `id`、`role`、`content`、`model`、`created_at`。找不到回 404。

> 這兩支**唯讀**——管理員這邊不提供刪除，避免誤刪會員資料；會員自己可以在 /playground 刪自己的對話。
> 體驗模式（未登入試用）的對話**也在這裡**（2026-07-21 起），成員一律顯示成 `demo:public` 那列「體驗模式（匿名訪客合計）」、`email` 是空字串。訪客自己沒有任何讀取管道 — `/api/playground/conversations` 系列都要登入，這些對話只有管理員看得到。

## 5b. 會員與帳號 API

- `GET /api/me` → `{ user }`（未登入 `{ user:null }`）。user 含 `email`、`name`、`picture`、`status`（pending/approved/blocked）、`is_admin`、`approved`、`services`（被批准的服務陣列，如 `["relay","vpn","playground"]`；管理員固定是全部）、`has_key`、`key_hint`、`key_at`、`relay_calls`、`usage`（2026-07-14 起：今日用量 `{ relay_today, relay_limit, pg_today, pg_limit }` — 只含有權限的服務、管理員 limit 是 `null`＝無上限、兩服務都沒權限時整塊省略；UTC 午夜重置）。**`vpn_token`／`vpn_pulls` 只有「管理員或被批准 vpn 服務」的人才有**（VPN 隱形：無權限者連鍵都不出現，`/vpn` 頁對他們也回 SPA、選單也不渲染）。
- `POST /api/account/key` → `{ key, key_hint, key_at }`。**key 明文只在這次回應出現**，資料庫只存 SHA-256；重生會讓舊金鑰立即失效。`DELETE` 撤銷。
- `POST /api/account/vpn-token` → `{ vpn_token }`。重生訂閱代碼（舊 `/vpn/sub/<舊token>` 立即失效）。
- `POST /api/account/logout-all`（2026-07-14）→ `{ ok }`。**登出所有裝置**：刪光自己全部 session（含這一把）並清本機 cookie。手機不見／公用電腦忘了登出時用；頭像下拉選單也有這個鈕。
- 以上都要登入 cookie；跨站請求被 Origin 擋（403 bad-origin）。

## 5c. 成員管理：/api/admin/users（分服務批准）

2026-07-13 起改**分服務批准**：三個服務 `relay`（API 中轉站）、`vpn`、`playground`（Playground）可以分別開關，存在 `users.services`（逗號分隔）。管理員帳號不看清單、全部服務都能用。

> `playground` 另有**全站開關**（`PUT /api/admin/settings` 的 `pg_open`，見 §5）：開啟時所有登入會員都能用 Playground、不看個人批准（`/api/me` 的 `services` 也會多出 playground）；關閉才回到這裡的逐人批准。relay 與 vpn 沒有全站開關。

- `GET` → `{ rows }`：每筆 `id`、`email`、`name`、`picture`、`status`、`services`（逗號分隔字串）、`is_admin`、`relay_calls`、`vpn_pulls`、`last_login`、`created_at`、配額覆寫欄（`quota_relay_day`、`quota_pg_day`、`rl_per_min`；`null`＝用全域）、今日用量（`relay_today`、`pg_today`，UTC 日窗）；排序 pending 在前。
- `PUT /api/admin/users/{id}` 本體三選一：
  - `{ "action": "approve" | "block" | "unblock" | "make_admin" | "drop_admin" }` — `approve` 是快速鍵＝**一次批准全部服務**；`unblock` 恢復原本的服務清單（清單是空的就退回 pending）。封鎖會同時把該會員踢下線（刪其 session）。
  - `{ "action": "set_services", "services": ["relay","vpn"] }` — **整包覆蓋**服務清單（只收合法服務名）。給了任何服務＝status 變 approved；全部收回＝退回 pending；封鎖中的帳號只改清單、狀態不動。
  - `{ "action": "set_quota", "quota_relay_day": 100, "quota_pg_day": null, "rl_per_min": 10 }` — **個人配額覆寫**（2026-07-14）：帶哪鍵改哪鍵；值收 0 以上整數（0＝直接關掉該服務的額度）或 `null`＝清掉覆寫、回到全域預設（§5 的網站設定）。管理員帳號不吃配額，設了也沒作用。網頁上在 /members 每個會員的「配額」鈕（有自訂會多顯示 `*`）
  - `{ "action": "revoke_sessions" }` —（2026-07-14）撤銷該會員**所有裝置**的登入狀態（session 全刪；帳號狀態與服務不動）。懷疑帳號被冒用時先用這個。
- 所有變更（users／settings／channels／menu／articles／pages／media）都會寫 **audit_log**（誰、何時、對誰、做了什麼；summary 絕不含金鑰或上游網址本體）。
- `DELETE /api/admin/users/{id}` 刪除帳號。
- **護欄**：不能封鎖／降級／刪除自己；也不能動到 ADMIN_EMAILS 指定的管理員帳號（回 403 protected — 要改就改環境變數）。

## 5d. API 中轉站

**管理員設管道**（存 `relay_channels` 表）：`POST /api/admin/relay/channels`，本體：

| 欄位 | 規則 |
|---|---|
| `slug` | **選填** 網址代稱（小寫英數與連字號）。留空＝自動從名稱產生（轉不出英數就隨機 `ch-xxxxxx`，撞名自動補尾碼）；**PUT 時留空＝沿用舊代稱**（會員的 /relay 網址不變）。網頁表單 2026-07-14 起已不顯示這欄 |
| `name` | **必填** 顯示名稱 |
| `kind` | `openai`（含所有 OpenAI 相容服務與本地 AI）／`anthropic`／`gemini`／`custom`；決定金鑰帶給上游的方式 |
| `base_url` | **必填** 上游根網址，例 `https://api.openai.com` |
| `api_key` | 上游金鑰（只有管理員 API 摸得到，回讀一律遮罩） |
| `models` | **必填** 這個管道可用的模型名稱（陣列，或逗號／換行分隔的字串；限英數與 `. _ / : -`、上限 40 個）。會員頁與 Playground 都靠這份清單 |
| `system_prompt` | **選填** 這個管道在 **Playground** 的系統提示詞（上限 8000 字，超過回 400、不截斷）。**留空＝套用站台預設**（`PUT /api/admin/settings` 的 `pg_default_system`，沒設過就是程式內建的 `PG_DEFAULT_SYSTEM`；管理員視窗那格的灰字顯示的就是當下實際會套的那段）；填了就**整段取代**預設。要一次改掉全部渠道的人設就改站台預設，不必逐個渠道填。**只作用在 `/playground`**：`/relay` API 中轉是透明代理，一律不注入任何提示詞 — 會員自己送什麼就轉什麼 |
| `sort_order` | **選填**（2026-07-29 v2.3）整數，決定 **Playground 模型選單裡「管道之間」的先後**（小的在前；同分退回 id，所以舊資料順序不變）。管道**之內**的模型順序照 `models` 的行序 —— 想調哪個模型排前面，把它移到清單第一行即可。**沒帶＝維持原值**（跟 `api_key` 同一套 undefined 語意，普通的欄位編輯不會把排序洗掉）。網頁上在 /relay 管道列表用 ↑↓ 調整 |
| `vision_models` | **選填**（2026-07-29 v2.3）這個管道裡**看得懂圖片**的模型（陣列或換行/逗號分隔字串），**必須是 `models` 的子集**（填了沒開放的模型回 400）。**留空＝這個管道不支援附圖**——各家都沒有查詢模型能力的端點、名字也看不出來，所以一律預設不支援，管理員明確填了才開放。會員在 /playground 的附件鈕會依這份清單決定能不能點 |
| `extra_body` | **選填** 合併進 **Playground** 上游請求本體的額外參數，必須是 **JSON 物件字串**（上限 4000 字；存檔當下就驗，不合法回 400）。**留空＝不合併任何東西**（注意：跟 `system_prompt` 的「留空＝套預設」相反，網頁上那格的灰字只是範例）。用來處理各家專屬參數，例 `{"venice_parameters":{"include_venice_system_prompt":false}}`、OpenAI 的 `reasoning_effort`、Anthropic 的 `thinking`。`model`／`stream`／`messages`／`contents` 擋著**不給覆寫**。**只作用在 `/playground`**，`/relay` 中轉不注入 |
| `enabled` | 預設 true |

- `GET` → `{ rows }`，每筆含 `models`（陣列）、`has_key`、`key_hint`（金鑰一律遮罩）。
- `PUT /api/admin/relay/channels/{id}` 整包覆蓋（**`models` 也要帶齊**）；**本體沒帶 `api_key` 欄位＝保留舊金鑰**（帶空字串＝清掉）。`system_prompt` 照整包覆蓋規則走 — **沒帶＝清空**（只有 `api_key` 因為是機密才特別「沒帶＝保留」）。
- `extra_body` 為什麼需要（2026-07-20 實測）：Venice 這類供應商會在你的系統提示詞**後面**再注入一大段自己的（含 `You are running on Venice.ai` 與模型身分覆寫），排在後面又更具體，直接壓過管道設定的人設 — 要填 `{"venice_parameters":{"include_venice_system_prompt":false}}` 才關得掉。與其為單一供應商寫死，開成通用欄位。`model` 不給覆寫是刻意的：它經過渠道白名單驗證，能從這裡改等於繞過驗證用沒開放的模型。
- 預設提示詞定義在 `src/lib/playground.ts` 的 `PG_DEFAULT_SYSTEM`（單一真相來源 — 管道視窗的灰字是 import 過去顯示的，改常數 UI 跟行為一起變）。
- `system_prompt` 注入到哪：`anthropic` → 請求的 `system` 欄位；`gemini` → `systemInstruction`；`openai`／`custom` → `messages` 最前面補一則 `system`。對話裡原本就有的 `system` 訊息接在管道提示詞**後面**，兩者都生效、不互相覆蓋。提示詞每次請求即時注入，**不會**存進對話紀錄（`pg_messages`），所以改了立刻對舊對話生效。
- 網頁上新增管道時，選 kind 會自動帶入該家的**官方 Base URL**；用其他供應商（便宜渠道／自架／本地模型）直接改掉即可（你手打過的網址不會被自動蓋掉）。
- 會員看的 `GET /api/relay/channels` → `{ rows:[{ slug, name, kind, models }], approved }`（approved＝有沒有被批准 relay 服務）；/relay 頁上每個模型名稱都有一鍵複製。

**上游金鑰放哪個標頭：依「路徑」決定，不是只看 kind**（2026-07-12 實測修正）。各家都有兩套介面：

| 上游路徑 | 中轉送出的驗證頭 |
|---|---|
| 含 `/openai/` 或結尾是 `chat/completions`（各家的 **OpenAI 相容層**） | `Authorization: Bearer` |
| Anthropic 原生 `v1/messages` | `x-api-key` |
| Gemini 原生 `v1beta/models/…` | `x-goog-api-key` |
| 其他（openai／custom） | `Authorization: Bearer` |

> ⚠️ **Gemini 原生端點不能多送 `Authorization`**：Google 一看到這個標頭就當成 OAuth token，直接回 401「API keys are not supported by this API」。所以是二選一，不能兩個都送。

**會員使用**：把 AI 工具的 Base URL 設成 `https://uaip.cc.cd/relay/{slug}`、API Key 填自己的 `uak-…`：

```
POST https://uaip.cc.cd/relay/openai/v1/chat/completions
Authorization: Bearer uak-你的金鑰
→ 伺服器驗身分＋核准狀態 → 換成管理員存的上游金鑰 → 轉發到 https://api.openai.com/v1/chat/completions
```

- 金鑰放哪都收：`Authorization: Bearer`、`x-api-key`、`x-goog-api-key`、`?key=`（配合各家 SDK）。
- 路徑照上游原本的填（中轉只換金鑰不改路徑）；回應串流直通。`model` 參數也原樣轉發 — 填管道 `models` 清單裡的名稱即可。
- 未帶金鑰 401、金鑰無效 401、帳號未被批准 relay 服務 403、管道不存在或停用 404、上游連不上 502。
- **配額（2026-07-14）**：超過每日額度回 `429 { error:"quota-exceeded", hint, used, limit, reset, contact_url? }`、請求太快回 `429 { error:"rate-limited", … }`，都帶 `Retry-After` 標頭（秒）。額度＝個人覆寫 → 全域設定 → 內建預設（中轉 500/日、每分鐘 30）；**管理員完全豁免**。今日用量顯示在 /relay 頁與 `GET /api/me` 的 `usage`。
  - **`contact_url`（2026-07-21）**：管理員有設聯絡連結（`PUT /api/admin/settings` 的 `contact_url`，跟未登入閘門那顆「聯絡管理員」鈕同一條）時，日額度 429 的 `hint` 尾端會接上該網址，並多回一個 `contact_url` 欄位給前端做成可點的連結（沒設＝兩者都不出現，文案維持原樣）。「請聯絡管理員」卻不給聯絡方式等於叫人自己想辦法。**每分鐘的 `rate-limited` 不接** — 那是等一下就好、不必找人。體驗模式的日額度 429（`demo-rate-limited`／`demo-quota-exceeded`）2026-07-21 起照同一套，每分鐘那條同樣不接。
- **計量**：伺服器順流掃「回應」尾端的 `usage`／`model` 記進 req_log（延遲、token 數；研究數據用）— 只看上游回應、絕不緩衝或解析你送出的內容；會員中斷連線時上游立即取消。

## 5e. VPN 訂閱（多渠道）

跟中轉站同一個模式：管理員到處找便宜機場／自架節點，**每找到一個就加一個渠道**；會員永遠只有一條訂閱網址，伺服器把所有「啟用中」渠道的節點合併給他，**會員看不到渠道存在，也看不到上游網址**。

**管理員設渠道**（存 `vpn_channels` 表）：`POST /api/admin/vpn/channels`，本體：

| 欄位 | 規則 |
|---|---|
| `name` | **必填** 顯示名稱（只有管理員看得到，例「某機場 月付3元」） |
| `kind` | `sub`（機場給的訂閱網址，預設）或 `nodes`（自己貼的節點連結） |
| `url` | `kind=sub` **必填**：上游訂閱網址（回讀一律遮罩） |
| `nodes` | `kind=nodes` **必填**：一行一條 `vmess://`／`vless://`／`trojan://`… |
| `enabled` | 預設 true；false＝暫時不併進會員訂閱（渠道還留著） |

- `PUT /api/admin/vpn/channels/{id}` 整包覆蓋；**本體沒帶 `url` 欄位＝保留舊網址**（帶空字串＝清掉）。
- `GET /api/admin/vpn/channels` → `{ rows }`，每筆 `id`、`name`、`kind`、`enabled`、`has_url`、`url_hint`（遮罩）、`nodes`、`node_count`。

**會員使用**：`GET /vpn/sub/{token}`（token＝會員的 `vpn_token`，等於通行證，免登入方便 App 定時抓）。把這網址加進 Clash／v2rayN／Shadowrocket 的訂閱即可。未核准／被封鎖 → 403。

伺服器依渠道數自動選最相容的合併方式：

| 啟用中的渠道 | 回給會員的內容 |
|---|---|
| 只有 `nodes` 渠道 | 全部手動節點，合併去重 → 標準 base64 訂閱 |
| 恰好 1 個 `sub` 渠道 | **原樣轉發**（透傳會員 App 的 UA，所以機場回 Clash YAML 也沒問題；流量／到期資訊 Subscription-Userinfo 照傳）。上游若是 base64，手動節點會解碼附加後重新編碼 |
| 2 個以上 `sub` 渠道 | 各渠道用 v2rayN UA 並行抓取（邊緣快取 5 分鐘）→ 解碼 → 全部節點＋手動節點合併去重 → 一份 base64 訂閱。解不開的（Clash YAML）略過；多渠道時流量資訊無法合併，不回傳 |

> 想同時吃多個機場又要保留流量顯示，就只啟用那一個機場的渠道；其餘用 `enabled:false` 暫存。

## 5f. Playground（/playground）

會員在網頁上直接試用中轉渠道裡的模型（2026-07-13 上線）。可選的模型＝各中轉管道的 `models` 清單；
上游金鑰全程留在伺服器，會員只帶登入 cookie。對話存 D1、綁帳號、跨裝置同步。
驗證：登入 cookie（要有 `playground` 服務，**或**管理員開了 `pg_open` 全員開放，見 §5）**或** `Authorization: Bearer <管理金鑰>`（以管理員帳號的身分操作，方便 curl／agent 測試）。

**體驗模式（2026-07-17 v2.0.0，ADR-0009）**：管理員開 `demo_mode`＋設 `demo_channel` 後，**完全未登入**的訪客也能打 `GET /api/playground/models`（只回 demo 那一組、渠道顯示名固定「體驗模式」）與 `POST /api/playground/chat`（SSE 第一筆事件是 `{conv,title?,demo:true}` — `demo:true` 是給前端的旗標「別去動對話列表」，`conv` 照給，前端靠它把同一頁的後續訊息串成同一則）。限制：渠道與模型鎖白名單、輸入整包 4000 字、`demo_max_tokens` 有填才壓回覆長度；**對話會存進資料庫**（2026-07-21 起）但掛在 `demo:public` 名下、**只有管理員的 `/api/admin/conversations` 看得到**，訪客沒有任何讀取管道；fail-closed 限流（每 IP 分鐘/日＋全站日；超額 429 `demo-rate-limited`／`demo-quota-exceeded`，限流器故障 503 `demo-unavailable`）。**日額度用完的兩種 429 會附 `contact_url`**（管理員有設的話；文案不提 IP，`hint` 尾端也接同一條網址）— 跟會員配額同一套，見 §6 的 `contact_url`；每分鐘那條不附（等一下就好）。

**Dumb mode（2026-07-22 v2.2）**：管理員開 `dumb_mode`＋指定 `dumb_channel`×`dumb_model`（見 §5 網站設定）後，**非管理員會員**被鎖在那一個模型且看不到它是什麼：`models` 只回 `{ rows:[], dumb:true }`（前端據此隱藏模型選單、聊天不帶 channel/model）；`chat` 的 channel/model 一律被伺服器蓋成指定值；對話列表與內頁的 `channel`/`model` 欄位遮成空字串。管理員與 API 中轉不受影響。

**體驗模式也一起噤聲**：dumb 開著時匿名訪客的 `models` 同樣只回 `{ demo:true, rows:[], dumb:true }`，`chat` 的 channel/model 也被蓋掉。但蓋成的是**體驗模式自己的**設定（`demo_channel` ＋ `demo_models` 的第一個；白名單留空就取該渠道的第一個模型），**不是** `dumb_channel`/`dumb_model` — 因為體驗模式的 fail-closed 限流與 `demo_max_tokens` 全綁在 `demo_channel` 上，被 dumb 的渠道蓋掉等於那些燒錢上限一起失效。也就是說 dumb 對體驗模式只做「不讓訪客挑」，跑哪個仍由體驗模式的設定決定。

- `GET /api/playground/models` → `{ rows:[{ slug, name, models, vision }] }`（只列啟用中且有設模型的渠道；**不含 `kind`** — 那等於標示真實提供商）。`vision` 是該渠道裡**看得懂圖片**的模型子集（管理員在管道的 `vision_models` 標的，沒標＝空陣列）。dumb mode 下改回 `{ rows:[], dumb:true, vision:true|false }` — 模型名保密，但「能不能附圖」得讓前端知道，否則附件鈕只能一律關掉或一律開著。
- `GET /api/playground/conversations` → `{ rows:[{ id, title, channel, model, created_at, updated_at }] }`（自己的，新→舊，最多 100 筆）。**管理員要看全站所有人的對話**看 §5 的 `/api/admin/conversations`（或 /logs 的「總對話紀錄」分頁）。
- `GET /api/playground/conversations/{id}` → `{ conv, messages:[{ id, role, content, model, created_at }], files:[{ id, msg_id, mime, name, bytes, w, h, purged }] }`。`files` 是整串對話的附件中繼資料（前端按 `msg_id` 分回各則訊息）；**內容要另外打 `/api/playground/files/{id}`**。`purged:1`＝內容已被清除，中繼資料留著讓前端畫「檔案已刪除」。
- `PUT /api/playground/conversations/{id}` 本體 `{ "title":"新名字" }` 改名；`DELETE` 刪除（連同訊息**與附件**）。
- `POST /api/playground/chat` 本體：

```json
{ "conv_id": 12, "channel": "gemini", "model": "gemini-3.1-flash-lite",
  "messages": [ { "role":"user", "content":"你好" } ] }
```

  - `messages` 是完整上下文（最後一則要是 `user`；`role` 收 user/assistant/system）。
  - **不帶 `conv_id`＝自動開新對話**（標題取第一句 user 訊息），對話編號由 SSE 第一筆事件回傳。
  - `model` 一定要在該渠道的 `models` 清單裡，否則 400 `bad-model`。
  - 回應是 SSE（`text/event-stream`），每筆 `data:` 都是 JSON：`{conv,title?}` →（多筆）`{r:"思考增量"}`／`{d:"增量文字"}` → `{done:true}`；中途出錯是 `{error,hint}`（已生成的部分照存）。上游一開始就失敗則直接回 JSON 錯誤（會帶 `conv`）。
  - **`{r:…}` 是推理模型的思考過程**（2026-07-21）：GLM／DeepSeek 系的 `reasoning_content`、OpenRouter 的 `reasoning`、anthropic 的 `thinking_delta`、gemini 標了 `thought` 的 part，一律轉成 `r` 事件。思考內容**不寫進 `pg_messages`**（存的只有正式回覆），重新載入舊對話時不會再出現。非推理模型完全不會有 `r` 事件。
    > 這個欄位以前被丟掉，導致推理模型在思考期間瀏覽器收不到任何東西 — 畫面空白數十秒像當機，模型若把輸出預算全花在思考上更是「沒回覆、沒報錯」就結束。
  - **整趟沒有任何正式內容**（`d` 一次都沒來）→ 回 `{error:"empty-output", hint}`，不會靜默送 `done`。有收過思考的話 `hint` 會說明是「只輸出思考過程」。此錯誤不含上游身分，**會員看得到全文**。
  - 中斷連線（前端按「停止」）＝停止生成，已生成的內容照樣存進對話。
  - 伺服器依渠道 kind 自動轉換請求／串流格式：openai、custom → `/v1/chat/completions`；anthropic → `/v1/messages`；gemini → `/v1beta/models/{model}:streamGenerateContent?alt=sse`。
  - **錯誤訊息對會員做了消毒**（2026-07-14）：上游的原始錯誤內容（錯誤格式、文件連結、專案編號）會洩漏真實提供商身分，所以會員只看得到安全分類字（401/403→「渠道憑證可能失效」、429→「上游流量限制」、5xx→「上游暫時故障」…），`detail` 原文**只有管理員**（is_admin 或管理金鑰）看得到。

### 附件（2026-07-29 v2.3.0）

聊天可以附**圖片**（給看得懂圖的模型看）與**文件**（PDF/docx/xlsx/pptx/txt/csv/程式碼…）。兩者走完全不同的路：

| | 圖片 | 文件 |
|---|---|---|
| 怎麼送 | 先上傳成一筆檔案，訊息帶 `files:[編號]` | **在瀏覽器就抽成純文字**，直接併進 `content` |
| 需要模型支援 vision | 是 | **否**（純文字模型也能「讀」Word 檔） |
| 佔儲存空間 | 是 | 否 |

文件在瀏覽器端解析，伺服器完全不經手：
- **PDF** → `pdf.js`（vendored 在 `public/assets/pdf.js`＋worker，合計 1.8MB，**只有真的丟 PDF 進來才動態載入**）。一次最多讀 50 頁，超過的在結尾標明。**掃描件／整頁都是圖的 PDF 沒有文字層**，會明確告訴使用者「可以改用截圖當圖片附上」，而不是丟一句失敗。
- **docx/xlsx/pptx** → 三種都是 ZIP+XML，用瀏覽器原生的 `DecompressionStream('deflate-raw')`＋`DOMParser` 自己解，**沒有引任何相依套件**。代價是格式扁平化（表格變 Tab 分隔、標題層級消失）——對「餵給模型讀」這個用途，文字在就夠了。
- **純文字類** → 先照 UTF-8 解，出現替代字元就改用 Big5 再試（台灣的舊 .txt/.csv 很多是 Big5，直接當 UTF-8 讀會整篇亂碼）。

單一文件抽出來的文字上限 40,000 字，超過截斷並在結尾標明（悄悄砍掉會讓模型以為自己讀完了）。

- `POST /api/playground/files?mime=image/webp&name=a.webp&w=800&h=600` → `{ id, mime, name, bytes, w, h }`
  - **本體直接是 base64 字串**（`Content-Type: text/plain`），不是 JSON、也不是二進位。這是為了 CPU：三家上游都只吃 base64，收二進位的話每次對話都要 `btoa` 編一次（1MB 圖 8.11ms，而免費方案每請求只有 10ms），包成 JSON 則是 `JSON.parse` 要逐字元掃過整段 base64（比 raw 慢 4.7 倍）。收 base64 原字串等於「瀏覽器編好、伺服器原封轉手」，全程不編不解。
  - 只收 **jpeg / png / webp / gif**。**宣告的 `mime` 必須與實際檔頭相符**（只解前 24 個字元驗魔術位元組），不符回 415 `type-mismatch`。svg 永遠不收（可執行的 XML）。
  - 三層容量限制：單檔 `pgfile_max_kb`（預設 1400KB — D1 單值 2,000,000 bytes 反推 base64 膨脹後的天花板）、每人 `pgfile_user_mb`（預設 30MB）、全站 `pgfile_total_mb`（預設 300MB，超過由每日 cron 從**最舊**的開始清內容）。前兩層超過回 413。
  - 剛上傳的檔案是**孤兒**（還沒綁對話），要等 `chat` 帶著它的編號送出才綁定；一直沒送出的**24 小時後由 cron 清掉**。
  - 體驗模式（未登入）也能上傳，吃同一套 demo 限流；全體匿名訪客共用 `demo:public` 這一個帳號的容量配額。
- `GET /api/playground/files/{id}` → 圖片二進位（翻歷史對話時用）。只能讀自己的；**體驗模式上傳的只有管理員讀得到**（那些檔案全掛在 `demo:public` 名下，開放匿名讀取的話訪客只要把編號加一就能翻別人的）。內容已被清除回 **410 `purged`**（附 `name`/`bytes` 讓前端畫佔位）。
- `POST /api/playground/chat` 的訊息可帶 `files`：

```json
{ "channel":"x", "model":"gpt-4o",
  "messages":[ { "role":"user", "content":"這張圖是什麼？", "files":[12,13] } ] }
```

  - 模型必須被管理員標進該管道的 `vision_models`，否則回 400 `no-vision`（**檢查在建立對話之前** — 不留下「訊息存了但圖沒送到」的半吊子狀態）。
  - 單則最多 4 張；**單次請求所有圖片的原始大小合計上限 1.5MB**。這個數字是量出來的：組上游 body 的成本 933KB→1.62ms、1.8MB→3.31ms、2.8MB→6.00ms，而這筆花費發生在**串流開始之前**，花掉的每一毫秒都是從串流迴圈的預算裡扣的。
  - 超出預算、或模型看不了圖（歷史訊息）、或內容已被清除 → 那幾張**降級成文字佔位**「[已省略的圖片：檔名]」而不是報錯。原則是**不要因為附件的問題讓人連話都說不出來**：從最舊的開始降級，最新那張（通常就是他正在問的）保到最後。
  - 別人的檔案編號塞進來一律查不到（`WHERE user_id=自己`），靜默降級成佔位，不會洩漏任何內容。

## 6. 常用流程速查

| 想做的事 | 步驟 |
|---|---|
| 發文 | （可選）POST media 拿 `/img/{id}` → POST /api/admin/articles（status:published） |
| 改文 | GET /api/admin/articles/{id} → 改欄位 → **整包** PUT 回去 |
| 換圖 | POST media 拿**新**編號 → PUT 文章把 cover / 內文網址換成新的（舊編號作廢） |
| 開新頁面 | POST /api/admin/pages（status:published）→ 上線在 `/p/{slug}` |
| 頁面掛進選單 | GET /api/menu → items 加 `{ kind:"link", label, url:"/p/{slug}" }` → PUT /api/admin/menu |
| 改站名 | PUT /api/admin/settings `{ "brand":"…" }` |
| 看流量 | GET /api/logs?limit=50&since=今天零點的UTC時間 |
| 看全站對話紀錄 | GET /api/admin/conversations（找某人加 `?q=信箱`）→ GET /api/admin/conversations/{id} 讀內容 |
| 加中轉管道 | POST /api/admin/relay/channels `{ name, kind, base_url, api_key, models:["gpt-4o-mini"] }`（slug 自動產生） |
| 批准會員（全部服務） | GET /api/admin/users 找 id → PUT /api/admin/users/{id} `{ "action":"approve" }` |
| 批准／收回單一服務 | PUT /api/admin/users/{id} `{ "action":"set_services", "services":["relay","playground"] }`（整包覆蓋） |
| Playground 開放給所有會員 | PUT /api/admin/settings `{ "pg_open": true }`（false＝關閉，回到逐人批准） |
| 加 VPN 渠道 | POST /api/admin/vpn/channels `{ "name":"某機場", "kind":"sub", "url":"https://…" }` |
| 暫停某渠道 | GET /api/admin/vpn/channels 找 id → PUT `{ name, kind, enabled:false }`（會員訂閱立刻少掉那些節點） |

轉貼別站新聞的原則：**用自己的話改寫＋文末附資料來源連結**，不要整篇照抄。
這些操作在網頁上也都能做：**管理員設定 /settings**（站名、聯絡連結、Playground 與體驗模式、配額、計量開關、模型定價、自訂頁面）、文章後台 /admin、☰ 側邊欄（選單編輯 — 打開選單按「選單」旁的 ✎）、成員管理 /members、訪客紀錄 /logs、中轉站 /relay、VPN /vpn。

## 7. 錯誤回應

出錯時回 `{ "error": "代碼", "hint": "中文提示（可能沒有）", "detail": "技術細節（可能沒有）" }`：

| HTTP 狀態 | 常見 error | 說明 |
|---|---|---|
| 400 | bad-input / bad-id / bad-slug / bad-url / too-many / empty / bad-action / self / bad-model | 參數或本體不合規則（看 hint）；bad-model＝模型不在渠道清單裡 |
| 401 | unauthorized / no-key / bad-key / no-admin-user | 金鑰沒帶或不對（中轉：會員金鑰無效） |
| 403 | bad-origin / not-approved / blocked / protected | 跨站被擋／該服務未被批准或帳號被封鎖／受保護的管理員帳號 |
| 404 | not-found / unknown-channel | 內容不存在（或公開 API 查到的是草稿）／中轉管道不存在 |
| 409 | slug-taken | 自訂頁面或管道的 slug 已被使用 |
| 429 | quota-exceeded / rate-limited | 超過每日額度／請求太快（中轉與 Playground；帶 `Retry-After` 標頭與 `used`/`limit`/`reset` 欄位；日額度另附 `contact_url`；管理員豁免） |
| 502 | upstream-unreachable / upstream-error / no-upstream-key | 中轉／VPN／Playground 上游連不上或回錯；渠道沒設上游金鑰 |
| 413 | too-large | 圖片超過 1.8MB |
| 415 | bad-type | 圖片格式不是 webp / jpeg / png / gif |
| 500 | no-db / query-failed / insert-failed / update-failed / delete-failed / save-failed | 伺服器或資料庫問題（看 detail） |
