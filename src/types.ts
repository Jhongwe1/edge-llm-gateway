// src/types.ts — v2.0.0 Phase F 的共用型別。
// 定位：把「到處在用」的形狀集中定義（Env 綁定、D1 資料列、Pages 形 context）。
// 過渡期哲學：handler 由 .js 轉來、邏輯不動，型別以「夠用、不擋路」為準 —— 資料列多半
// 直接取自 D1（欄位型別鬆），所以 Row 型別是描述性的、允許 index 存取。

import type { RateLimiter } from "./do/rate-limiter.js";
import type { PgStream } from "./do/pg-stream.js";

// wrangler.toml 綁定 + secrets。functions/handler 只碰得到這些。
export interface Env {
  DB: D1Database;
  ASSETS: { fetch: (req: Request) => Promise<Response> };
  RATE_LIMITER?: DurableObjectNamespace<RateLimiter>; // Phase H 限流器 DO（可選：沒綁定就走 D1 降級路徑）
  // v2.5_DO Playground 串流 DO（ADR-0015）。**可選**：沒綁定就退回「在 Worker 裡串流」＝v2.4 行為
  // （長回覆會再撞免費方案 10ms CPU 上限，但站台照跑）。settings.pg_do='0' 也是同一條退路。
  PG_STREAM?: DurableObjectNamespace<PgStream>;
  BACKUPS?: R2Bucket; // Phase I 備份桶（可選：沒綁定＝備份 job 跳過）
  // v2.3 Playground 附件桶（可選）。**綁定在＝新附件寫 R2，沒綁定＝寫 D1 的 b64 欄位**，
  // 判斷寫在 lib/filestore.ts activeStore()。每一列各自記自己存在哪（pg_files.storage），
  // 所以之後開通 R2 不必搬資料、舊檔照樣讀得到。
  FILES?: R2Bucket;
  SITE_ORIGIN?: string;
  ADMIN_EMAILS?: string;
  LOGS_TOKEN?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  TG_BOT_TOKEN?: string; // Phase I Telegram 告警（未設＝告警 no-op）
  TG_CHAT_ID?: string;
  // 開發模式後門旗標（2026-07-22，見 lib/auth.ts isDevEnv）。"1"＝允許「沒有 LOGS_TOKEN 也放行管理端點」
  // 與 /auth/login 的本機測試登入表單。**只放 .dev.vars**（wrangler dev 才讀、deploy 永不上傳），
  // wrangler.toml 刻意不宣告它 —— 正式環境讀到 undefined 就是關閉。
  DEV_UNSAFE_ADMIN?: string;
  [key: string]: unknown;
}

// Pages 形 EventContext（router 建、handler 收）。params 是路由參數（:id→string、*path→string[]）。
export interface RouteCtx<P = Record<string, string | string[]>> {
  request: Request;
  env: Env;
  params: P;
  data: Record<string, unknown>;
  waitUntil: (p: Promise<unknown>) => void;
  passThroughOnException: () => void;
  next: () => Promise<Response>;
}

// D1 資料列（migrations/0001_baseline.sql）。欄位鬆綁：D1 回來的值型別不保證，允許 index 存取。
export interface UserRow {
  id: number;
  google_sub: string;
  email: string;
  name: string;
  picture: string;
  status: string; // pending | approved | blocked
  services: string; // 逗號分隔：relay,vpn,playground
  is_admin: number;
  api_key_hash: string;
  api_key_hint: string;
  api_key_at: string | null;
  vpn_token: string;
  relay_calls: number;
  vpn_pulls: number;
  created_at: string;
  last_login: string | null;
  [key: string]: unknown;
}

export interface ChannelRow {
  id: number;
  slug: string;
  name: string;
  kind: string; // openai | anthropic | gemini | custom
  base_url: string;
  api_key: string;
  models: string;
  system_prompt: string; // 只給 Playground 注入的系統提示詞；/relay 中轉不讀這欄（migration 0005）
  extra_body: string; // 合併進 playground 上游請求本體的額外參數（JSON 物件字串）；/relay 不讀（migration 0006）
  vision_models: string; // 這個管道裡「吃得下圖片」的模型（逗號分隔）；空＝都不支援（migration 0007）
  sort_order: number; // Playground 模型選單裡的管道先後（小的在前；同分退回 id，migration 0008）
  model_caps: string; // 上游回報的模型能力快取，JSON「模型名→單次最多幾張圖」；空＝沒問到，套預設（migration 0009）
  enabled: number;
  created_at: string;
  [key: string]: unknown;
}

export interface ArticleRow {
  id: number;
  category: string;
  title: string;
  summary: string;
  cover: string;
  body_md: string;
  status: string;
  views: number;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  [key: string]: unknown;
}

// 未知形狀的 D1 資料列泛稱（handler 內大量 .map/.first 的對象）。
export type Row = Record<string, unknown>;
