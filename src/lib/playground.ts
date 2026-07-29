// src/lib/playground.ts — Playground（/playground）的伺服器共用邏輯。
// 頁面本體在 src/lib/playgroundpage.ts；API 端點在 src/routes/api/playground/*。
//
// 設計重點：
//   1. 瀏覽器端不經手任何金鑰 — 聊天請求帶登入 cookie 打 /api/playground/chat，
//      伺服器查渠道（relay_channels）、帶上游金鑰去打，會員永遠看不到上游。
//   2. 三種上游（openai 相容／anthropic／gemini 原生）各自轉換請求與串流格式，
//      對瀏覽器統一輸出一種極簡 SSE：{conv}→{d:"文字"}…→{done}（出錯：{error,hint}）。
//   3. 管理員／agent 可用 Authorization: Bearer <LOGS_TOKEN> 直接測（身分算管理員帳號）。
import { json } from "./site.js";
import { getSessionUser, goodOrigin, canUsePlayground, adminEmails, isDevEnv, tokenEqual } from "./auth.js";
import { getB64, countR2Reads } from "./filestore.js";
import type { FileRow } from "./filestore.js";
import type { ChannelRow, Env, UserRow } from "../types.js";

export const PG_LIMITS = {
  maxMsgs: 80, // 一次請求最多帶的訊息數（前端會自己修剪，這是硬上限）
  maxChars: 100000, // 單則訊息字數上限
  maxTotal: 300000, // 整包訊息字數上限
  maxTokens: 4096, // anthropic 必填 max_tokens；取各型號都安全的值
  // ── 附件（v2.3）──
  maxImgPerMsg: 4, // 單則訊息最多幾張圖
  // 單次請求「所有圖片」的原始 bytes 總和上限。這個數字是量出來的，不是拍的：
  // 組上游 body 的成本（含 fetch 必付的 bytes 轉換，實測 2026-07-29）
  //   933KB base64 → 1.62ms ｜ 1.8MB → 3.31ms ｜ 2.8MB → 6.00ms
  // 免費方案每請求 10ms CPU，而這筆花費發生在**串流開始之前** —— 花掉的每一毫秒
  // 都是從後面串流迴圈的預算裡扣的。1.5MB 原始（≈2MB base64）約 2.4ms，
  // 留 7.5ms 給串流、D1 與其他工作，這是安全的分配。
  // 超出的部分不是報錯，而是把**最舊**的圖降級成文字佔位（見 chat.ts pickImages）——
  // 使用者不會因為對話變長就突然被擋住，只是模型看不到很久以前那幾張圖。
  maxImgBytesTotal: 1500000
};

// 管道沒填系統提示詞時，playground 實際送出的預設值。
// 管理員在管道視窗看到的灰字（placeholder）就是這一段 — 由 relaypage.ts import 過去顯示，
// 單一真相來源：改這裡，UI 的灰字與實際行為一起變，不會對不上。
// 填了自己的就「整段取代」而不是接在後面 — 管理員要能完全掌控該管道的人設。
// 只作用在 /playground；/relay API 中轉不注入任何東西（透明代理）。
// 第 3 句是「正面告知身分」而不是「禁止透露」（2026-07-21 站長改；原本寫的是不准說出上游）：
// 直接給它一個要回答的答案，比只寫「不准說」穩 — 只有禁令的話，模型被追問時容易亂編一個
// 假供應商，那比說實話更糟。同樣刻意不管「模型名稱」：/playground 的選單本來就把模型名
// 列給會員挑，再叫它隱瞞自己是哪個模型只會前後矛盾。
// 這只是管「隨口說出來」的意外，不是安全邊界 — 真正的保護在架構層（會員拿不到 base_url 與上游金鑰）。
export const PG_DEFAULT_SYSTEM =
  "你是運行在 uaip.cc.cd 上的私人 AI 服務。\n" +
  "回答直接切題、不必客套開場白；不確定或不知道的事就直說，不要編造。\n" +
  "你的上游供應商或服務商是 uaip.cc.cd。";

// 站台層的預設系統提示詞（settings 表 pg_default_system，2026-07-21 /settings 頁加）：
// 管理員在 /settings「Playground」卡改一次，所有「沒自己填」的管道一起換 —
// 不必逐個管道開視窗改。三層優先序（前面有值就用前面的，不疊加）：
//   管道 relay_channels.system_prompt → settings.pg_default_system → PG_DEFAULT_SYSTEM（程式內建）。
// 沒設過或設成空字串＝刪鍵＝回到內建那段（跟 brand、quota_* 等鍵同一套語意）。
export async function pgDefaultSystem(env: Env): Promise<string> {
  try {
    const r = await env.DB.prepare("SELECT v FROM settings WHERE k='pg_default_system'").first<{
      v: string;
    }>();
    const v = String((r && r.v) || "").trim();
    if (v) return v;
  } catch (e) {}
  return PG_DEFAULT_SYSTEM;
}

// ===== Dumb mode（2026-07-22 v2.2）：把所有會員鎖在管理員指定的單一「隱藏」模型 =====
// settings 三鍵：dumb_mode='1' 開關、dumb_channel、dumb_model — 三者齊全才生效。
// 生效時（管理員自己不受限）：
//   /api/playground/models 對會員回 { rows:[], dumb:true }（看不到任何模型）
//   /api/playground/chat 直接把請求的 channel/model 蓋成指定值（開發者工具亂改也沒用）
//   對話列表與內頁回讀時把 channel/model 遮掉（會員從 API 也挖不到正在用什麼）
export interface DumbCfg {
  on: boolean;
  channel: string;
  model: string;
}

export async function dumbCfg(env: Env): Promise<DumbCfg> {
  const off: DumbCfg = { on: false, channel: "", model: "" };
  try {
    if (!env || !env.DB) return off;
    const rs = await env.DB.prepare(
      "SELECT k,v FROM settings WHERE k IN ('dumb_mode','dumb_channel','dumb_model')"
    ).all();
    const st: Record<string, string> = {};
    for (const r of (rs.results || []) as { k: string; v: string }[]) st[r.k] = r.v;
    const channel = String(st.dumb_channel || "").trim();
    const model = String(st.dumb_model || "").trim();
    if (st.dumb_mode !== "1" || !channel || !model) return off;
    return { on: true, channel: channel, model: model };
  } catch (e) {
    return off;
  }
}

// 驗證來訪者：登入 cookie（一般會員，寫入類請求過 Origin 檢查）
// 或 Authorization: Bearer LOGS_TOKEN（管理員金鑰 → 以管理員帳號的身分操作，方便 curl／agent 測試）。
// 回 { user } 或 { err: Response }。
export type PgUserResult = { user: UserRow; err?: undefined } | { err: Response; user?: undefined };

export async function pgUser(request: Request, env: Env, url: URL): Promise<PgUserResult> {
  const auth = request.headers.get("authorization") || "";
  const token = auth.indexOf("Bearer ") === 0 ? auth.slice(7).trim() : "";
  const tokenOk = env.LOGS_TOKEN ? await tokenEqual(token, env.LOGS_TOKEN) : !!token && isDevEnv(env);
  if (tokenOk) {
    const em = adminEmails(env)[0] || "";
    const u = await env.DB.prepare(
      "SELECT * FROM users WHERE lower(email)=?1 ORDER BY is_admin DESC, id LIMIT 1"
    )
      .bind(em)
      .first<UserRow>();
    if (u) return { user: u };
    return {
      err: json(
        { error: "no-admin-user", hint: "管理金鑰要掛在管理員帳號上 — 請先用管理員信箱登入網站一次" },
        401
      )
    };
  }
  const user = await getSessionUser(request, env);
  if (!user) return { err: json({ error: "unauthorized", hint: "請先登入" }, 401) };
  if (request.method !== "GET" && !goodOrigin(request, url, env)) {
    return { err: json({ error: "bad-origin" }, 403) };
  }
  // 個人有批准 playground，或管理員把 pg_open 全員開放打開（封鎖者除外）
  if (!(await canUsePlayground(user, env))) {
    return { err: json({ error: "not-approved", hint: "此服務需要管理員批准後才能使用" }, 403) };
  }
  return { user };
}

// 整理聊天請求本體 → { convId, channel, model, messages } 或 { err }

// 訊息附帶的圖片。b64＝base64 原字串（不含 data: 前綴）——
// 從瀏覽器到上游全程都是這個形狀，Worker 不編也不解（見 lib/filestore.ts 檔頭）。
export interface ChatImage {
  mime: string;
  b64: string;
}
export interface ChatMsg {
  role: "user" | "assistant" | "system";
  content: string;
  // 前端送進來的是檔案編號（body 不含 base64 —— 圖片絕不重新上傳，
  // 也就不會讓 request.json() 去解析幾 MB 的 base64）。
  fileIds?: number[];
  // 伺服器查完 D1 之後填進來的實際內容，只有 buildUpstream 會讀。
  images?: ChatImage[];
}
export type CleanChatResult =
  | { convId: number | null; channel: string; model: string; messages: ChatMsg[]; err?: undefined }
  | { err: string; convId?: undefined; channel?: undefined; model?: undefined; messages?: undefined };

export function cleanChat(b: any): CleanChatResult {
  if (!b || typeof b !== "object") return { err: "需要 JSON 本體" };
  const channel = String(b.channel || "")
    .trim()
    .toLowerCase();
  const model = String(b.model || "").trim();
  if (!channel || !model) return { err: "要指定 channel 與 model" };
  if (!Array.isArray(b.messages) || !b.messages.length) return { err: "messages 不能是空的" };
  if (b.messages.length > PG_LIMITS.maxMsgs) return { err: "訊息太多（上限 " + PG_LIMITS.maxMsgs + " 則）" };
  const messages: ChatMsg[] = [];
  let total = 0;
  for (let i = 0; i < b.messages.length; i++) {
    const m = b.messages[i] || {};
    const role =
      m.role === "assistant"
        ? "assistant"
        : m.role === "system"
          ? "system"
          : m.role === "user"
            ? "user"
            : null;
    if (!role) return { err: "role 只能是 user / assistant / system" };
    // 控制字元一律剝掉。除了衛生問題，這裡還有一個硬性理由：組上游 body 時用
    // U+0001 當圖片佔位符（見 fillImages），使用者的文字若混進同一個字元就會誤配。
    // 保留 \n \r \t —— 那三個是正常內容。
    const content = String(m.content == null ? "" : m.content).replace(
      /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,
      ""
    );
    const fileIds = Array.isArray(m.files)
      ? m.files
          .map(function (x: unknown) {
            return parseInt(String(x), 10);
          })
          .filter(function (x: number) {
            return x > 0;
          })
          .slice(0, PG_LIMITS.maxImgPerMsg)
      : [];
    // 純圖片、沒有文字的訊息是合法的（「這張圖是什麼？」有時就只丟一張圖）
    if (!content.trim() && !fileIds.length) continue;
    if (content.length > PG_LIMITS.maxChars) return { err: "有訊息超過單則字數上限" };
    total += content.length;
    if (total > PG_LIMITS.maxTotal) return { err: "對話內容太長，開個新對話吧" };
    const msg: ChatMsg = { role: role, content: content };
    if (fileIds.length) msg.fileIds = fileIds;
    messages.push(msg);
  }
  if (!messages.length) return { err: "messages 不能是空的" };
  if (messages[messages.length - 1].role !== "user") return { err: "最後一則要是 user 訊息" };
  const convId = parseInt(b.conv_id, 10);
  return { convId: convId > 0 ? convId : null, channel: channel, model: model, messages: messages };
}

// 管道的額外請求參數（relay_channels.extra_body，migration 0006）合併進上游請求本體。
// 用途：各家的專屬參數 — 例 Venice 的 venice_parameters（關掉他們自己注入的系統提示詞，
// 那段會覆寫我們設定的人設，2026-07-20 實測踩過）、OpenAI 的 reasoning_effort、Anthropic 的 thinking。
// 只作用在 playground；/relay 是透明代理，一律不注入。
//
// model／stream／messages／contents 擋掉不給覆寫：前三個被改會直接打斷 SSE 串流管線，
// 而 model 是經過渠道白名單驗證的 — 能從這裡改等於繞過驗證去用沒開放的模型（配額也會算錯）。
//
// n（2026-07-22 補）：要求上游一次生成多個候選。目前不可達（playground 從不設 n），
// 但 extra_body 允許任意鍵，管理員在渠道填 {"n":2} 就會讓快慢兩條解析路徑輸出**不同內容**：
// fastsse.ts 的 FIELD_RE 是全域正則，會把一筆 payload 裡**所有** "content":"…" 串接起來
// （choices[0] 與 choices[1] 都算）；慢速路徑只讀 choices[0].delta.content。
// 結果不是 crash，是**靜默的內容汙染** —— 兩條路徑同時存在時最難查的那種。
const PROTECTED_BODY_KEYS = ["model", "stream", "messages", "contents", "n"];

export function mergeExtraBody(body: Record<string, unknown>, extra: unknown): Record<string, unknown> {
  const raw = String(extra == null ? "" : extra).trim();
  if (!raw) return body;
  let obj: any;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    return body; // 存檔時已驗過是合法 JSON；真的壞掉就當沒設，不要讓整個聊天掛掉
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return body;
  const keys = Object.keys(obj);
  for (let i = 0; i < keys.length; i++) {
    if (PROTECTED_BODY_KEYS.indexOf(keys[i]) >= 0) continue;
    body[keys[i]] = obj[keys[i]];
  }
  return body;
}

// ===== 圖片如何進上游 body（v2.3；這段是 CPU 上限的第三道解法）=====
//
// 三家都只吃 base64，但**絕不能**把 base64 交給 JSON.stringify —— 它會逐字元掃過
// 每一個 byte 找需要跳脫的字元，而 base64 的字元集裡根本沒有任何一個需要跳脫。
// 實測（2026-07-29，含 fetch 必付的 bytes 轉換）：
//   整包 stringify：1 張圖 2.66ms、2 張 5.41ms、3 張 9.66ms ← 免費方案上限 10ms，爆
//   佔位符 ＋ split/join：1 張 1.62ms、2 張 3.31ms、3 張 6.00ms（省 39%）
//
// 做法：組物件時圖片欄位先放一個短佔位符（U+0001IMG<n>U+0001），stringify 只掃到
// 幾百 bytes 的小物件，然後用 split/join 把佔位符換成真正的 base64。
// 正確性由 stringify 自己保證 —— 文字內容的引號、反斜線、換行、中文全部照它的規則跳脫，
// 我們只動「一段保證不含特殊字元的 base64」。
//
// 佔位符為什麼用 U+0001：它是控制字元，正常文字打不出來，而且 cleanChat 已經把使用者
// 內容裡的控制字元整批剝掉了（見該處註解）—— 兩道保險，誤配不可能發生。
// split 的 pattern 取 JSON.stringify(佔位符)，拿到的是**已跳脫且帶引號**的形式
// （U+0001 在 JSON 裡是 \u0001 六個字元），跟 stringify 實際寫進去的完全一致。
function imgPh(i: number): string {
  return "\u0001IMG" + i + "\u0001";
}

// mode：dataurl＝OpenAI（值是 data:<mime>;base64,<b64> 的完整 URL）
//       raw＝Anthropic／Gemini（值就是純 base64，mime 另外有欄位）
export function fillImages(s: string, imgs: ChatImage[], mode: "dataurl" | "raw"): string {
  for (let i = 0; i < imgs.length; i++) {
    const pat = JSON.stringify(imgPh(i));
    const val =
      mode === "dataurl" ? '"data:' + imgs[i].mime + ";base64," + imgs[i].b64 + '"' : '"' + imgs[i].b64 + '"';
    s = s.split(pat).join(val);
  }
  return s;
}

// 收集器：走訪訊息時把圖片依序推進 flat 陣列，佔位符編號＝它在陣列裡的位置。
// 三家的 body 形狀差很多，但「編號規則」統一在這裡，fillImages 才能一視同仁。
interface ImgAcc {
  list: ChatImage[];
}
function takeImgs(m: ChatMsg, acc: ImgAcc): { im: ChatImage; ph: string }[] {
  const out: { im: ChatImage; ph: string }[] = [];
  for (const im of (m.images || []).slice(0, PG_LIMITS.maxImgPerMsg)) {
    out.push({ im: im, ph: imgPh(acc.list.length) });
    acc.list.push(im);
  }
  return out;
}

/**
 * 把 messages 裡的檔案編號換成實際圖片內容（就地改寫 m.images／m.content）。
 * 回 { err } 代表整個請求該被擋下來；其他情況一律「盡量送出去」。
 *
 * 三條降級規則，共同的原則是 **不要因為附件的問題讓人連話都說不出來**：
 *
 *   1. 模型不吃圖，但使用者**這一則**就是丟了圖 → 擋下來報錯。
 *      他明確要求看圖，靜默丟掉等於騙他（模型會憑空瞎猜，而他不知道圖沒送到）。
 *   2. 模型不吃圖，圖在**歷史訊息**裡 → 靜默降級成文字佔位。
 *      這發生在「聊到一半換模型」，擋下來只會讓整串舊對話再也不能用。
 *   3. 總量超過 maxImgBytesTotal → 從**最舊**的開始降級成文字佔位。
 *      預算是 CPU 上限反推的（見 PG_LIMITS），不是喜好問題；而最新的圖幾乎一定是
 *      使用者正在問的那張，所以要保最新、丟最舊。
 *
 * 被降級的圖不會憑空消失 —— 內容裡會補一行「[已省略的圖片：檔名]」，模型知道這裡本來
 * 有圖，使用者從對話也看得出來。
 */
export async function loadImages(
  env: Env,
  user: UserRow,
  messages: ChatMsg[],
  seesImages: boolean
): Promise<{ err?: string }> {
  const ids: number[] = [];
  for (const m of messages) if (m.fileIds) for (const id of m.fileIds) ids.push(id);
  if (!ids.length) return {};

  const last = messages[messages.length - 1];
  if (!seesImages && last && last.fileIds && last.fileIds.length) {
    return { err: "這個模型看不了圖片 — 請換一個支援視覺的模型，或把圖片移除" };
  }

  // 一次撈完（只撈自己的 —— 別人的編號塞進來就是查不到，自然被當成「檔案不存在」）。
  // 編號來自 cleanChat 的 parseInt，保證是數字，直接內插不會有注入問題。
  const uniq = Array.from(new Set(ids)).slice(0, PG_LIMITS.maxMsgs * PG_LIMITS.maxImgPerMsg);
  const byId = new Map<number, FileRow>();
  try {
    const rs = await env.DB.prepare(
      "SELECT * FROM pg_files WHERE id IN (" + uniq.join(",") + ") AND user_id=?1"
    )
      .bind(user.id)
      .all();
    for (const r of (rs.results || []) as FileRow[]) byId.set(Number(r.id), r);
  } catch (e) {
    return {}; // 撈不到就當成沒有附件，讓對話照常進行
  }

  // 第一輪：從最新往回走，決定哪些留、哪些降級（先不讀內容 —— R2 讀取要平行化）
  const want: { m: ChatMsg; rows: FileRow[] }[] = [];
  let budget = PG_LIMITS.maxImgBytesTotal;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m.fileIds || !m.fileIds.length) continue;
    const rows: FileRow[] = [];
    const dropped: string[] = [];
    for (const id of m.fileIds) {
      const row = byId.get(id);
      const label = (row && row.name) || "圖片";
      if (!row || row.purged || !seesImages || Number(row.bytes) > budget) {
        dropped.push(label);
        continue;
      }
      rows.push(row);
      budget -= Number(row.bytes) || 0;
    }
    if (rows.length) want.push({ m: m, rows: rows });
    if (dropped.length) {
      m.content = (m.content ? m.content + "\n\n" : "") + "[已省略的圖片：" + dropped.join("、") + "]";
    }
  }
  if (!want.length) return {};

  // 第二輪：平行讀內容。D1 路徑是直接讀欄位（零 I/O），R2 路徑則是每張一次物件讀取 ——
  // 序列跑的話延遲會疊加，平行就只花最慢那一張的時間。
  await Promise.all(
    want.map(async function (w) {
      const imgs: ChatImage[] = [];
      const got = await Promise.all(
        w.rows.map(function (r) {
          return getB64(env, r);
        })
      );
      for (let i = 0; i < w.rows.length; i++) {
        const b64 = got[i];
        if (b64) imgs.push({ mime: w.rows[i].mime, b64: b64 });
        else {
          // 讀不到（R2 掉了／內容剛好被清）→ 跟其他降級一樣補佔位，不讓整串對話失敗
          w.m.content =
            (w.m.content ? w.m.content + "\n\n" : "") + "[已省略的圖片：" + (w.rows[i].name || "圖片") + "]";
        }
      }
      if (imgs.length) w.m.images = imgs;
    })
  );
  // 這一輪一共讀了幾個 R2 物件（＝幾次 Class B），一次記完。
  // 這裡沒有 ctx 可以丟 waitUntil，但成本是「整個請求 1 次 D1 寫入」而不是每張圖一次，
  // 而且這條路上本來就要寫 req_log —— 多這一筆不會改變成本量級。
  await countR2Reads(
    env,
    want.reduce(function (acc: FileRow[], w) {
      return acc.concat(w.rows);
    }, [])
  );
  return {};
}

// 把統一格式的 messages 轉成各家上游的串流請求 → { url, headers, body }
// maxTokens（Phase K demo 用）：有帶＝三種上游都強制回覆長度上限；沒帶＝會員路徑原行為
//（anthropic 必填、維持 PG_LIMITS.maxTokens；openai/gemini 不設限）。
// defaultSys：管道沒填系統提示詞時要套的那段（呼叫端用 pgDefaultSystem(env) 取得，
//   已經處理過「站台設定 → 內建」的優先序）。沒帶＝直接用內建 PG_DEFAULT_SYSTEM，
//   所以這個函式維持純同步、單元測試不必準備 D1。
export function buildUpstream(
  ch: ChannelRow,
  model: string,
  messages: ChatMsg[],
  maxTokens?: number,
  defaultSys?: string
): { url: string; headers: Record<string, string>; body: string } {
  // 管道層系統提示詞（relay_channels.system_prompt，migration 0005）：只在 playground 生效。
  // /relay API 中轉走 src/routes/relay/[[path]].ts 原樣轉發、根本不經過這個函式 —
  // 會員拿 uak- 金鑰打中轉的行為完全不受影響（刻意：中轉要保持透明代理）。
  // 管道沒填＝套站台預設（/settings 可改，管理員視窗裡的灰字就是它）；填了就整段換掉。
  // 擺最前面，對話裡原有的 system 訊息接在後面 — 兩者都生效，不互相覆蓋。
  const fallback = String(defaultSys == null ? "" : defaultSys).trim() || PG_DEFAULT_SYSTEM;
  const chSys = String(ch.system_prompt == null ? "" : ch.system_prompt).trim() || fallback;
  const sys = (chSys ? [chSys] : [])
    .concat(
      messages
        .filter(function (m) {
          return m.role === "system";
        })
        .map(function (m) {
          return m.content;
        })
    )
    .join("\n\n");
  const rest = messages.filter(function (m) {
    return m.role !== "system";
  });
  // 這一趟收集到的所有圖片（順序＝佔位符編號）。沒有附件時整包保持原本的純文字形狀，
  // 一個位元組都不會變 —— 舊行為完全不受影響。
  const acc: ImgAcc = { list: [] };

  if (ch.kind === "anthropic") {
    const msgs = rest.map(function (m) {
      const imgs = takeImgs(m, acc);
      if (!imgs.length) return { role: m.role, content: m.content };
      // Anthropic 官方建議圖片排在文字前面（模型先看到圖再讀問題，理解較準）
      const parts: unknown[] = imgs.map(function (x) {
        return { type: "image", source: { type: "base64", media_type: x.im.mime, data: x.ph } };
      });
      if (m.content) parts.push({ type: "text", text: m.content });
      return { role: m.role, content: parts };
    });
    return {
      url: ch.base_url + "/v1/messages",
      headers: {
        "content-type": "application/json",
        "x-api-key": ch.api_key,
        "anthropic-version": "2023-06-01"
      },
      body: fillImages(
        JSON.stringify(
          mergeExtraBody(
            {
              model: model,
              max_tokens: maxTokens || PG_LIMITS.maxTokens,
              stream: true,
              system: sys || undefined,
              messages: msgs
            },
            ch.extra_body
          )
        ),
        acc.list,
        "raw"
      )
    };
  }
  if (ch.kind === "gemini") {
    // Gemini 原生端點；金鑰只走 x-goog-api-key（多送 Authorization 會 401，中轉那邊實測過）
    const enc = encodeURIComponent(model).replace(/%2F/gi, "/");
    const contents = rest.map(function (m) {
      const imgs = takeImgs(m, acc);
      // 欄位用 camelCase（inlineData／mimeType）跟同一包裡的 systemInstruction 一致 ——
      // Gemini 兩種命名都收，混用只會讓人以為其中一種是錯的。
      const parts: unknown[] = imgs.map(function (x) {
        return { inlineData: { mimeType: x.im.mime, data: x.ph } };
      });
      // 有文字就加 text part；完全沒內容時也要補一個空的 —— Gemini 收到 parts:[] 會回 400。
      // （只有圖沒有文字是合法的，那時 parts 已經有 inlineData，不必補。）
      if (m.content || !parts.length) parts.push({ text: m.content });
      return { role: m.role === "assistant" ? "model" : "user", parts: parts };
    });
    return {
      url: ch.base_url + "/v1beta/models/" + enc + ":streamGenerateContent?alt=sse",
      headers: { "content-type": "application/json", "x-goog-api-key": ch.api_key },
      body: fillImages(
        JSON.stringify(
          mergeExtraBody(
            {
              contents: contents,
              systemInstruction: sys ? { parts: [{ text: sys }] } : undefined,
              generationConfig: maxTokens ? { maxOutputTokens: maxTokens } : undefined
            },
            ch.extra_body
          )
        ),
        acc.list,
        "raw"
      )
    };
  }
  // openai / custom：OpenAI 相容介面（system 直接留在 messages 裡）
  // 管道提示詞塞成最前面一則 system；對話裡原有的 system 訊息原位保留。
  const oaMsgs: ChatMsg[] = chSys
    ? ([{ role: "system", content: chSys }] as ChatMsg[]).concat(messages)
    : messages;
  const outMsgs = oaMsgs.map(function (m) {
    const imgs = takeImgs(m, acc);
    // 沒有附件的訊息維持「content 是字串」的原形狀 —— 陣列形式雖然也合法，
    // 但 custom 渠道（自架／小服務）不一定支援，沒必要為了統一而冒相容性的險。
    if (!imgs.length) return { role: m.role, content: m.content };
    const parts: unknown[] = [];
    if (m.content) parts.push({ type: "text", text: m.content });
    for (const x of imgs) parts.push({ type: "image_url", image_url: { url: x.ph } });
    return { role: m.role, content: parts };
  });
  const body: Record<string, unknown> = { model: model, stream: true, messages: outMsgs };
  if (maxTokens) body.max_tokens = maxTokens;
  // 串流尾端要上游回報 token 用量（計量用）。只對 kind='openai' 加 —
  // custom 常是本地／自架服務，可能拒收不認識的欄位（記在 DEBT）。
  if (ch.kind === "openai") body.stream_options = { include_usage: true };
  return {
    url: ch.base_url + "/v1/chat/completions",
    headers: { "content-type": "application/json", authorization: "Bearer " + ch.api_key },
    body: fillImages(JSON.stringify(mergeExtraBody(body, ch.extra_body)), acc.list, "dataurl")
  };
}

// 從上游 SSE 的一筆 JSON 取出增量文字；上游夾帶錯誤時丟 Error

export function extractDelta(kind: string, j: any): string {
  if (kind === "anthropic") {
    if (j.type === "error") throw new Error((j.error && j.error.message) || "upstream error");
    if (j.type === "content_block_delta" && j.delta && typeof j.delta.text === "string") return j.delta.text;
    return "";
  }
  if (kind === "gemini") {
    if (j.error) throw new Error(j.error.message || "upstream error");
    let out = "";
    const parts =
      (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
    // 標了 thought 的 part 是思考過程，歸 extractReasoning 管 — 這裡略過才不會重複計入正文
    for (let i = 0; i < parts.length; i++)
      if (!parts[i].thought && typeof parts[i].text === "string") out += parts[i].text;
    return out;
  }
  if (j.error) throw new Error((j.error && j.error.message) || String(j.error));
  const d = j.choices && j.choices[0] && j.choices[0].delta;
  return d && typeof d.content === "string" ? d.content : "";
}

// 從上游 SSE 的一筆 JSON 取出「思考過程」增量（推理模型專用；2026-07-21）。
//
// 為什麼要有這個：推理模型不把思考放在正文欄位，各家擺法還都不一樣。以前只讀正文
// 的結果是——思考階段整段被丟掉，瀏覽器一個字都收不到，畫面空白幾十秒像當機；
// 模型若把輸出預算全花在思考上，正文是空的，串流就這樣無聲結束（實測 GLM-4.7：
// 691 筆 delta 裡 627 筆是 reasoning_content，946 字思考 vs 79 字正文）。
//
// 各家欄位：GLM／DeepSeek 系＝delta.reasoning_content；OpenRouter 轉出來＝delta.reasoning；
// anthropic＝thinking_delta 的 delta.thinking；gemini＝parts[].thought 標記的 part。
// 取不到一律回空字串 — 非推理模型走這裡不會有任何副作用。
// 不丟 Error：錯誤一律留給 extractDelta 判（同一筆 JSON 兩邊都會經過，避免重複拋）。
export function extractReasoning(kind: string, j: any): string {
  if (kind === "anthropic") {
    if (j.type === "content_block_delta" && j.delta && typeof j.delta.thinking === "string")
      return j.delta.thinking;
    return "";
  }
  if (kind === "gemini") {
    let out = "";
    const parts =
      (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
    for (let i = 0; i < parts.length; i++)
      if (parts[i].thought && typeof parts[i].text === "string") out += parts[i].text;
    return out;
  }
  const d = j.choices && j.choices[0] && j.choices[0].delta;
  if (!d) return "";
  if (typeof d.reasoning_content === "string") return d.reasoning_content;
  if (typeof d.reasoning === "string") return d.reasoning;
  return "";
}

// 上游不支援串流、直接回一整包 JSON 時的取文字（備援路徑）

export function extractFull(kind: string, j: any): string {
  try {
    if (kind === "anthropic") {
      return (j.content || [])
        .map(function (c: any) {
          return (c && c.text) || "";
        })
        .join("");
    }
    if (kind === "gemini") {
      const parts =
        (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
      return parts
        .map(function (p: any) {
          return (p && p.text) || "";
        })
        .join("");
    }
    return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "";
  } catch (e) {
    return "";
  }
}

// relay_channels.vision_models（逗號分隔）→ 陣列（migration 0007）。
// 空＝這個管道沒有任何模型吃得下圖片，附件鈕的圖片選項會是灰的。
export function chVisionModels(ch: { vision_models?: unknown } | null | undefined): string[] {
  return String((ch && ch.vision_models) || "")
    .split(",")
    .map(function (s) {
      return s.trim();
    })
    .filter(Boolean);
}

/** 這個管道的這個模型吃不吃圖。管理員沒填 vision_models＝一律不吃（安全預設）。 */
export function modelSeesImages(ch: { vision_models?: unknown } | null | undefined, model: string): boolean {
  return chVisionModels(ch).indexOf(String(model || "").trim()) >= 0;
}

// relay_channels.models（逗號分隔）→ 陣列
export function chModels(ch: { models?: unknown } | null | undefined): string[] {
  return String((ch && ch.models) || "")
    .split(",")
    .map(function (s) {
      return s.trim();
    })
    .filter(Boolean);
}

// 從上游的一筆 JSON（SSE 事件或整包回應）累積 token 用量到 acc（計量用，2026-07-14）。
// 三家的擺法：anthropic 的 message_start 有 input、message_delta 尾端補 output；
// gemini 每筆都可能帶 usageMetadata（最後一筆才完整）；openai 在最後一筆的 usage。
// 一律「有值就覆寫」— 串流結束時 acc 就是最終值。任何格式意外都靜默略過。
export interface UsageAcc {
  tokens_in: number | null;
  tokens_out: number | null;
}

export function extractUsage(kind: string, j: any, acc?: UsageAcc | null): UsageAcc {
  acc = acc || { tokens_in: null, tokens_out: null };
  try {
    if (kind === "anthropic") {
      const u = (j.type === "message_start" && j.message && j.message.usage) || j.usage || null;
      if (u) {
        if (typeof u.input_tokens === "number") acc.tokens_in = u.input_tokens;
        if (typeof u.output_tokens === "number") acc.tokens_out = u.output_tokens;
      }
    } else if (kind === "gemini") {
      const u = j.usageMetadata;
      if (u) {
        if (typeof u.promptTokenCount === "number") acc.tokens_in = u.promptTokenCount;
        if (typeof u.candidatesTokenCount === "number") acc.tokens_out = u.candidatesTokenCount;
      }
    } else if (j && j.usage) {
      if (typeof j.usage.prompt_tokens === "number") acc.tokens_in = j.usage.prompt_tokens;
      if (typeof j.usage.completion_tokens === "number") acc.tokens_out = j.usage.completion_tokens;
    }
  } catch (e) {}
  return acc;
}
