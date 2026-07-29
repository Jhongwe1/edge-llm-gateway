// lib/playground.js 純函式 — 請求驗證、三種上游的請求轉換、串流解析 fixtures。
import { describe, it, expect } from "vitest";
import type { ChannelRow } from "../../src/types.js";
import type { ChatMsg } from "../../src/lib/playground.js";
import {
  cleanChat,
  buildUpstream,
  extractDelta,
  extractReasoning,
  extractFull,
  chModels,
  chVisionModels,
  modelSeesImages,
  mergeExtraBody,
  PG_LIMITS,
  PG_DEFAULT_SYSTEM
} from "../../src/lib/playground.js";

describe("cleanChat（聊天請求驗證）", () => {
  const good = () => ({ channel: "Demo", model: "m1", messages: [{ role: "user", content: "hi" }] });

  it("合法請求 → 標準化（channel 轉小寫）", () => {
    const v = cleanChat(good());
    expect(v.err).toBeUndefined();
    expect(v.channel).toBe("demo");
    expect(v.model).toBe("m1");
    expect(v.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(v.convId).toBeNull();
  });
  it("conv_id 正整數才收", () => {
    expect(cleanChat({ ...good(), conv_id: 7 }).convId).toBe(7);
    expect(cleanChat({ ...good(), conv_id: -1 }).convId).toBeNull();
    expect(cleanChat({ ...good(), conv_id: "abc" }).convId).toBeNull();
  });
  it("缺本體／channel／model → err", () => {
    expect(cleanChat(null).err).toBeTruthy();
    expect(cleanChat({ model: "m", messages: [{ role: "user", content: "x" }] }).err).toBeTruthy();
    expect(cleanChat({ channel: "c", messages: [{ role: "user", content: "x" }] }).err).toBeTruthy();
  });
  it("messages 空／非陣列 → err", () => {
    expect(cleanChat({ channel: "c", model: "m", messages: [] }).err).toBeTruthy();
    expect(cleanChat({ channel: "c", model: "m", messages: "x" }).err).toBeTruthy();
  });
  it("超過訊息數上限 → err", () => {
    const msgs = Array.from({ length: PG_LIMITS.maxMsgs + 1 }, () => ({ role: "user", content: "x" }));
    expect(cleanChat({ channel: "c", model: "m", messages: msgs }).err).toBeTruthy();
  });
  it("非法 role → err；system 合法", () => {
    expect(
      cleanChat({ channel: "c", model: "m", messages: [{ role: "tool", content: "x" }] }).err
    ).toBeTruthy();
    const v = cleanChat({
      channel: "c",
      model: "m",
      messages: [
        { role: "system", content: "s" },
        { role: "user", content: "u" }
      ]
    });
    expect(v.err).toBeUndefined();
    expect(v.messages![0].role).toBe("system");
  });
  it("單則超長／整包超長 → err", () => {
    const long = "x".repeat(PG_LIMITS.maxChars + 1);
    expect(
      cleanChat({ channel: "c", model: "m", messages: [{ role: "user", content: long }] }).err
    ).toBeTruthy();
    const chunk = "x".repeat(PG_LIMITS.maxChars);
    const msgs = [];
    for (let total = 0; total <= PG_LIMITS.maxTotal; total += chunk.length) {
      msgs.push({ role: "user", content: chunk });
    }
    expect(cleanChat({ channel: "c", model: "m", messages: msgs }).err).toBeTruthy();
  });
  it("空白訊息會被剔除；最後一則必須是 user", () => {
    const v = cleanChat({
      channel: "c",
      model: "m",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "  " }
      ]
    });
    expect(v.err).toBeUndefined(); // 尾端空白 assistant 被剔除後，最後一則是 user
    expect(v.messages!.length).toBe(1);
    expect(
      cleanChat({
        channel: "c",
        model: "m",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "yo" }
        ]
      }).err
    ).toBeTruthy();
  });
});

describe("buildUpstream（三種上游的請求轉換）", () => {
  const msgs: ChatMsg[] = [
    { role: "system", content: "你是助理" },
    { role: "user", content: "嗨" },
    { role: "assistant", content: "你好" },
    { role: "user", content: "再一句" }
  ];

  it("anthropic：/v1/messages、x-api-key、system 抽出、max_tokens 必填", () => {
    const ch = { kind: "anthropic", base_url: "https://api.anthropic.com", api_key: "sk-ant" } as ChannelRow;
    const up = buildUpstream(ch, "claude-x", msgs);
    expect(up.url).toBe("https://api.anthropic.com/v1/messages");
    expect(up.headers["x-api-key"]).toBe("sk-ant");
    expect(up.headers["anthropic-version"]).toBeTruthy();
    const b = JSON.parse(up.body);
    expect(b.model).toBe("claude-x");
    expect(b.stream).toBe(true);
    expect(b.max_tokens).toBe(PG_LIMITS.maxTokens);
    // 這個 ch 沒填 system_prompt → 套預設，對話自己的 system 接在後面
    expect(b.system).toBe(PG_DEFAULT_SYSTEM + "\n\n你是助理");
    expect(b.messages.every((m: any) => m.role !== "system")).toBe(true);
    expect(b.messages.length).toBe(3);
  });

  it("gemini：streamGenerateContent?alt=sse、x-goog-api-key、assistant→model、systemInstruction", () => {
    const ch = {
      kind: "gemini",
      base_url: "https://generativelanguage.googleapis.com",
      api_key: "sk-goog"
    } as ChannelRow;
    const up = buildUpstream(ch, "gemini-x", msgs);
    expect(up.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-x:streamGenerateContent?alt=sse"
    );
    expect(up.headers["x-goog-api-key"]).toBe("sk-goog");
    expect(up.headers.authorization).toBeUndefined(); // 多送 Authorization 會 401（實測踩過）
    const b = JSON.parse(up.body);
    expect(b.systemInstruction.parts[0].text).toBe(PG_DEFAULT_SYSTEM + "\n\n你是助理");
    expect(b.contents.map((c: any) => c.role)).toEqual(["user", "model", "user"]);
  });

  it("openai/custom：/v1/chat/completions、Bearer、system 留在 messages", () => {
    const ch = { kind: "openai", base_url: "https://api.openai.com", api_key: "sk-oai" } as ChannelRow;
    const up = buildUpstream(ch, "gpt-x", msgs);
    expect(up.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(up.headers.authorization).toBe("Bearer sk-oai");
    const b = JSON.parse(up.body);
    expect(b.stream).toBe(true);
    expect(b.messages.length).toBe(5); // 預設提示詞 1 則 + 原本 4 則
    expect(b.messages[0]).toEqual({ role: "system", content: PG_DEFAULT_SYSTEM });
    expect(b.messages[1].role).toBe("system"); // 對話自己的 system 原位保留
  });
});

describe("buildUpstream — 管道系統提示詞（只作用在 playground）", () => {
  const plain: ChatMsg[] = [{ role: "user", content: "嗨" }];
  const withSys: ChatMsg[] = [
    { role: "system", content: "對話自己的" },
    { role: "user", content: "嗨" }
  ];
  const chan = (kind: string, sp: unknown) =>
    ({ kind, base_url: "https://up.example.com", api_key: "k", system_prompt: sp }) as unknown as ChannelRow;

  it("anthropic：注入 system 欄位", () => {
    const b = JSON.parse(buildUpstream(chan("anthropic", "管道的"), "claude-x", plain).body);
    expect(b.system).toBe("管道的");
  });

  it("gemini：注入 systemInstruction", () => {
    const b = JSON.parse(buildUpstream(chan("gemini", "管道的"), "gemini-x", plain).body);
    expect(b.systemInstruction.parts[0].text).toBe("管道的");
  });

  it("openai／custom：塞成 messages 最前面一則 system", () => {
    for (const kind of ["openai", "custom"]) {
      const b = JSON.parse(buildUpstream(chan(kind, "管道的"), "gpt-x", plain).body);
      expect(b.messages).toEqual([
        { role: "system", content: "管道的" },
        { role: "user", content: "嗨" }
      ]);
    }
  });

  it("對話本來就有 system 時：管道的擺前面，兩者都留著（不互相覆蓋）", () => {
    const a = JSON.parse(buildUpstream(chan("anthropic", "管道的"), "claude-x", withSys).body);
    expect(a.system).toBe("管道的\n\n對話自己的");
    const o = JSON.parse(buildUpstream(chan("openai", "管道的"), "gpt-x", withSys).body);
    expect(o.messages.map((m: any) => m.content)).toEqual(["管道的", "對話自己的", "嗨"]);
  });

  it("空字串／只有空白／未設＝套用預設 PG_DEFAULT_SYSTEM", () => {
    for (const sp of ["", "   ", undefined, null]) {
      const o = JSON.parse(buildUpstream(chan("openai", sp), "gpt-x", plain).body);
      expect(o.messages).toEqual([
        { role: "system", content: PG_DEFAULT_SYSTEM },
        { role: "user", content: "嗨" }
      ]);
      const a = JSON.parse(buildUpstream(chan("anthropic", sp), "claude-x", plain).body);
      expect(a.system).toBe(PG_DEFAULT_SYSTEM);
      const g = JSON.parse(buildUpstream(chan("gemini", sp), "gemini-x", plain).body);
      expect(g.systemInstruction.parts[0].text).toBe(PG_DEFAULT_SYSTEM);
    }
  });

  it("填了自己的＝整段取代預設，不是接在預設後面", () => {
    const a = JSON.parse(buildUpstream(chan("anthropic", "只有我"), "claude-x", plain).body);
    expect(a.system).toBe("只有我");
    expect(a.system).not.toContain("uaip.cc.cd");
  });

  it("預設值本身：提到站名、是非空的單一真相來源", () => {
    expect(PG_DEFAULT_SYSTEM).toContain("uaip.cc.cd");
    expect(PG_DEFAULT_SYSTEM.trim()).toBe(PG_DEFAULT_SYSTEM); // 前後不留空白，否則 UI 灰字會歪
  });

  it("提示詞前後空白會被修掉", () => {
    const b = JSON.parse(buildUpstream(chan("anthropic", "  管道的  "), "claude-x", plain).body);
    expect(b.system).toBe("管道的");
  });

  // 站台預設（settings.pg_default_system，/settings 可改）＝第五個參數。
  // 優先序：管道自己填的 → 站台預設 → 程式內建 PG_DEFAULT_SYSTEM。
  describe("站台預設系統提示詞（第 5 參數 defaultSys）", () => {
    it("管道沒填＝套站台預設，不是內建那段", () => {
      for (const kind of ["openai", "custom"]) {
        const o = JSON.parse(buildUpstream(chan(kind, ""), "gpt-x", plain, undefined, "站台的").body);
        expect(o.messages[0]).toEqual({ role: "system", content: "站台的" });
      }
      const a = JSON.parse(
        buildUpstream(chan("anthropic", null), "claude-x", plain, undefined, "站台的").body
      );
      expect(a.system).toBe("站台的");
      const g = JSON.parse(
        buildUpstream(chan("gemini", undefined), "gemini-x", plain, undefined, "站台的").body
      );
      expect(g.systemInstruction.parts[0].text).toBe("站台的");
    });

    it("管道自己填了＝管道優先，站台預設完全不出現", () => {
      const a = JSON.parse(
        buildUpstream(chan("anthropic", "管道的"), "claude-x", plain, undefined, "站台的").body
      );
      expect(a.system).toBe("管道的");
      expect(a.system).not.toContain("站台的");
    });

    it("站台預設空／空白／沒帶＝退回程式內建 PG_DEFAULT_SYSTEM", () => {
      for (const d of ["", "   ", undefined, null as unknown as undefined]) {
        const a = JSON.parse(buildUpstream(chan("anthropic", ""), "claude-x", plain, undefined, d).body);
        expect(a.system).toBe(PG_DEFAULT_SYSTEM);
      }
    });

    it("站台預設前後空白會被修掉", () => {
      const a = JSON.parse(
        buildUpstream(chan("anthropic", ""), "claude-x", plain, undefined, "  站台的  ").body
      );
      expect(a.system).toBe("站台的");
    });

    it("對話自己的 system 照樣接在站台預設後面（兩者都留著）", () => {
      const a = JSON.parse(
        buildUpstream(chan("anthropic", ""), "claude-x", withSys, undefined, "站台的").body
      );
      expect(a.system).toBe("站台的\n\n對話自己的");
    });
  });
});

describe("mergeExtraBody — 管道額外請求參數（只作用在 playground）", () => {
  const VP = '{"venice_parameters":{"include_venice_system_prompt":false}}';

  it("把 JSON 物件的鍵合併進請求本體", () => {
    const b = mergeExtraBody({ model: "m" }, VP);
    expect(b.venice_parameters).toEqual({ include_venice_system_prompt: false });
    expect(b.model).toBe("m");
  });

  it("非關鍵欄位可以被覆寫（max_tokens、temperature…）", () => {
    const b = mergeExtraBody({ max_tokens: 100 }, '{"max_tokens":9,"temperature":0.2}');
    expect(b.max_tokens).toBe(9);
    expect(b.temperature).toBe(0.2);
  });

  it("model／stream／messages／contents 擋著不給覆寫", () => {
    const b = mergeExtraBody(
      { model: "白名單內", stream: true, messages: ["原本"], contents: ["原本"] },
      '{"model":"沒開放的","stream":false,"messages":[],"contents":[],"top_p":1}'
    );
    expect(b.model).toBe("白名單內"); // 能覆寫＝繞過渠道模型白名單
    expect(b.stream).toBe(true); // 改掉會打斷 SSE 串流管線
    expect(b.messages).toEqual(["原本"]);
    expect(b.contents).toEqual(["原本"]);
    expect(b.top_p).toBe(1); // 沒被擋的照樣進得來
  });

  it("空值／壞 JSON／陣列／純量＝原封不動，不讓聊天掛掉", () => {
    for (const bad of ["", "   ", null, undefined, "{壞的", "[1,2]", '"字串"', "123", "null"]) {
      expect(mergeExtraBody({ model: "m" }, bad)).toEqual({ model: "m" });
    }
  });

  it("四種 kind 都吃得到（buildUpstream 端對端）", () => {
    const mk = (kind: string) =>
      ({ kind, base_url: "https://up.example.com", api_key: "k", extra_body: VP }) as unknown as ChannelRow;
    const msgs: ChatMsg[] = [{ role: "user", content: "嗨" }];
    for (const kind of ["openai", "custom", "anthropic", "gemini"]) {
      const b = JSON.parse(buildUpstream(mk(kind), "m", msgs).body);
      expect(b.venice_parameters).toEqual({ include_venice_system_prompt: false });
    }
  });
});

describe("extractDelta（SSE 一筆 JSON → 增量文字）", () => {
  it("anthropic：content_block_delta 取字、error 事件丟例外", () => {
    expect(extractDelta("anthropic", { type: "content_block_delta", delta: { text: "喵" } })).toBe("喵");
    expect(extractDelta("anthropic", { type: "message_start" })).toBe("");
    expect(() => extractDelta("anthropic", { type: "error", error: { message: "overloaded" } })).toThrow(
      "overloaded"
    );
  });
  it("gemini：candidates parts 併字、error 丟例外", () => {
    expect(
      extractDelta("gemini", { candidates: [{ content: { parts: [{ text: "a" }, { text: "b" }] } }] })
    ).toBe("ab");
    expect(extractDelta("gemini", { candidates: [] })).toBe("");
    expect(() => extractDelta("gemini", { error: { message: "quota" } })).toThrow("quota");
  });
  it("openai：choices[0].delta.content、error 丟例外", () => {
    expect(extractDelta("openai", { choices: [{ delta: { content: "哈" } }] })).toBe("哈");
    expect(extractDelta("openai", { choices: [{ delta: {} }] })).toBe("");
    expect(() => extractDelta("openai", { error: { message: "bad" } })).toThrow("bad");
  });
  it("推理模型的思考欄位不算正文（否則思考會混進回覆裡）", () => {
    expect(extractDelta("openai", { choices: [{ delta: { reasoning_content: "想…" } }] })).toBe("");
    expect(extractDelta("openai", { choices: [{ delta: { reasoning: "想…" } }] })).toBe("");
    expect(extractDelta("anthropic", { type: "content_block_delta", delta: { thinking: "想…" } })).toBe("");
    expect(
      extractDelta("gemini", { candidates: [{ content: { parts: [{ text: "想…", thought: true }] } }] })
    ).toBe("");
  });
  it("gemini：同一筆裡思考與正文並存 → 只取正文", () => {
    expect(
      extractDelta("gemini", {
        candidates: [{ content: { parts: [{ text: "想…", thought: true }, { text: "答" }] } }]
      })
    ).toBe("答");
  });
});

// 2026-07-21 的回歸：以前只讀正文欄位，推理模型的思考整段被丟掉 —
// 瀏覽器收不到任何東西，畫面空白幾十秒像當機（實測 GLM-4.7 有 92% 的輸出是思考）。
describe("extractReasoning（SSE 一筆 JSON → 思考增量）", () => {
  it("openai 相容：reasoning_content（GLM／DeepSeek）與 reasoning（OpenRouter）都認", () => {
    expect(extractReasoning("openai", { choices: [{ delta: { reasoning_content: "先看整數位" } }] })).toBe(
      "先看整數位"
    );
    expect(extractReasoning("openai", { choices: [{ delta: { reasoning: "嗯" } }] })).toBe("嗯");
  });
  it("正文欄位不算思考（兩邊不重複計）", () => {
    expect(extractReasoning("openai", { choices: [{ delta: { content: "答案" } }] })).toBe("");
  });
  it("anthropic：thinking_delta", () => {
    expect(extractReasoning("anthropic", { type: "content_block_delta", delta: { thinking: "嗯…" } })).toBe(
      "嗯…"
    );
    expect(extractReasoning("anthropic", { type: "content_block_delta", delta: { text: "答" } })).toBe("");
  });
  it("gemini：只取標了 thought 的 part", () => {
    expect(
      extractReasoning("gemini", {
        candidates: [{ content: { parts: [{ text: "想…", thought: true }, { text: "答" }] } }]
      })
    ).toBe("想…");
  });
  it("非推理模型／格式意外 → 一律空字串，不丟例外", () => {
    expect(extractReasoning("openai", {})).toBe("");
    expect(extractReasoning("openai", { choices: [] })).toBe("");
    expect(extractReasoning("gemini", { candidates: [] })).toBe("");
    expect(extractReasoning("openai", { error: { message: "bad" } })).toBe("");
  });
});

describe("extractFull（非串流整包 JSON → 全文）", () => {
  it("anthropic / gemini / openai", () => {
    expect(extractFull("anthropic", { content: [{ text: "a" }, { text: "b" }] })).toBe("ab");
    expect(extractFull("gemini", { candidates: [{ content: { parts: [{ text: "c" }] } }] })).toBe("c");
    expect(extractFull("openai", { choices: [{ message: { content: "d" } }] })).toBe("d");
    expect(extractFull("openai", {})).toBe("");
  });
});

describe("chModels", () => {
  it("逗號分隔 → 修剪空白、去空值", () => {
    expect(chModels({ models: " a , b ,,c " })).toEqual(["a", "b", "c"]);
    expect(chModels({ models: "" })).toEqual([]);
    expect(chModels(null)).toEqual([]);
  });
});

/* ===================== 附件（v2.3） ===================== */

describe("cleanChat — files 欄位與控制字元", () => {
  const base = (m: any) => ({ channel: "c", model: "m", messages: [m] });

  it("files 收成 fileIds（正整數、去掉垃圾、上限 maxImgPerMsg）", () => {
    const v = cleanChat(base({ role: "user", content: "看圖", files: [3, "7", 0, -2, "x", 9] }));
    expect(v.err).toBeUndefined();
    expect(v.messages![0].fileIds).toEqual([3, 7, 9]);
  });
  // 2026-07-29 站長打回票：舊行為是對每一則都靜默截斷，會員傳 8 張只送出 4 張、
  // 畫面一聲不吭。現在「正在送的那一則」超量就報錯，只有歷史訊息還會截斷。
  it("正在送的那一則超過上限 → 報錯，不截斷（不能在使用者不知情下少送）", () => {
    const many = Array.from({ length: PG_LIMITS.maxImgPerMsg + 3 }, (_, i) => i + 1);
    const v = cleanChat(base({ role: "user", content: "x", files: many }));
    expect(v.err).toContain("最多 " + PG_LIMITS.maxImgPerMsg + " 張");
    expect(v.err).toContain("你選了 " + many.length + " 張"); // 講得出他到底選了幾張
  });

  it("歷史訊息超量仍然截斷（既成事實，不能讓舊對話再也接不下去）", () => {
    const many = Array.from({ length: PG_LIMITS.maxImgPerMsg + 3 }, (_, i) => i + 1);
    const v = cleanChat({
      channel: "c",
      model: "m",
      messages: [
        { role: "user", content: "舊訊息", files: many },
        { role: "assistant", content: "好" },
        { role: "user", content: "新問題" }
      ]
    });
    expect(v.err).toBeUndefined();
    expect(v.messages![0].fileIds!.length).toBe(PG_LIMITS.maxImgPerMsg);
  });
  it("只有圖片、沒有文字的訊息是合法的", () => {
    const v = cleanChat(base({ role: "user", content: "", files: [5] }));
    expect(v.err).toBeUndefined();
    expect(v.messages!.length).toBe(1);
    expect(v.messages![0].content).toBe("");
    expect(v.messages![0].fileIds).toEqual([5]);
  });
  it("沒文字也沒檔案的訊息照舊被略過", () => {
    const v = cleanChat({ channel: "c", model: "m", messages: [{ role: "user", content: "  " }] });
    expect(v.err).toBe("messages 不能是空的");
  });
  // 這條是 fillImages 快路徑的安全前提：使用者若能把 U+0001 送進 content，
  // 就有可能偽造圖片佔位符、讓自己的文字被替換成別的圖（或破壞 JSON）。
  it("控制字元被剝掉（含當佔位符用的 U+0001），但保留 \n \r \t", () => {
    const v = cleanChat(base({ role: "user", content: "a\u0001IMG0\u0001b\u0000c\u001fd\ne\tf" }));
    expect(v.messages![0].content).toBe("aIMG0bcd\ne\tf");
    expect(v.messages![0].content.indexOf("\u0001")).toBe(-1);
  });
});

describe("buildUpstream — 圖片（三家格式）", () => {
  const IMG = { mime: "image/webp", b64: "UklGRhIAAABXRUJQ" };
  const withImg = (): ChatMsg[] => [{ role: "user", content: "這是什麼？", images: [{ ...IMG }] }];

  it("openai：content 變成 [text, image_url]，值是 data URL", () => {
    const ch = { kind: "openai", base_url: "https://x", api_key: "k" } as ChannelRow;
    const b = JSON.parse(buildUpstream(ch, "gpt-x", withImg()).body);
    const last = b.messages[b.messages.length - 1];
    expect(Array.isArray(last.content)).toBe(true);
    expect(last.content[0]).toEqual({ type: "text", text: "這是什麼？" });
    expect(last.content[1].image_url.url).toBe("data:image/webp;base64," + IMG.b64);
  });

  it("anthropic：image block 排在文字前面，data 是純 base64", () => {
    const ch = { kind: "anthropic", base_url: "https://x", api_key: "k" } as ChannelRow;
    const b = JSON.parse(buildUpstream(ch, "claude-x", withImg()).body);
    const last = b.messages[b.messages.length - 1];
    expect(last.content[0].type).toBe("image");
    expect(last.content[0].source).toEqual({
      type: "base64",
      media_type: "image/webp",
      data: IMG.b64
    });
    expect(last.content[1]).toEqual({ type: "text", text: "這是什麼？" });
  });

  it("gemini：inlineData + mimeType；parts 永遠不會是空的", () => {
    const ch = { kind: "gemini", base_url: "https://x", api_key: "k" } as ChannelRow;
    const b = JSON.parse(buildUpstream(ch, "g-x", withImg()).body);
    expect(b.contents[0].parts[0].inlineData).toEqual({ mimeType: "image/webp", data: IMG.b64 });
    expect(b.contents[0].parts[1]).toEqual({ text: "這是什麼？" });
    // 只有圖、沒有文字 → 就只有 inlineData 一個 part（合法，不必補空的 text）
    const only = JSON.parse(
      buildUpstream(ch, "g-x", [{ role: "user", content: "", images: [{ ...IMG }] }]).body
    );
    expect(only.contents[0].parts.length).toBe(1);
    expect(only.contents[0].parts[0].inlineData).toBeTruthy();
    // 沒圖也沒文字 → 補一個空 text，避免送出 parts:[]（Gemini 會回 400）
    const none = JSON.parse(buildUpstream(ch, "g-x", [{ role: "user", content: "" }]).body);
    expect(none.contents[0].parts).toEqual([{ text: "" }]);
  });

  it("沒有附件時，body 與改版前一模一樣（content 保持字串）", () => {
    const ch = { kind: "openai", base_url: "https://x", api_key: "k" } as ChannelRow;
    const b = JSON.parse(buildUpstream(ch, "gpt-x", [{ role: "user", content: "純文字" }]).body);
    expect(typeof b.messages[b.messages.length - 1].content).toBe("string");
  });

  it("多張圖跨多則訊息：每張都對應到自己那一張，不會錯位", () => {
    const ch = { kind: "openai", base_url: "https://x", api_key: "k" } as ChannelRow;
    const msgs: ChatMsg[] = [
      { role: "user", content: "第一", images: [{ mime: "image/png", b64: "AAAA" }] },
      { role: "assistant", content: "嗯" },
      {
        role: "user",
        content: "第二",
        images: [
          { mime: "image/jpeg", b64: "BBBB" },
          { mime: "image/gif", b64: "CCCC" }
        ]
      }
    ];
    const b = JSON.parse(buildUpstream(ch, "gpt-x", msgs).body);
    const m1 = b.messages[b.messages.length - 3];
    const m3 = b.messages[b.messages.length - 1];
    expect(m1.content[1].image_url.url).toBe("data:image/png;base64,AAAA");
    expect(m3.content[1].image_url.url).toBe("data:image/jpeg;base64,BBBB");
    expect(m3.content[2].image_url.url).toBe("data:image/gif;base64,CCCC");
  });

  // 這是整個附件功能裡最該被釘住的一條：為了避開 JSON.stringify 掃過 base64 的 CPU 成本
  // （1 張圖 2.66ms、3 張 9.66ms，而免費方案上限是 10ms），body 是用「佔位符 ＋ split/join」
  // 組出來的。這個手法只有在「輸出與直接 stringify 逐位元組相同」的前提下才站得住。
  it("佔位符組法的輸出＝直接 stringify 的輸出（逐位元組相同）", () => {
    const tricky = '有 "引號"、\\反斜線\\、換行\n、tab\t、中文與 emoji 🎨、還有 </script>';
    const b64a = "AAAABBBBCCCC";
    const b64b = "DDDDEEEEFFFF";
    const mk = (): ChatMsg[] => [
      {
        role: "user",
        content: tricky,
        images: [
          { mime: "image/webp", b64: b64a },
          { mime: "image/png", b64: b64b }
        ]
      }
    ];

    // openai：手工組出「當初若直接 stringify 會長怎樣」，跟實際輸出比對
    const oa = { kind: "openai", base_url: "https://x", api_key: "k" } as ChannelRow;
    const wantOa = JSON.stringify({
      model: "m",
      stream: true,
      messages: [
        { role: "system", content: PG_DEFAULT_SYSTEM },
        {
          role: "user",
          content: [
            { type: "text", text: tricky },
            { type: "image_url", image_url: { url: "data:image/webp;base64," + b64a } },
            { type: "image_url", image_url: { url: "data:image/png;base64," + b64b } }
          ]
        }
      ],
      stream_options: { include_usage: true }
    });
    expect(buildUpstream(oa, "m", mk()).body).toBe(wantOa);

    // anthropic：圖片排在文字前面
    const an = { kind: "anthropic", base_url: "https://x", api_key: "k" } as ChannelRow;
    const wantAn = JSON.stringify({
      model: "m",
      max_tokens: PG_LIMITS.maxTokens,
      stream: true,
      system: PG_DEFAULT_SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/webp", data: b64a } },
            { type: "image", source: { type: "base64", media_type: "image/png", data: b64b } },
            { type: "text", text: tricky }
          ]
        }
      ]
    });
    expect(buildUpstream(an, "m", mk()).body).toBe(wantAn);

    // gemini
    const ge = { kind: "gemini", base_url: "https://x", api_key: "k" } as ChannelRow;
    const wantGe = JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: "image/webp", data: b64a } },
            { inlineData: { mimeType: "image/png", data: b64b } },
            { text: tricky }
          ]
        }
      ],
      systemInstruction: { parts: [{ text: PG_DEFAULT_SYSTEM }] }
    });
    expect(buildUpstream(ge, "m", mk()).body).toBe(wantGe);

    // 佔位符一個都不能留（漏替換＝上游收到 \u0001IMG0 這種東西，而且錯得無聲無息）
    for (const ch of [oa, an, ge]) {
      expect(buildUpstream(ch, "m", mk()).body.indexOf("\u0001")).toBe(-1);
    }
  });
});

describe("chVisionModels / modelSeesImages", () => {
  it("逗號分隔 → 陣列", () => {
    expect(chVisionModels({ vision_models: " a , b ,,c " })).toEqual(["a", "b", "c"]);
    expect(chVisionModels({ vision_models: "" })).toEqual([]);
    expect(chVisionModels(null)).toEqual([]);
  });
  it("沒設定＝一律不支援（安全預設）", () => {
    expect(modelSeesImages(null, "gpt-4o")).toBe(false);
    expect(modelSeesImages({ vision_models: "" }, "gpt-4o")).toBe(false);
  });
  it("有列進去才算支援，且是精確比對", () => {
    const ch = { vision_models: "gpt-4o,claude-3" };
    expect(modelSeesImages(ch, "gpt-4o")).toBe(true);
    expect(modelSeesImages(ch, "gpt-4")).toBe(false); // 前綴相同也不算
    expect(modelSeesImages(ch, "GPT-4O")).toBe(false); // 大小寫敏感（模型名本來就是）
  });
});
