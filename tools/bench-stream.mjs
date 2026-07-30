// tools/bench-stream.mjs — 串流迴圈的**整條路徑** benchmark（2026-07-30）。
//
// 用法：
//   node --expose-gc tools/bench-stream.mjs            # 完整報告（三張表）
//   node --expose-gc tools/bench-stream.mjs 4000       # 指定增量筆數
//
// ── 這支工具為什麼必須存在（tools/bench-sse.mjs 已經有了，為什麼還要一支）──
//
// 2026-07-30 線上出事：`POST /api/playground/chat` 被 Cloudflare 以
// `Worker exceeded CPU time limit.` 殺掉，dashboard 記錄的是 **CPU 2.02 秒 / wall 65 秒**。
// 同一天另一筆 **CPU 2.14 秒 / wall 67 秒**，而成功的請求也在 **84ms**（免費方案上限 10ms，
// 靠 Cloudflare「偶爾超標放你過」的彈性活著 —— 官方文件原文：each isolate has some
// built-in flexibility […] if your Worker starts hitting the limit consistently,
// its execution will be terminated）。
//
// 問題是 bench-sse.mjs 說 5982 筆增量只要 4.2ms。**線上是 2020ms，差 480 倍。**
// 那支 bench 沒有錯，它只是**只量了解析那一段**（自己的檔頭就寫明了：「量的是解析側，
// 寫入側的批次合併不在這裡 —— 那個要真的跑 TransformStream 才量得到」）。
// 480 倍的落差只可能藏在它沒量的那些地方，所以這支把**整條迴圈**搬過來：
//
//   ① 緩衝區切割    buf += decode() ／ indexOf("\n") ／ buf.slice()
//   ② 解析          fastDelta()（＋放棄時退回 JSON.parse）
//   ③ 批次累積      await push() → flush()，含 async/await 本身的配置成本
//   ④ 串流寫入      真的 TransformStream ＋ JSON.stringify ＋ TextEncoder ＋
//                   send() 裡的 Promise.race / setTimeout 死鎖斷路器
//
// ── 三個設計決定，任何一個做錯就會量出假數字 ──
//
// 1.【Workers 的時鐘】`Date.now()` 在 Workers 裡**只在 I/O 之後前進**（防時序攻擊）。
//    chat.ts 的 flush 門檻是「1000 字**或** 100ms」，所以時鐘行為會直接改變 flush 次數 ——
//    用 Node 原生時鐘量，迴圈跑得太快、100ms 那條永遠不會觸發，flush 次數會嚴重低估。
//    這裡改用假時鐘：只在 read() 時前進，跟正式環境一致（migration 0010 就是踩過這個坑）。
//
// 2.【按 bytes 切封包，不按增量切】真實的 reader.read() 給的是網路封包，SSE 事件會
//    橫跨封包邊界。站長原本的假設是「封包太碎造成的」—— 要驗證這件事，就必須讓
//    「每個封包幾個 bytes」變成可掃的變數，而不是預設一個封包剛好一筆增量。
//
// 3.【用消去法歸因，不塞計時器】在熱迴圈裡插 performance.now() 會改變 JIT 的行為，
//    量到的是「被計時器污染的迴圈」。改成累加式階段：階段 N 與階段 N-1 的差
//    就是那一段的成本。慢，但誠實。
//
// 輸出的三張表分別回答三個問題：
//   表一 階段歸因   —— 480 倍藏在哪一段？
//   表二 封包碎裂   —— 「封包太碎」的假設對不對？往哪個方向才會變糟？
//   表三 筆數擴展   —— 是「常數太大」還是「有 O(n²)」？（每筆成本是否隨 N 上升）
import { performance } from "node:perf_hooks";
import { fastDelta } from "../src/lib/fastsse.ts";

const N_DEFAULT = 4000; // 65 秒 × qwen3-5-9b 實測約 32 tokens/秒 ≈ 2000～4000 筆
const N = parseInt(process.argv[2] || String(N_DEFAULT), 10);
const TRIALS = 5;
const WARMUP = 2;
const HANG_MS = 5000; // 對齊 chat.ts 的 BG.hangMs
const gc = typeof global.gc === "function" ? global.gc : null;

/* ═══════════════════════════════════════════════════════════════════
   造出跟線上同形狀的 SSE 位元組流
   形狀取自 ADR-0011（每筆約 184 bytes、OpenAI 相容 chat.completion.chunk），
   內容以中文為主、每 10 筆混一個要反跳脫的東西 —— 跟 bench-sse.mjs 同一套，
   兩支工具的數字才能互相對照。
   ═══════════════════════════════════════════════════════════════════ */
const PLAIN = ["的", "說", "，", "。", "程式", "資料", "問題", "可以", "一個", "系統"];
const ESCAPED = ["\\n", '\\"', "🙂"];
function tokenAt(i) {
  return i % 10 === 9 ? ESCAPED[Math.floor(i / 10) % ESCAPED.length] : PLAIN[i % PLAIN.length];
}
// field＝"content" 或 "reasoning_content"（推理模型思考時吐的是後者）
function chunkJson(i, field) {
  return (
    '{"id":"chatcmpl-Bx7K2mQ9vZ3nR8sT1uW4xY","object":"chat.completion.chunk",' +
    '"created":1753142400,"model":"qwen3-5-9b",' +
    '"choices":[{"index":0,"delta":{"' +
    field +
    '":"' +
    tokenAt(i) +
    '"},"finish_reason":null}]}'
  );
}
// mode：content＝純正文（ADR-0011 當年量的形狀）
//       think  ＝前 60% 思考、後 40% 正文（推理模型的典型形狀，也是這次出事的形狀）
//       alt    ＝思考與正文逐筆交錯（最壞情況：pendKind 每筆都翻 → 批次合併整個失效）
function makeWire(n, mode) {
  const parts = [];
  for (let i = 0; i < n; i++) {
    let field = "content";
    if (mode === "think") field = i < n * 0.6 ? "reasoning_content" : "content";
    else if (mode === "alt") field = i % 2 === 0 ? "reasoning_content" : "content";
    parts.push("data: " + chunkJson(i, field) + "\n\n");
  }
  parts.push("data: [DONE]\n\n");
  return new TextEncoder().encode(parts.join(""));
}
// 按 bytes 切成一連串 reader.read() 會拿到的封包（事件自然會橫跨邊界，跟真實網路一樣）
function toReads(wire, bytesPerRead) {
  const reads = [];
  for (let o = 0; o < wire.length; o += bytesPerRead) {
    reads.push(wire.subarray(o, Math.min(o + bytesPerRead, wire.length)));
  }
  return reads;
}

/* ═══════════════════════════════════════════════════════════════════
   Workers 的假時鐘 —— 只在 read() 時前進（見檔頭設計決定 1）
   gapMs 由「上游多久給一個封包」決定：封包越大、間隔越久。
   ═══════════════════════════════════════════════════════════════════ */
function makeClock(gapMs) {
  let t = 1753142400000;
  return {
    now: function () {
      return t;
    },
    tick: function () {
      t += gapMs;
    }
  };
}

/* ═══════════════════════════════════════════════════════════════════
   chat.ts 串流迴圈的複製品

   stage 決定做到哪一段（累加式，見檔頭設計決定 3）：
     1 = 只有緩衝區切割          ①
     2 = ＋解析                  ①②
     3 = ＋批次累積（send 空轉）  ①②③
     4 = ＋真的寫進 TransformStream ①②③④  ← 這才是正式環境
   ═══════════════════════════════════════════════════════════════════ */
async function runLoop(reads, stage, gapMs) {
  const clock = makeClock(gapMs);
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  let full = "",
    sawReasoning = false,
    lines = 0,
    deltas = 0,
    writes = 0,
    slowParses = 0;

  // 只有 stage 4 需要真的串流。TransformStream 一定要有人在讀，
  // 否則背壓永不解除、writer.write() 永遠不回來 —— 那正是 chat.ts 註解裡
  // 記載的線上死鎖（outcome=canceled）。
  let ts = null,
    writer = null,
    drained = null;
  if (stage >= 4) {
    ts = new TransformStream();
    writer = ts.writable.getWriter();
    drained = (async function () {
      const r = ts.readable.getReader();
      for (;;) {
        const s = await r.read();
        if (s.done) break;
      }
    })();
  }

  // send()：完整複製 chat.ts 的死鎖斷路器（Promise.race ＋ setTimeout ＋ clearTimeout）。
  // 這三樣東西每次 flush 都要配置一次 —— 是否貴，就是這支 bench 要回答的事情之一。
  function send(obj) {
    if (stage < 4) return Promise.resolve();
    writes++;
    let timer = null;
    const wrote = writer.write(enc.encode("data: " + JSON.stringify(obj) + "\n\n")).catch(function () {});
    const guard = new Promise(function (res) {
      timer = setTimeout(res, HANG_MS);
    });
    return Promise.race([wrote, guard]).then(function () {
      if (timer) clearTimeout(timer);
    });
  }

  let pend = "",
    pendKind = null,
    lastFlush = clock.now(),
    flushes = 0;
  async function flush() {
    if (!pend || !pendKind) return;
    const payload = pendKind === "r" ? { r: pend } : { d: pend };
    pend = "";
    lastFlush = clock.now();
    flushes++;
    await send(payload);
  }
  async function push(kind, text) {
    if (pendKind !== kind) {
      await flush();
      pendKind = kind;
    }
    pend += text;
    if (pend.length >= 1000 || clock.now() - lastFlush >= 100) await flush();
  }

  let buf = "";
  for (let ri = 0; ri < reads.length; ri++) {
    clock.tick(); // reader.read() 是 I/O → Workers 的時鐘只在這裡前進
    buf += dec.decode(reads[ri], { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, "");
      buf = buf.slice(idx + 1);
      lines++;
      if (line.indexOf("data:") !== 0) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      if (stage < 2) continue;
      deltas++;
      let d = "",
        r = "";
      const fast = fastDelta(payload);
      if (fast) {
        d = fast.d;
        r = fast.r;
      } else {
        // 快速路徑放棄 → 退回完整解析（正式程式碼就是這個行為，量測必須包含它）
        slowParses++;
        const j = JSON.parse(payload);
        const dl = j.choices && j.choices[0] && j.choices[0].delta;
        if (dl) {
          if (typeof dl.content === "string") d = dl.content;
          if (typeof dl.reasoning_content === "string") r = dl.reasoning_content;
        }
      }
      if (stage < 3) continue;
      if (r) {
        sawReasoning = true;
        await push("r", r);
      }
      if (d) {
        full += d;
        await push("d", d);
      }
    }
  }
  if (stage >= 3) await flush();
  if (stage >= 4) {
    await writer.close();
    await drained;
  }
  return { fullLen: full.length, lines, deltas, writes, flushes, slowParses, sawReasoning };
}

/* ═══════════════════════════════════════════════════════════════════
   量測：CPU 時間（不是 wall）
   Workers 計費的是 CPU，而這支 bench 有 async/await 與串流，wall 會被
   microtask 排程稀釋。process.cpuUsage() 才是對得上 Cloudflare 那一欄的數字。

   ⚠️ 第一版寫錯過，留著當教訓：直接對「跑一趟」呼叫 process.cpuUsage() 量出來的
   全部是 0.00／16.00／31.00／47.00 —— 那不是數據，是 **Windows 的排程器顆粒度
   15.6ms** 的倍數。單趟只花幾毫秒，整份報告就變成一堆量化雜訊，還會騙人地長得
   很像「某些設定完全不花 CPU」。
   解法：每次量測內部重複跑 R 趟，讓總量遠大於顆粒度，再除回去。R 用先跑一趟的
   wall 時間自動推算（目標每次量測約 250ms），這樣不管機器快慢都夠準。
   ═══════════════════════════════════════════════════════════════════ */
const TARGET_MS = 250; // 每次量測的目標總時長 —— 必須遠大於 15.6ms 顆粒度
async function measure(reads, stage, gapMs) {
  // 先探一趟決定要重複幾次（這一趟同時當暖身，讓 V8 先 JIT）
  const probe0 = performance.now();
  let info = await runLoop(reads, stage, gapMs);
  const probeMs = Math.max(performance.now() - probe0, 0.01);
  const repeat = Math.min(500, Math.max(1, Math.ceil(TARGET_MS / probeMs)));

  const cpus = [];
  const walls = [];
  for (let t = 0; t < WARMUP + TRIALS; t++) {
    if (gc) gc();
    const c0 = process.cpuUsage();
    const w0 = performance.now();
    for (let k = 0; k < repeat; k++) info = await runLoop(reads, stage, gapMs);
    const w1 = performance.now();
    const c1 = process.cpuUsage(c0);
    if (t >= WARMUP) {
      cpus.push((c1.user + c1.system) / 1000 / repeat); // µs → ms，再除回單趟
      walls.push((w1 - w0) / repeat);
    }
  }
  cpus.sort(function (a, b) {
    return a - b;
  });
  walls.sort(function (a, b) {
    return a - b;
  });
  return {
    cpu: cpus[Math.floor(cpus.length / 2)],
    wall: walls[Math.floor(walls.length / 2)],
    repeat: repeat,
    info: info
  };
}

const f = (n, w = 8, p = 2) => n.toFixed(p).padStart(w);

/* ═══════════════════════════════════════════════════════════════════
   正確性先於速度：四個階段抽出來的正文必須完全一致，
   否則下面的數字只證明了「其中一種比較快」。
   ═══════════════════════════════════════════════════════════════════ */
const wireCheck = makeWire(200, "think");
const s3 = await runLoop(toReads(wireCheck, 900), 3, 30);
const s4 = await runLoop(toReads(wireCheck, 900), 4, 30);
if (s3.fullLen !== s4.fullLen || s3.deltas !== s4.deltas) {
  console.error("✗ 階段之間的輸出不一致 —— bench 本身有錯，數字不用看");
  process.exit(1);
}

console.log("");
console.log("串流迴圈整條路徑 benchmark（線上事故：CPU 2.02s / wall 65s，免費上限 10ms）");
console.log("  增量筆數  " + N + " 筆（65 秒 × 約 32 tokens/秒）");
console.log("  試跑      " + WARMUP + " 暖身 + " + TRIALS + " 次取中位數；量的是 CPU 時間");
console.log("  正確性    ✓ 階段 3／4 抽出的正文一致（" + s3.fullLen + " 字 / " + s3.deltas + " 筆）");
if (!gc) console.log("  ⚠ 建議加 --expose-gc，否則每次試跑的堆不乾淨、數字會飄");

/* ───────────────────── 表一：階段歸因 ───────────────────── */
// 封包大小取「一筆增量一個封包」附近（線上 SSE 常態），間隔 30ms 對齊 32 tokens/秒
const STAGE_BYTES = 200;
const STAGE_GAP = 30;
const stageWire = makeWire(N, "think");
const stageReads = toReads(stageWire, STAGE_BYTES);
const NAMES = [
  "① 緩衝區切割（buf/indexOf/slice）",
  "② ＋解析（fastDelta）",
  "③ ＋批次累積（await push/flush）",
  "④ ＋串流寫入（TransformStream）"
];
console.log("");
console.log("表一 · 階段歸因 —— 480 倍藏在哪一段？");
console.log("      （" + N + " 筆、每封包 " + STAGE_BYTES + " bytes、思考型輸出）");
console.log("");
console.log("  階段                                累計CPU      這段增量    佔比");
let prev = 0;
const stageCpu = [];
for (let st = 1; st <= 4; st++) {
  const r = await measure(stageReads, st, STAGE_GAP);
  stageCpu.push(r.cpu);
  const delta = r.cpu - prev;
  prev = r.cpu;
  console.log("  " + NAMES[st - 1].padEnd(34) + f(r.cpu) + "ms" + f(delta) + "ms");
}
const total = stageCpu[3];
console.log("");
for (let st = 1; st <= 4; st++) {
  const delta = stageCpu[st - 1] - (st === 1 ? 0 : stageCpu[st - 2]);
  console.log("    " + NAMES[st - 1].padEnd(34) + f((delta / total) * 100, 6, 1) + "%");
}
const last = await measure(stageReads, 4, STAGE_GAP);
console.log("");
console.log(
  "  實際 flush 次數 " +
    last.info.flushes +
    "、串流寫入 " +
    last.info.writes +
    " 次（" +
    last.info.deltas +
    " 筆增量）→ 平均每 " +
    (last.info.deltas / Math.max(last.info.writes, 1)).toFixed(1) +
    " 筆合併成 1 次寫入"
);
console.log(
  "  退回完整解析 " +
    last.info.slowParses +
    " 次（" +
    ((last.info.slowParses / last.info.deltas) * 100).toFixed(1) +
    "%）"
);

/* ───────────────────── 表二：封包碎裂 ───────────────────── */
// 站長的原始假設是「封包太碎」。這張表要回答的是：往「碎」還是往「大」走才會變糟。
console.log("");
console.log("表二 · 封包碎裂 —— 「封包太碎」的假設對不對？");
console.log("      （" + N + " 筆、完整路徑 stage 4、思考型輸出）");
console.log("");
console.log("  每封包bytes   封包數   ≈每封包筆數      CPU     每筆µs   flush次數");
for (const bpr of [200, 400, 800, 3200, 16000, 65536]) {
  const reads = toReads(stageWire, bpr);
  // 封包越大、上游累積越久才送出 → 間隔按比例放大，維持同樣的 32 tokens/秒
  const gap = Math.max(1, Math.round((bpr / 200) * STAGE_GAP));
  const r = await measure(reads, 4, gap);
  console.log(
    "  " +
      String(bpr).padStart(11) +
      String(reads.length).padStart(9) +
      f(N / reads.length, 14, 1) +
      f(r.cpu, 10) +
      "ms" +
      f((r.cpu * 1000) / N, 9, 1) +
      String(r.info.flushes).padStart(11)
  );
}

/* ───────────────────── 表三：筆數擴展 ───────────────────── */
// 每筆成本若隨 N 上升 → 有 O(n²) 項；若持平 → 只是常數太大。
// 這兩種診斷導向完全不同的修法，所以必須分清楚。
console.log("");
console.log("表三 · 筆數擴展 —— 常數太大，還是有 O(n²)？");
console.log("      （每封包 " + STAGE_BYTES + " bytes、完整路徑 stage 4）");
console.log("");
console.log("  模式        筆數        CPU      每筆µs   相對1000筆");
for (const mode of ["content", "think", "alt"]) {
  let base = 0;
  for (const n of [1000, 2000, 4000, 8000]) {
    const w = makeWire(n, mode);
    const r = await measure(toReads(w, STAGE_BYTES), 4, STAGE_GAP);
    const per = (r.cpu * 1000) / n;
    if (n === 1000) base = per;
    console.log(
      "  " +
        mode.padEnd(10) +
        String(n).padStart(6) +
        f(r.cpu, 11) +
        "ms" +
        f(per, 9, 1) +
        f(per / base, 11, 2) +
        "×"
    );
  }
  console.log("");
}

/* ───────────────────── 對照線上實測 ───────────────────── */
console.log("對照線上（Cloudflare Observability，2026-07-30 16:27 GMT+8）");
console.log("  線上實測      CPU 2020ms / wall 65s → 被 Worker exceeded CPU time limit. 殺掉");
console.log("  本機同規模    CPU " + total.toFixed(2) + "ms（" + N + " 筆、完整路徑）");
console.log("  落差          " + (2020 / total).toFixed(0) + "× —— workerd isolate 比桌機慢，但慢不了這麼多");
console.log("");
console.log("  ⚠ 落差仍在兩個數量級以上＝本機重現不出來，元凶不在這條迴圈裡。");
console.log("    下一步是把同一個迴圈搬進 workerd（vitest-pool-workers）拿真實 runtime 的數字，");
console.log("    以及查「一次請求是不是跑了不只一趟這條迴圈」（重試／續跑／前端重連）。");
console.log("  ✓ 若某一階段在本機就吃掉大半，那一段就是元凶，直接照表一的歸因去修。");
console.log("");
