-- Migration 0008 — v2.3.0：管道排序（決定 Playground 模型選單的先後）。
--
-- 選單的順序是兩層：**管道之間**照這個欄位（小的在前），**管道之內**照 models 欄位的行序
-- （那一層本來就可以編輯，把想放前面的模型移到第一行即可）。
-- 以前管道之間只能照 id，也就是「先建的永遠在前」，沒有任何方式調整。
--
-- 預設 0：全部同分時退回 id 排序（ORDER BY sort_order, id），所以舊資料的順序完全不變 ——
-- 管理員按過上移／下移之後才會有非零值。
ALTER TABLE relay_channels ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
