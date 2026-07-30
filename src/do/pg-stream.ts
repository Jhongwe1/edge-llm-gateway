// src/do/pg-stream.ts — Playground 串流 Durable Object（v2.5_DO，ADR-0015）。
//
// 為什麼是 DO：免費方案的 Worker 每次呼叫只有 **10ms CPU**，而把上游 SSE 讀進 JS
// 解析、合併、再寫出統一格式，實測一趟 20 秒的回覆要花 **626ms CPU** —— 超標 62 倍。
// isolate 被殺時是「拔電源」式的死法：瀏覽器看到串流無聲斷掉、沒有錯誤，D1 連
// req_log 都來不及寫。
//
// Durable Object 的 CPU 上限是 **30 秒，免費方案也一樣**（官方 limits 文件；10ms 那條
// 只綁 Worker）。同一份轉譯程式搬進來，等於從「預算的 6260%」變成「預算的 2%」。
//
// ⚠️ 30 秒是 **CPU 時間，不是牆鐘時間**。官方定義：
//   "CPU time is active processing time: not time spent waiting on network requests,
//    storage calls, or other general I/O"
//   "No hard limit while the caller stays connected to the Durable Object."
// 所以「模型思考了 90 秒才吐第一個字」完全不吃預算 —— 那是等 I/O。真正花 CPU 的只有
// 「吐出來的字數」：實測每個 chunk 約 0.2ms，要燒滿 30 秒得有約 15 萬個 chunk，
// 沒有模型單次會吐這麼多。餘裕是 50～1000 倍。
//
// 為什麼不是 v2.5 的原生直通：直通把上游位元組原樣交給瀏覽器，每筆 chunk 都帶著
// "model":"<真名>"（OpenRouter 另帶 provider、Groq 帶 x_groq），繞過 safeHint() 的淨化，
// 也讓伺服器看不見回覆（落地與 token 用量得改由前端回報、關掉網頁就不再續跑）。
// DO 版沒有這些代價：轉譯與淨化原封不動，只是換一個 CPU 預算 3000 倍大的地方跑。
//
// 分片：每個會員一顆實例（idFromName "pg:u:<id>"，與 lib/quota.ts 的 "u:<id>" 同調）。
//   * 同一個會員連續發問會打到**同一顆、已經熱的**實例 —— 第二則之後省掉冷啟動。
//   * 實例位置在第一次使用時定於呼叫端附近，之後固定；一個會員的位置就是他自己的位置。
//   * 同一顆實例同時跑多條串流不會互相阻塞（都在等 I/O，await 點自然交錯），
//     CPU 預算也是**每個進來的請求各自 30 秒**，不是整顆共用。
//   * 唯一的取捨：demo（匿名）全部掛在 demo:public 這一列名下，會共用一顆實例。
//     個人站的體驗模式流量極低，先接受；真的變瓶頸再改成隨機分片。
//
// 這裡刻意**不存任何狀態**（沒有 storage 讀寫）：DO 在這一版只當「有 CPU 預算的執行場所」。
// 但類別仍必須宣告成 SQLite-backed —— 免費方案只支援這種（見 wrangler.toml migrations）。
import { DurableObject } from "cloudflare:workers";
import { cleanChat } from "../lib/playground.js";
import { runChat } from "../lib/pgchat.js";
import { json } from "../lib/site.js";
import type { ChatJob } from "../lib/pgchat.js";
import type { Env } from "../types.js";

export class PgStream extends DurableObject<Env> {
  /**
   * 收 routes/api/playground/chat.ts 交棒過來的一趟聊天。
   *
   * ── 信封格式：`<job JSON 一行>\n<原始請求本體，原樣>` ──
   * 看起來很土，但這是為了一個具體的目的：**讓 Worker 那一側的 CPU 與訊息長度脫鉤**。
   * 若改成 JSON.stringify({ job, messages })，Worker 就得把整包對話（上限 30 萬字）
   * 重新序列化一次，最壞情況多花好幾毫秒 —— 而它總共只有 10ms。
   * 現在 Worker 只做「一次無法避免的 JSON.parse（驗輸入用）」＋「字串接起來」，
   * 後者在 V8 是 O(1) 的 cons-string，不複製內容。
   *
   * 第一行保證不含換行（JSON.stringify 不會產生裸的 \n），所以用第一個 \n 切安全。
   * 訊息從原始本體重新 cleanChat 一次：DO 這邊有 30 秒 CPU，多解析一次無所謂，
   * 換到的是 Worker 側完全不必碰 messages。渠道與模型**一律以 job 為準**
   *（dumb 模式會覆寫它們，原始本體裡的是使用者自己填的、不可信）。
   */
  async fetch(request: Request): Promise<Response> {
    let job: ChatJob;
    let body: unknown;
    try {
      const text = await request.text();
      const nl = text.indexOf("\n");
      if (nl < 0) throw new Error("bad envelope");
      job = JSON.parse(text.slice(0, nl)) as ChatJob;
      body = JSON.parse(text.slice(nl + 1));
    } catch (e) {
      return json({ error: "bad-job" }, 500);
    }
    // 這一步在 Worker 已經驗過並且過了，所以只可能拿到同樣的結果；
    // 真的失敗就代表信封壞掉，回 500（不是使用者的錯，不要回 400 誤導前端）。
    const v = cleanChat(body);
    if (v.err !== undefined) return json({ error: "bad-job", hint: v.err, conv: job.convId }, 500);

    // ── 背景工作在 DO 裡怎麼活著 ──
    // waitUntil **沒有作用**（官方文件：「Unlike in Workers, waitUntil has no effect in
    // Durable Objects」）。DO 的規則是「只要還有 pending I/O 就自動留在記憶體裡」，
    // 但那句話有前提：**得真的還有 I/O 在飛**。兩種情況要分開處理：
    //
    //   ① 串流路徑 —— pump 手上握著上游的 reader 與這條回應串流，兩個都是 in-flight I/O，
    //      所以絕對不能 await 它（要先把 Response 回出去），也不需要。
    //      「關掉網頁後背景把話講完」就是靠這個性質，而且不再有 Worker waitUntil
    //      那個「invocation 結束 30 秒就砍」的天花板。
    //   ② 錯誤路徑 —— 上游打不通／回 4xx 5xx 時，runChat 立刻回一包 JSON 就結束了，
    //      **沒有任何 I/O 撐著這顆 DO**。此時 errlog 與 learnImgLimit 那些寫入是「浮著的
    //      promise」，會被 runtime 當成閒置回收掉（實測訊息：
    //      "IoContext timed out due to inactivity, waitUntil tasks were cancelled"）——
    //      結果就是上游錯誤沒有留下任何痕跡，而那正是最需要痕跡的時候。
    //      所以這一類一定要在回傳前 await 掉；它們都是單筆 D1 寫入，不會拖慢多少。
    const pending: Promise<unknown>[] = [];
    function bg(p: Promise<unknown>) {
      pending.push(Promise.resolve(p).catch(function () {}));
    }
    const resp = await runChat(this.env, job, v.messages, bg, request.signal);
    if (String(resp.headers.get("content-type") || "").indexOf("event-stream") < 0) {
      await Promise.all(pending); // ② 沒有串流撐著 → 自己等背景寫完再收工
    }
    return resp;
  }
}
