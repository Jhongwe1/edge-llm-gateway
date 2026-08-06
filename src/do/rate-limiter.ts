// src/do/rate-limiter.ts — 限流器 Durable Object（v2.0.0 Phase H，ADR-0007）。
//
// 為什麼是 DO：v1 的配額檢查是「D1 COUNT req_log → 沒超標就放行」，兩個並發請求會
// 讀到同一個計數、雙雙放行（COUNT-then-insert 競態，ADR-0002 有記）。DO 同一個 id
// 全球單實例＋單執行緒，「檢查＋計數」在同一次同步執行內完成 → 原子，永不超賣。
//
// 分片：每個會員一顆實例 — 呼叫端用 idFromName("u:"+user.id)（見 lib/quota.ts）。
// 職責邊界：limit 由呼叫端算好傳進來（個人覆寫／全域設定／內建預設的三層優先序
// 留在 lib/quota.ts），DO 只管原子計數與比較 — 這裡永遠不碰 D1。
//
// 資料結構（SQLite-backed storage，一張 counters 表、每顆 DO 只有 3～4 列）：
//   * 分鐘限流＝兩桶加權滑動窗：只記「上一分鐘」「這一分鐘」兩個計數（鍵 m:<epoch分>，
//     跨服務共用 — 對齊 v1 的 60 秒窗不分 svc），估計值 = 上一桶 × 窗內剩餘重疊比例 + 這一桶。
//     不存個別時間戳，記憶體與儲存皆 O(1)。
//   * 日配額＝日期入鍵懶重置：鍵 d:<UTC日>:<svc>，隔天鍵名不同、舊鍵自然作廢（順手清掉），
//     不需要 alarm。
//
// check() 全程同步（storage.sql.exec 是同步 API、中途沒有 await）→ 併發 RPC 逐一排隊，
// 恰好 limit 個過、第 limit+1 個起被擋（有 Promise.all 併發測試釘住這個性質）。
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types.js";

export interface RateCheckArg {
  // svc 只影響「日配額」的鍵名（分鐘窗刻意跨服務共用，對齊 v1 的 60 秒窗）。
  // csp＝/api/csp-report 的匿名回報限流（2026-07-22）：獨立命名空間，不與會員額度互吃。
  // visit＝訪客紀錄的每日寫入上限（2026-08，DEBT #35）：全站一顆實例（visit:global），
  //   呼叫端做 1/N 抽樣後才問，所以這裡的 perDay 是「抽樣次數」不是「瀏覽次數」——
  //   換算在 routes/_middleware.ts 的 VISIT_GUARD，別在這裡找。
  svc: "relay" | "pg" | "csp" | "visit";
  perMin: number; // 每分鐘上限（呼叫端已套個人覆寫；0＝直接擋）
  perDay: number; // 當日上限（同上）
  now?: number; // 測試注入用的時鐘（epoch ms）；正式呼叫不帶＝Date.now()
}

// deny 只回 kind/used/limit — 429 回應（含 reset 與 Retry-After）由呼叫端統一組裝，
// 跟 D1 降級路徑共用同一套文案與形狀。
export type RateCheckResult = { ok: true } | { ok: false; kind: "day" | "min"; used: number; limit: number };

export class RateLimiter extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // 每次喚醒都跑一次（IF NOT EXISTS 冪等）；表極小，無 migration 需求
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS counters (k TEXT PRIMARY KEY, n INTEGER NOT NULL)");
  }

  /** 原子的「檢查並計數」：放行才 +1（被擋的請求不吃額度）。 */
  check(arg: RateCheckArg): RateCheckResult {
    const now = typeof arg.now === "number" ? arg.now : Date.now();
    const perMin = Math.max(0, Math.floor(arg.perMin));
    const perDay = Math.max(0, Math.floor(arg.perDay));
    const minute = Math.floor(now / 60e3);
    const day = new Date(now).toISOString().slice(0, 10);
    const curKey = "m:" + minute;
    const prevKey = "m:" + (minute - 1);
    const dayKey = "d:" + day + ":" + arg.svc;

    const rows = this.ctx.storage.sql
      .exec<{ k: string; n: number }>(
        "SELECT k,n FROM counters WHERE k IN (?1,?2,?3)",
        curKey,
        prevKey,
        dayKey
      )
      .toArray();
    const cnt: Record<string, number> = {};
    for (const r of rows) cnt[r.k] = Number(r.n) || 0;

    const usedDay = cnt[dayKey] || 0;
    if (usedDay >= perDay) return { ok: false, kind: "day", used: usedDay, limit: perDay };

    // 滑動窗：上一分鐘還有 weight 比例落在「過去 60 秒」窗內
    const weight = 1 - (now % 60e3) / 60e3;
    const est = (cnt[prevKey] || 0) * weight + (cnt[curKey] || 0);
    if (est >= perMin) return { ok: false, kind: "min", used: Math.round(est), limit: perMin };

    // 放行：這一分鐘桶與當日鍵各 +1；順手清掉已滑出窗外的分鐘桶與昨天以前的日鍵
    this.ctx.storage.sql.exec(
      "INSERT INTO counters (k,n) VALUES (?1,1),(?2,1) ON CONFLICT(k) DO UPDATE SET n=n+1",
      curKey,
      dayKey
    );
    this.ctx.storage.sql.exec(
      "DELETE FROM counters WHERE (k LIKE 'm:%' AND k NOT IN (?1,?2)) OR (k LIKE 'd:%' AND k NOT LIKE ?3)",
      curKey,
      prevKey,
      "d:" + day + ":%"
    );
    return { ok: true };
  }
}
