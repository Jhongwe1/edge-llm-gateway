-- Migration 0007 — v2.3.0：Playground 附件（圖片走 vision、文件走文字）。
--
-- ## 為什麼內容存 base64 字串而不是 BLOB
--
-- 直覺做法是照 media 表那樣存二進位（省 33% 空間）。實測後推翻（2026-07-29，V8 基準）：
-- 送給上游時三家都只吃 base64（OpenAI 的 data URL、Anthropic 的 source.data、
-- Gemini 的 inline_data.data），所以 BLOB 路徑每次對話都要 btoa 編一次 ——
--   1MB 圖 → 8.11ms、2MB 圖 → 14.46ms，而免費方案每次請求只有 10ms CPU。
-- 也就是說「存 BLOB」＝每聊一輪就把 CPU 預算燒光一次，而且是在 SSE 開始之前燒，
-- 死法跟 ADR-0011 一模一樣（isolate 被殺、串流無聲中斷、D1 連 req_log 都來不及寫）。
--
-- 改成存 base64 原字串後，整條路徑「零編解碼」：
--   瀏覽器編好 → raw body 上傳（request.text() 0.27ms）→ 原封進 TEXT
--   → 送上游時純字串串接進 body（0.59ms，成本只剩 fetch 必經的 TextEncoder）
-- 空間是一次性成本，CPU 是每輪都要付的成本 —— 拿 33% 空間換掉一整類當機，划算。
--
-- ## 單檔上限怎麼來的
-- D1 單一值上限 2,000,000 bytes；base64 會膨脹成 ceil(n/3)*4，所以原始檔的天花板是
-- 2,000,000 × 3/4 ≈ 1,464KB，預設取 1400KB 留餘裕（lib/filestore.ts FILE_DEFAULTS）。
-- 前端一律先壓到長邊 1568px（各家 vision 的 tile 甜蜜點），一般照片壓完 200–400KB。
-- 存 R2 時不受這條限制（見 storage 欄位）：2026-07-30 v2.4.0 開通 R2 後，R2 模式的單檔
-- 上限是 5MB（來源改成 Anthropic vision 每張圖的硬上限，不再是 D1 的 2MB 單值限制）。
-- 兩種模式怎麼切、免費額度怎麼守，見 docs/adr/0013-r2-optional-attachments.md。
CREATE TABLE IF NOT EXISTS pg_files (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,           -- 上傳者＝配額歸屬（demo 訪客全掛 demo:public 那一列）
  conv_id    INTEGER,                    -- 所屬對話；NULL＝剛上傳、還沒隨訊息送出（孤兒，24h 後清）
  msg_id     INTEGER,                    -- 所屬訊息（pg_messages.id）；送出時回填
  kind       TEXT NOT NULL DEFAULT 'image', -- 目前只有 image（文件類在前端就轉成文字，不進這張表）
  mime       TEXT NOT NULL,              -- image/webp、image/jpeg、image/png、image/gif
  name       TEXT NOT NULL DEFAULT '',   -- 原始檔名（顯示用；「檔案已刪除」佔位也靠它）
  bytes      INTEGER NOT NULL,           -- 原始檔大小（解碼後的真實 bytes，非 base64 長度）
  w          INTEGER, h INTEGER,         -- 像素尺寸（前端排版用，避免圖載入時跳版）
  storage    TEXT NOT NULL DEFAULT 'd1', -- 'd1'＝內容在 b64 欄位；'r2'＝在 R2，鍵見 r2_key
  b64        TEXT,                       -- storage='d1' 的內容（base64 原字串，不含 data: 前綴）
  r2_key     TEXT,                       -- storage='r2' 的物件鍵
  purged     INTEGER NOT NULL DEFAULT 0, -- 1＝內容已被淘汰／過期清除，中繼資料留著顯示「檔案已刪除」
  created_at TEXT NOT NULL
);
-- 每人配額 SUM(bytes)（走 user_id）；全站 FIFO 淘汰掃最舊（走 created_at）
CREATE INDEX IF NOT EXISTS idx_pg_files_user ON pg_files (user_id, created_at);
-- 讀對話時一次撈完該對話的檔案（前端按 msg_id 分組）；刪對話時的連帶刪除也走這條
CREATE INDEX IF NOT EXISTS idx_pg_files_conv ON pg_files (conv_id);
-- 淘汰與孤兒清理：只掃還有內容的（purged=0），已清過的不必重複掃
CREATE INDEX IF NOT EXISTS idx_pg_files_purge ON pg_files (purged, created_at);

-- 哪些模型吃得下圖片。空字串＝這個管道沒有任何 vision 模型（預設，維持現狀）。
-- 逗號分隔，值必須也出現在 models 欄位裡（cleanChannel 驗）。
--
-- 為什麼要管理員自己填、不自動偵測：模型會不會讀圖沒有任何標準查詢方式 —— 各家沒有
-- capability 端點，名字也看不出來（gemma-4-uncensored 可能有 vision 版也可能沒有）。
-- 猜錯的代價不對稱：以為能送圖但其實不能 → 上游回 400，會員看到的是一句無法理解的
-- 錯誤；以為不能送但其實可以 → 只是附件鈕灰著，會員頂多覺得少個功能。
-- 所以一律預設「不支援」，管理員在 /relay 管道視窗明確填了才開放。
ALTER TABLE relay_channels ADD COLUMN vision_models TEXT NOT NULL DEFAULT '';
