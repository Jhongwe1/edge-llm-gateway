// POST /api/playground/files — Playground 附件上傳（v2.3.0）。
//
// ## 為什麼本體是 raw base64 而不是 JSON、也不是二進位
//
// 三種收法實測過（V8 基準，1MB 圖；免費方案每請求上限 10ms CPU）：
//   包成 JSON  → request.json() 1.27ms（JSON.parse 得逐字元掃跳脫序列）
//   raw base64 → request.text() 0.27ms  ← 用這個
//   二進位     → arrayBuffer() 0.25ms，但之後要 btoa 才能送上游：**8.11ms**，直接爆
// 收 raw base64 等於「瀏覽器編好、我們原封轉手」，Worker 從頭到尾不碰內容 —— 中繼資料
// （mime、檔名、尺寸）走 query string，本體就是純粹的 base64，沒有任何包裝要拆。
//
// 檔案先以「孤兒」狀態存下（conv_id／msg_id 都是 NULL），等使用者真的按送出，
// chat.ts 才把它綁到那則訊息上。上傳了卻沒送出的（改變主意、關掉分頁）由 cron 24 小時後清掉。
import { json } from "../../../../lib/site.js";
import { getSessionUser, goodOrigin, isAdminUser } from "../../../../lib/auth.js";
import { pgUser } from "../../../../lib/playground.js";
import { demoCfg, demoUser, demoCheck } from "../../../../lib/demo.js";
import {
  fileLimits,
  uploadPlan,
  putFile,
  sniffMime,
  isB64,
  b64Bytes,
  mbText,
  OK_IMAGE_MIME
} from "../../../../lib/filestore.js";
import type { RouteCtx, UserRow } from "../../../../types.js";

export async function onRequestPost(context: RouteCtx): Promise<Response> {
  const { request, env } = context;
  const url = new URL(request.url);
  if (!env.DB) return json({ error: "no-db" }, 500);

  // 身分：會員（登入 cookie／管理金鑰）或 demo 匿名訪客。
  // 這段刻意跟 chat.ts 平行而不抽共用函式 —— demo 的成本控管整套綁在「聊天」那條路上
  // （demoCheck 會扣 DO 計數），上傳要不要一起扣是**獨立的政策決定**，不是可以順手共用的邏輯。
  // 這裡的決定是「要扣」：匿名者每日 10 次的額度由上傳與聊天共享，所以一個訪客最多
  // 傳 10 張圖，而且全站匿名流量共用同一個 demo:public 帳號的容量配額 —— 上限鎖死。
  const who = await pgUser(request, env, url);
  let user: UserRow;
  let isDemo = false;
  if (who.err) {
    if (request.headers.get("authorization") || (await getSessionUser(request, env))) return who.err;
    const cfg = await demoCfg(env);
    if (!cfg.on) return who.err;
    if (!goodOrigin(request, url, env)) return json({ error: "bad-origin" }, 403);
    const gate = await demoCheck(env, cfg, request); // fail-closed，在任何 D1 寫入之前
    if (!gate.ok) return gate.resp;
    user = await demoUser(env);
    isDemo = true;
  } else {
    user = who.user;
  }

  const mime = String(url.searchParams.get("mime") || "")
    .trim()
    .toLowerCase();
  if (!OK_IMAGE_MIME[mime]) {
    return json({ error: "bad-type", hint: "只收 jpeg / png / webp / gif 圖片" }, 415);
  }

  let b64 = "";
  try {
    b64 = (await request.text()).trim();
  } catch (e) {}
  if (!b64) return json({ error: "empty", hint: "沒有收到內容" }, 400);
  // 字元集驗證。這不只是格式檢查 —— 送上游時我們用「純字串串接」把它塞進 JSON body
  // （省掉 stringify 的 CPU，見 playground.ts imagePart），驗過字元集才保證串進去不會
  // 壞掉 JSON 結構。不合法一律拒收，不做任何清洗。
  if (!isB64(b64)) return json({ error: "bad-encoding", hint: "內容不是合法的 base64" }, 400);

  const bytes = b64Bytes(b64);
  const lim = await fileLimits(env);
  // 單檔上限看的是「這次要寫去哪」而不是站台模式：R2 模式下若本月寫入預算用完，
  // 這次會退回 D1，上限也跟著縮回 D1 的那條線（degraded=true）。先擋大小再寫，
  // 使用者收到的才是「圖太大」，而不是寫到一半的「存檔失敗」。
  const plan = await uploadPlan(env);
  const maxBytes = plan.maxKb * 1024;
  if (bytes > maxBytes) {
    return json(
      {
        error: "too-large",
        hint:
          "壓縮後仍超過 " +
          mbText(plan.maxKb) +
          "，請換小一點的圖" +
          (plan.degraded ? "（本月 R2 寫入額度已用完，暫時只能存進資料庫）" : ""),
        bytes: bytes,
        limit: maxBytes
      },
      413
    );
  }

  // 宣告的格式必須跟真實檔頭相符（只解前 24 個字元，實測 0.00ms）。
  // 光信 query 的 mime 等於讓人把任意內容標成 image/png 存進來。
  const real = sniffMime(b64);
  if (!real || real !== mime) {
    return json({ error: "type-mismatch", hint: "檔案內容與宣告的格式不符", detected: real || null }, 415);
  }

  // L2 每人總量（管理員豁免，跟聊天配額同一套原則 —— 站長不該被自己的規則卡住）。
  // demo 的「每人」＝全體匿名訪客合計，因為他們共用 demo:public 這一列。
  if (!isAdminUser(user, env)) {
    const cur = await env.DB.prepare(
      "SELECT COALESCE(SUM(bytes),0) AS s FROM pg_files WHERE user_id=?1 AND purged=0"
    )
      .bind(user.id)
      .first<{ s: number }>();
    const used = Number(cur && cur.s) || 0;
    const cap = lim.userMb * 1024 * 1024;
    if (used + bytes > cap) {
      return json(
        {
          error: "quota-exceeded",
          hint: isDemo
            ? "體驗模式的圖片空間已滿，請登入使用完整功能"
            : "你的附件空間已滿（" +
              Math.round(used / 1048576) +
              "/" +
              lim.userMb +
              "MB）— 刪掉一些舊對話就會釋出空間",
          used: used,
          limit: cap
        },
        413
      );
    }
  }

  const name = String(url.searchParams.get("name") || "")
    .replace(/[\r\n\t]/g, " ")
    .trim()
    .slice(0, 120);
  const w = parseInt(url.searchParams.get("w") || "", 10) || null;
  const h = parseInt(url.searchParams.get("h") || "", 10) || null;

  try {
    const id = await putFile(
      env,
      { user_id: user.id, kind: "image", mime: mime, name: name, bytes: bytes, w: w, h: h },
      b64,
      plan.store
    );
    return json({ id: id, mime: mime, name: name, bytes: bytes, w: w, h: h, store: plan.store });
  } catch (e: any) {
    return json({ error: "save-failed", detail: String((e && e.message) || e) }, 500);
  }
}
