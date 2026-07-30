// lib/pgstream.ts — 直通的兩道閘門（不讀位元組就判掉的條件、以及嗅探）。
import { describe, it, expect } from "vitest";
import { passthroughBlocked, sniffPassthrough } from "../../src/lib/pgstream.js";
import type { ChannelRow } from "../../src/types.js";

const ch = (kind: string) => ({ kind: kind }) as ChannelRow;
const gate = (over?: Partial<Parameters<typeof passthroughBlocked>[0]>) =>
  passthroughBlocked(
    Object.assign(
      { ch: ch("openai"), contentType: "text/event-stream", enabled: true, dumb: false, demo: false },
      over || {}
    )
  );

// 真實上游形狀（2026-07-31 抄自線上流量）
const REAL =
  'data: {"id":"chatcmpl-x","object":"chat.completion.chunk","created":1785433708,' +
  '"model":"qwen3-5-9b","choices":[{"index":0,"delta":{"role":"assistant","content":""},' +
  '"logprobs":null,"finish_reason":null}],"prompt_token_ids":null}\n\n';

describe("直通的前置閘門", () => {
  it("openai／custom 通過；anthropic／gemini 擋下", () => {
    expect(gate()).toBe("");
    expect(gate({ ch: ch("custom") })).toBe("");
    expect(gate({ ch: ch("anthropic") })).toContain("OpenAI 相容");
    expect(gate({ ch: ch("gemini") })).toContain("OpenAI 相容");
  });

  it("上游不是 SSE（整包 JSON 的備援路徑）→ 擋下", () => {
    expect(gate({ contentType: "application/json" })).toContain("不是 SSE");
  });

  it("站台開關關閉 → 擋下", () => {
    expect(gate({ enabled: false })).toContain("pg_passthrough");
  });

  // 這兩條是安全性而不是效能：原始 chunk 每一筆都帶 "model":"真名"，
  // 而 dumb／demo 的整個重點就是「會員不知道自己在用什麼」。
  it("dumb mode／體驗模式 → 擋下（原始 chunk 會洩漏模型名稱）", () => {
    expect(gate({ dumb: true })).toContain("dumb");
    expect(gate({ demo: true })).toContain("體驗模式");
  });
});

describe("嗅探", () => {
  it("真實上游的第一筆 → ok（prompt_token_ids 要在白名單裡，不然沒有渠道通得過）", () => {
    expect(sniffPassthrough(REAL).verdict).toBe("ok");
  });

  it("只讀到半截訊框 → more（請呼叫端再讀一個 chunk）", () => {
    expect(sniffPassthrough('data: {"id":"chatcmpl-x","obj').verdict).toBe("more");
    expect(sniffPassthrough("").verdict).toBe("more");
    // [DONE] 之後還沒有內容 → 也還不能判
    expect(sniffPassthrough("data: [DONE]\n\n").verdict).toBe("more");
  });

  it("未知頂層欄位 → reject，而且理由要指名是哪個欄位", () => {
    const r = sniffPassthrough('data: {"id":"x","provider":"DeepInfra","choices":[]}\n\n');
    expect(r.verdict).toBe("reject");
    expect(r.why).toContain("provider");
    expect(sniffPassthrough('data: {"id":"x","x_groq":{"id":"req"},"choices":[]}\n\n').verdict).toBe(
      "reject"
    );
  });

  it("串流裡夾 error → reject（錯誤淨化只有轉譯路徑做得到）", () => {
    expect(sniffPassthrough('data: {"error":{"message":"boom"}}\n\n').verdict).toBe("reject");
  });

  it("形狀怪掉（不是 JSON／不是物件／choices 不是陣列）→ reject", () => {
    expect(sniffPassthrough("data: not-json\n\n").verdict).toBe("reject");
    expect(sniffPassthrough("data: [1,2,3]\n\n").verdict).toBe("reject");
    expect(sniffPassthrough('data: {"id":"x","choices":"nope"}\n\n').verdict).toBe("reject");
  });

  it("非 data: 的行（註解、event:）不影響判斷", () => {
    expect(sniffPassthrough(": keep-alive\nevent: message\n" + REAL).verdict).toBe("ok");
  });
});
