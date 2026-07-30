// test/bench/stream.bench.ts — 同一條串流迴圈，跑在 **workerd** 裡（2026-07-30）。
//
// 用法：npm run bench:workerd
// （刻意用 .bench.ts 而不是 .test.ts —— vitest.config.mjs 只收 test/**/*.test.ts，
//   所以這支不會混進 npm test 拖慢 CI；它是量測工具，不是回歸測試。）
//
// ── 為什麼需要在 workerd 裡再量一次 ──
//
// tools/bench-stream.mjs（Node 桌機）量到 4000 筆增量、完整路徑 = 19.00ms，
// 其中串流寫入佔 57.7%（1003 次 flush，平均每次 11µs）。
// 但線上實測是 **CPU 2020ms**，落差 106 倍。
//
// ⚠️ **以下是假設，不是結論 —— 2026-07-30 尚未證實，別在讀完之後把它當成事實。**
//
// 把線上 9 筆（wall 1.48s→16ms、3.94s→32ms、25.96s→1020ms、65s→2020ms…）
// 除以「wall 秒數 × 10」（＝chat.ts 的 100ms 門檻推估出的 flush 次數），
// 得到 1.08 / 0.81 / 3.93 / 3.11 ms 每次 flush —— 看起來像常數，於是有了
// 「CPU = flush 次數 × 約 3ms」這個假設。
//
// **但同一批數字用「每筆增量 250～500µs」去解釋一樣吻合。** 那 9 筆資料
// **分不出**成本是 per-flush 還是 per-delta，而這兩者導向完全相反的修法：
//   per-flush → 少寫幾次（放寬門檻）
//   per-delta → 放寬門檻完全沒用，要往增量側查
//
// 曾經照 per-flush 假設改了門檻並上線，站長實測打回票（體驗變差、沒有變好），已 revert。
// **要分辨，唯一的方法是拿到「flush 次數不同、增量筆數相同」兩組請求的 dashboard CPU 數字。**
// 在拿到之前，這支 bench 只能回答一個較小的問題：
//   同一段程式在 workerd 裡跑要多少 CPU？（→ 實驗一）
//
// ⚠️ 這裡量到的一定是**下限**：vitest 的 TransformStream 由同進程的 JS reader 抽掉，
// 沒有 HTTP/2 分框、沒有 TLS、沒有 socket。正式環境那條路才是完整的。
import { describe, it, expect } from "vitest";
import { fastDelta } from "../../src/lib/fastsse";

// ⚠️ 2026-07-30：下面「候選」那組門檻**沒有上線**。曾經部署過一版，站長實測後打回票：
// 思考放寬到 1000→4000ms 讓畫面變成一跳一跳，而本來就正常的純文字對話（flush 本來就少）
// 只有變差沒有變好。已 revert，chat.ts 現在仍是「1000 字或 100ms、兩種增量共用」。
// 這組數字留在這裡是為了「少寫幾次能省多少」這個問題本身仍然值得量，
// 但**不要**再把它當成建議值直接套上去 —— 先把「成本到底是 per-flush 還是 per-delta」
// 這件事量清楚（見檔頭），再談要不要動門檻。
const CANDIDATE = {
  d: { chars: 1000, ms: 100, maxMs: 300 },
  r: { chars: 4000, ms: 1000, maxMs: 4000 },
  stepMs: 20000,
  maxSteps: 4
};

const PLAIN = ["的", "說", "，", "。", "程式", "資料", "問題", "可以", "一個", "系統"];
const ESCAPED = ["\\n", '\\"', "🙂"];
function tokenAt(i: number): string {
  return i % 10 === 9 ? ESCAPED[Math.floor(i / 10) % ESCAPED.length] : PLAIN[i % PLAIN.length];
}
function chunkJson(i: number, field: string): string {
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
function makeWire(n: number, think: boolean): Uint8Array {
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    parts.push("data: " + chunkJson(i, think && i < n * 0.6 ? "reasoning_content" : "content") + "\n\n");
  }
  parts.push("data: [DONE]\n\n");
  return new TextEncoder().encode(parts.join(""));
}
function toReads(wire: Uint8Array, bytesPerRead: number): Uint8Array[] {
  const reads: Uint8Array[] = [];
  for (let o = 0; o < wire.length; o += bytesPerRead) {
    reads.push(wire.subarray(o, Math.min(o + bytesPerRead, wire.length)));
  }
  return reads;
}

const pad = (s: string | number, w: number) => String(s).padStart(w);
const f = (n: number, w = 9, p = 3) => n.toFixed(p).padStart(w);

/* ═══════════════════════════════════════════════════════════════════
   前置：workerd 裡的時鐘到底走不走？

   正式環境的 Date.now() 只在 I/O 之後前進（防時序攻擊）—— migration 0010 的
   build_ms 就是踩在這件事上，欄位永遠是 NULL。如果 miniflare 本機也一樣，
   這支 bench 根本量不到任何東西，必須先驗證再往下跑，不能量出一堆 0 還當成
   「這段不花 CPU」（tools/bench-stream.mjs 第一版就被 Windows 的 15.6ms
   顆粒度騙過一次，同一種錯不犯第二次）。
   ═══════════════════════════════════════════════════════════════════ */
function clockAdvances(): { ok: boolean; delta: number; spin: number } {
  const t0 = Date.now();
  let x = 0;
  // 純運算、完全沒有 I/O —— 正式環境的時鐘在這段裡是凍結的
  for (let i = 0; i < 30_000_000; i++) x += i % 7;
  const delta = Date.now() - t0;
  return { ok: delta > 0, delta: delta, spin: x };
}

describe("串流迴圈在 workerd 裡的 CPU 成本", () => {
  it("時鐘可用性（量測前提）", () => {
    const c = clockAdvances();
    console.log("");
    console.log("workerd 時鐘探測：3000 萬次迴圈後 Date.now() 前進了 " + c.delta + "ms");
    if (!c.ok) {
      console.log("  ⚠ 時鐘凍結 —— 這個環境量不到 CPU，下面的數字全部無意義。");
      console.log("    正式環境本來就是這樣（migration 0010 的 build_ms 就是因此永遠 NULL）。");
    } else {
      console.log("  ✓ 時鐘會走，可以量測（miniflare 本機不套用防時序攻擊的凍結）");
    }
    expect(typeof c.delta).toBe("number");
  });

  /* ─────────────────────────────────────────────────────────────
     實驗一：單純「寫 N 次 TransformStream」要多少 CPU
     把 chat.ts 的 send() 原封不動搬過來（含 Promise.race ＋ setTimeout
     ＋ clearTimeout 那組死鎖斷路器），只改成不依賴外部狀態。
     對照組刻意拆成三層，這樣才知道那 3ms 是誰的：
       a) 只有 JSON.stringify ＋ TextEncoder（不寫串流）
       b) ＋ writer.write（真的進 TransformStream）
       c) ＋ send() 的 Promise.race／setTimeout 斷路器  ← 正式環境
     ───────────────────────────────────────────────────────────── */
  it("實驗一 · 每次 flush 的成本拆解", async () => {
    const HANG_MS = 5000; // 對齊 chat.ts 的 BG.hangMs
    const enc = new TextEncoder();
    const PAYLOAD = { d: "一".repeat(400) }; // 400 字≈實際 flush 的量級（門檻 1000 字或 100ms）

    async function run(mode: "encode" | "write" | "full", n: number): Promise<number> {
      let ts: TransformStream | null = null;
      let writer: WritableStreamDefaultWriter | null = null;
      let drained: Promise<void> | null = null;
      if (mode !== "encode") {
        ts = new TransformStream();
        writer = ts.writable.getWriter();
        drained = (async () => {
          const r = ts!.readable.getReader();
          for (;;) {
            const s = await r.read();
            if (s.done) break;
          }
        })();
      }
      const t0 = Date.now();
      for (let i = 0; i < n; i++) {
        const bytes = enc.encode("data: " + JSON.stringify(PAYLOAD) + "\n\n");
        if (mode === "encode") continue;
        if (mode === "write") {
          await writer!.write(bytes);
          continue;
        }
        // mode === "full"：chat.ts 的 send() 完整形狀
        let timer: ReturnType<typeof setTimeout> | null = null;
        const wrote = writer!.write(bytes).catch(() => {});
        const guard = new Promise<void>((res) => {
          timer = setTimeout(res, HANG_MS);
        });
        await Promise.race([wrote, guard]).then(() => {
          if (timer) clearTimeout(timer);
        });
      }
      const ms = Date.now() - t0;
      if (writer) {
        await writer.close();
        await drained;
      }
      return ms;
    }

    const N = 5000;
    for (const m of ["encode", "write", "full"] as const) await run(m, 200); // 暖身
    const enc_ms = await run("encode", N);
    const write_ms = await run("write", N);
    const full_ms = await run("full", N);

    console.log("");
    console.log("實驗一 · 每次 flush 的成本拆解（" + N + " 次，workerd）");
    console.log("");
    console.log("  項目                                  總計        每次µs");
    console.log(
      "  a) JSON.stringify ＋ TextEncoder " + f(enc_ms, 11, 1) + "ms" + f((enc_ms * 1000) / N, 12, 2)
    );
    console.log(
      "  b) ＋ writer.write（TransformStream）" + f(write_ms, 7, 1) + "ms" + f((write_ms * 1000) / N, 12, 2)
    );
    console.log(
      "  c) ＋ send() 的斷路器（正式環境）  " + f(full_ms, 9, 1) + "ms" + f((full_ms * 1000) / N, 12, 2)
    );
    console.log("");
    console.log(
      "  斷路器（Promise.race＋setTimeout）本身：" + f(((full_ms - write_ms) * 1000) / N, 8, 2) + "µs／次"
    );
    console.log("");
    console.log("  對照線上反算值：約 3000µs／次 flush（65 秒串流、650 次 flush、CPU 2020ms）");
    const perUs = (full_ms * 1000) / N;
    console.log(
      "  → workerd 本機是 " +
        perUs.toFixed(2) +
        "µs，離線上還差 " +
        (3000 / Math.max(perUs, 0.01)).toFixed(0) +
        "×"
    );
    console.log("    差額＝真的寫到網路上才有的成本（HTTP/2 分框＋TLS＋socket），");
    console.log("    在 runtime 外面 —— 改資料結構省不掉，只能少寫幾次。");
    expect(full_ms).toBeGreaterThanOrEqual(0);
  });

  /* ─────────────────────────────────────────────────────────────
     實驗二：放寬 flush 門檻能省多少 —— 這是要不要改的依據

     chat.ts 現在是「1000 字**或** 100ms」。100ms 那條讓寫入次數
     ＝串流秒數 × 10，所以 CPU 正比於 wall time。
     這裡掃門檻，看寫入次數與 CPU 怎麼跟著掉。
     ───────────────────────────────────────────────────────────── */
  it("實驗二 · 放寬 flush 門檻的效果", async () => {
    const N = 4000; // 65 秒 × 約 32 tokens/秒
    const READ_BYTES = 200; // 一筆增量一個封包（線上 SSE 常態）
    const READ_GAP = 30; // 32 tokens/秒 → 每個封包約 30ms
    const wire = makeWire(N, true);
    const reads = toReads(wire, READ_BYTES);

    // chat.ts 的迴圈，門檻用 FLUSH 同形狀的設定餵進來；
    // 時鐘用假的（只在 read 時前進，跟正式環境一致）
    type Th = { chars: number; ms: number; maxMs: number };
    type Cfg = { r: Th; d: Th; stepMs: number; maxSteps: number };
    async function loop2(readsArg: Uint8Array[], cfg: Cfg) {
      let clock = 1753142400000;
      const dec = new TextDecoder();
      const enc = new TextEncoder();
      const ts = new TransformStream();
      const writer = ts.writable.getWriter();
      const drained = (async () => {
        const r = ts.readable.getReader();
        for (;;) {
          const s = await r.read();
          if (s.done) break;
        }
      })();
      let full = "",
        pend = "",
        pendKind: "r" | "d" | null = null,
        lastFlush = clock,
        writes = 0;
      async function send(obj: unknown) {
        writes++;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const wrote = writer.write(enc.encode("data: " + JSON.stringify(obj) + "\n\n")).catch(() => {});
        const guard = new Promise<void>((res) => {
          timer = setTimeout(res, 5000);
        });
        await Promise.race([wrote, guard]).then(() => {
          if (timer) clearTimeout(timer);
        });
      }
      async function flush() {
        if (!pend || !pendKind) return;
        const payload = pendKind === "r" ? { r: pend } : { d: pend };
        pend = "";
        lastFlush = clock;
        await send(payload);
      }
      // 跟 chat.ts 的 push() 逐行對齊（分種類門檻 ＋ 時間門檻隨時長退避）
      const t0clock = clock;
      async function push(kind: "r" | "d", text: string) {
        if (pendKind !== kind) {
          await flush();
          pendKind = kind;
        }
        pend += text;
        const th = kind === "r" ? cfg.r : cfg.d;
        if (pend.length >= th.chars) {
          await flush();
          return;
        }
        let steps = ((clock - t0clock) / cfg.stepMs) | 0;
        if (steps > cfg.maxSteps) steps = cfg.maxSteps;
        let wait = th.ms << steps;
        if (wait > th.maxMs) wait = th.maxMs;
        if (clock - lastFlush >= wait) await flush();
      }
      let buf = "";
      for (let ri = 0; ri < readsArg.length; ri++) {
        clock += READ_GAP; // reader.read() 是 I/O → 時鐘只在這裡前進
        buf += dec.decode(readsArg[ri], { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).replace(/\r$/, "");
          buf = buf.slice(idx + 1);
          if (line.indexOf("data:") !== 0) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          const fast = fastDelta(payload);
          if (!fast) continue;
          if (fast.r) await push("r", fast.r);
          if (fast.d) {
            full += fast.d;
            await push("d", fast.d);
          }
        }
      }
      await flush();
      await writer.close();
      await drained;
      return { writes, fullLen: full.length };
    }
    // 上面那張表都跑同一份 reads，包一層省得每次傳
    const loop = (cfg: Cfg) => loop2(reads, cfg);

    // 舊版＝兩種增量共用「1000 字 / 100ms」、不退避（maxSteps 0、maxMs＝ms）
    const flat = (chars: number, ms: number): Cfg => ({
      r: { chars, ms, maxMs: ms },
      d: { chars, ms, maxMs: ms },
      stepMs: 20000,
      maxSteps: 0
    });
    // 候選設定（**未上線**，見檔頭 CANDIDATE 的說明）
    const shipped: Cfg = CANDIDATE;

    await loop(flat(1000, 100)); // 暖身
    console.log("");
    console.log("實驗二 · flush 門檻對寫入次數的影響（" + N + " 筆、65 秒思考型串流、workerd）");
    console.log("");
    console.log("  設定                        寫入次數   本機CPU    ←推估線上CPU(×3ms/次)");
    const rows: { label: string; writes: number; ms: number }[] = [];
    for (const [cfg, label] of [
      [flat(1000, 100), "現行 1000字/100ms 共用"],
      [flat(1000, 500), "（參考）1000字/500ms"],
      [flat(4000, 2000), "（參考）4000字/2000ms"],
      [shipped, "候選（未上線）分種類＋退避"]
    ] as [Cfg, string][]) {
      const t0 = Date.now();
      const r = await loop(cfg);
      const took = Date.now() - t0;
      rows.push({ label, writes: r.writes, ms: took });
      const projected = r.writes * 3; // 線上反算：每次 flush 約 3ms
      console.log(
        "  " +
          label.padEnd(28) +
          pad(r.writes, 6) +
          f(took, 10, 1) +
          "ms" +
          pad((projected / 1000).toFixed(2) + "s", 12) +
          (projected > 10 ? "" : "  ✓在10ms內")
      );
    }
    console.log("");
    console.log(
      "  候選門檻（未上線）：正文 " +
        CANDIDATE.d.chars +
        "字/" +
        CANDIDATE.d.ms +
        "→" +
        CANDIDATE.d.maxMs +
        "ms ｜ 思考 " +
        CANDIDATE.r.chars +
        "字/" +
        CANDIDATE.r.ms +
        "→" +
        CANDIDATE.r.maxMs +
        "ms"
    );
    // ── 純思考的形狀（0 個正文）──
    // 這才是 2026-07-30 真正被殺的那些請求的形狀：33 次寫入 / 4.9 秒、全是 {r}、
    // 一個正文都沒有。上面那張表是 60% 思考 + 40% 正文，會低估修法在最痛形狀上的效果。
    const pureReads = toReads(makeWire(N, false), READ_BYTES); // false＝全 content
    // 借用 content 形狀但把門檻換成 r 的，等效於「全部都是思考增量」
    const asThink = (c: Cfg): Cfg => ({ r: c.r, d: c.r, stepMs: c.stepMs, maxSteps: c.maxSteps });
    const pureOld = await loop2(pureReads, asThink(flat(1000, 100)));
    const pureNew = await loop2(pureReads, asThink(shipped));
    console.log("");
    console.log("  純思考形狀（＝實際出事的形狀，0 個正文）：");
    console.log(
      "    現行 " +
        pureOld.writes +
        " 次 → 推估 " +
        ((pureOld.writes * 3) / 1000).toFixed(2) +
        "s ｜ 候選 " +
        pureNew.writes +
        " 次 → 推估 " +
        ((pureNew.writes * 3) / 1000).toFixed(2) +
        "s（少 " +
        (pureOld.writes / Math.max(pureNew.writes, 1)).toFixed(1) +
        "×）"
    );
    console.log("");
    const old = rows[0];
    const now = rows[rows.length - 1];
    console.log(
      "  候選 vs 現行（混合形狀）：寫入次數 " +
        old.writes +
        " → " +
        now.writes +
        "（少 " +
        (old.writes / Math.max(now.writes, 1)).toFixed(1) +
        "×）→ 推估線上 CPU " +
        ((old.writes * 3) / 1000).toFixed(2) +
        "s → " +
        ((now.writes * 3) / 1000).toFixed(2) +
        "s"
    );
    console.log("");
    console.log("  ⚠ 推估仍遠超免費方案的 10ms —— 這是要誠實面對的結論：");
    console.log("    每次 flush 約 3ms 的話，10ms 只夠 3 次寫入，那不是串流體驗。");
    console.log("    「少寫幾次」最多只能把它拉回「靠 Cloudflare 彈性活著」，那是把正確性押在運氣上，");
    console.log("    不是可接受的目標。要每次都在 10ms 內，這個架構在免費方案上做不到。");
    expect(rows[0].writes).toBeGreaterThan(rows[rows.length - 1].writes);
  });
});
