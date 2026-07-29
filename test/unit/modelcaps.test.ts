// lib/modelcaps.js 純函式 — 上游模型能力快取的解析與挑選。
//
// 這個模組是為了 2026-07-30 的線上事故而生：會員一次丟 4 張圖，上游回
// {"error":"At most 1 image(s) may be provided in one prompt."}，而站上寫死 4 張。
// 所以測試的重點放在「數字有沒有被正確地往下砍」與「問不到的時候會不會亂猜」。
import { describe, it, expect } from "vitest";
import { parseCaps, capVision, maxImagesFor, seesImagesFor, pickCaps } from "../../src/lib/modelcaps.js";
import { PG_LIMITS } from "../../src/lib/playground.js";

describe("parseCaps（快取欄位解析）", () => {
  it("空的、壞的、非物件一律回空物件（呼叫端不必自己 try）", () => {
    expect(parseCaps(null)).toEqual({});
    expect(parseCaps(undefined)).toEqual({});
    expect(parseCaps({})).toEqual({});
    expect(parseCaps({ model_caps: "" })).toEqual({});
    expect(parseCaps({ model_caps: "{壞掉的 json" })).toEqual({});
    expect(parseCaps({ model_caps: "[1,2]" })).toEqual({}); // 陣列不是我們的形狀
    expect(parseCaps({ model_caps: "null" })).toEqual({});
  });

  it("0 要保留 —— 那代表「上游明說看不了圖」，跟「沒問到」不一樣", () => {
    expect(parseCaps({ model_caps: '{"a":0,"b":10}' })).toEqual({ a: 0, b: 10 });
  });

  it("負數與非數字丟掉", () => {
    expect(parseCaps({ model_caps: '{"a":-1,"b":"x","c":3}' })).toEqual({ c: 3 });
  });
});

describe("capVision（上游有沒有明說吃不吃圖）", () => {
  it("沒這個鍵＝null（不知道），呼叫端才有機會退回 vision_models", () => {
    expect(capVision({ model_caps: '{"a":1}' }, "b")).toBe(null);
    expect(capVision(null, "a")).toBe(null);
  });

  it("0＝false、正數＝true", () => {
    expect(capVision({ model_caps: '{"a":0}' }, "a")).toBe(false);
    expect(capVision({ model_caps: '{"a":1}' }, "a")).toBe(true);
    expect(capVision({ model_caps: '{"a":10}' }, "a")).toBe(true);
  });
});

describe("maxImagesFor（單則最多幾張圖）", () => {
  it("快取裡沒有＝退回站上預設（改動前的行為原封不動）", () => {
    expect(maxImagesFor(null, "a")).toBe(PG_LIMITS.maxImgPerMsg);
    expect(maxImagesFor({ model_caps: '{"b":1}' }, "a")).toBe(PG_LIMITS.maxImgPerMsg);
  });

  it("上游說 1 張就是 1 張 —— 這正是事故當天的那個模型", () => {
    expect(maxImagesFor({ model_caps: '{"gemma-4-uncensored":1}' }, "gemma-4-uncensored")).toBe(1);
  });

  it("上游的數字只能往下砍，不能突破站上的 CPU 預算上限", () => {
    // 上游說 20 張，我們自己的天花板是 4 → 取 4
    expect(maxImagesFor({ model_caps: '{"a":20}' }, "a")).toBe(PG_LIMITS.maxImgPerMsg);
    expect(maxImagesFor({ model_caps: '{"a":3}' }, "a")).toBe(3);
  });

  it("看不了圖（0）不必給張數，退回預設值 —— 擋圖是 seesImagesFor 的事", () => {
    expect(maxImagesFor({ model_caps: '{"a":0}' }, "a")).toBe(PG_LIMITS.maxImgPerMsg);
  });
});

describe("seesImagesFor（吃不吃圖：上游優先、管理員清單後備）", () => {
  it("上游說了就聽上游的，vision_models 完全不看", () => {
    // 上游說可以，管理員沒填 → 可以（管理員不必再維護那份清單）
    expect(seesImagesFor({ model_caps: '{"a":10}', vision_models: "" }, "a")).toBe(true);
    // 上游說不行，管理員填了 → 還是不行（人工清單過期了，聽上游的）
    expect(seesImagesFor({ model_caps: '{"a":0}', vision_models: "a" }, "a")).toBe(false);
  });

  it("上游沒回報能力時退回 vision_models（多數 OpenAI 相容上游都是這種）", () => {
    expect(seesImagesFor({ model_caps: "", vision_models: "a,b" }, "a")).toBe(true);
    expect(seesImagesFor({ model_caps: "", vision_models: "a,b" }, "c")).toBe(false);
  });

  it("兩邊都沒有＝不吃圖（安全預設，寧可擋下來叫人換模型）", () => {
    expect(seesImagesFor(null, "a")).toBe(false);
    expect(seesImagesFor({ model_caps: "", vision_models: "" }, "a")).toBe(false);
  });
});

describe("pickCaps（從上游 /v1/models 的回應挑能力）", () => {
  // Venice 的真實形狀（2026-07-30 實際打 api.venice.ai 撈到的欄位）
  const venice = {
    data: [
      {
        id: "gemma-4-uncensored",
        model_spec: { capabilities: { supportsVision: true, supportsMultipleImages: false } }
      },
      {
        id: "qwen3-vl-235b-a22b",
        model_spec: { capabilities: { supportsVision: true, supportsMultipleImages: true, maxImages: 10 } }
      },
      {
        id: "text-only-model",
        model_spec: { capabilities: { supportsVision: false } }
      },
      {
        id: "not-in-our-channel",
        model_spec: { capabilities: { supportsVision: true, supportsMultipleImages: true, maxImages: 20 } }
      }
    ]
  };

  it("supportsMultipleImages:false → 1 張（事故的那一款）", () => {
    const caps = pickCaps(venice, ["gemma-4-uncensored"]);
    expect(caps).toEqual({ "gemma-4-uncensored": 1 });
  });

  it("多圖模型記上游給的 maxImages 原值（往下砍是 maxImagesFor 的事，不在這裡做）", () => {
    expect(pickCaps(venice, ["qwen3-vl-235b-a22b"])).toEqual({ "qwen3-vl-235b-a22b": 10 });
  });

  it("看不了圖的記成 0 —— 有了它管理員就不必維護 vision_models", () => {
    expect(pickCaps(venice, ["text-only-model"])).toEqual({ "text-only-model": 0 });
  });

  it("只收管道開出來的模型，上游回幾百個也不會全存進 D1", () => {
    const caps = pickCaps(venice, ["gemma-4-uncensored", "qwen3-vl-235b-a22b"]);
    expect(Object.keys(caps || {}).sort()).toEqual(["gemma-4-uncensored", "qwen3-vl-235b-a22b"]);
  });

  it("支援多圖但沒給數字 → 記成站上預設值（不自己瞎猜一個更大的數）", () => {
    const payload = {
      data: [
        { id: "m", model_spec: { capabilities: { supportsVision: true, supportsMultipleImages: true } } }
      ]
    };
    expect(pickCaps(payload, ["m"])).toEqual({ m: PG_LIMITS.maxImgPerMsg });
  });

  it("上游不回報能力＝null，呼叫端據此保留舊快取（不可以覆寫成空的）", () => {
    // 一般 OpenAI 相容服務的 /v1/models 就是這個形狀
    const plain = { data: [{ id: "gpt-4o", object: "model", owned_by: "openai" }] };
    expect(pickCaps(plain, ["gpt-4o"])).toBe(null);
    expect(pickCaps({}, ["a"])).toBe(null);
    expect(pickCaps(null, ["a"])).toBe(null);
    expect(pickCaps({ data: "not-an-array" }, ["a"])).toBe(null);
  });

  it("回報了能力、但沒有我們要的模型 → 空物件（不是 null）", () => {
    // 這個分別很重要：空物件代表「問到了，這幾個模型上游沒提」，快取照樣更新
    expect(pickCaps(venice, ["某個上游沒有的模型"])).toEqual({});
  });
});
