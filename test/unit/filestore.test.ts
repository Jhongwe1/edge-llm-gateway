// lib/filestore.js 純函式 — 檔頭偵測、base64 長度換算、字元集驗證。
// 這三個是上傳端點的守門員：它們放行的東西會被「原封不動」串進上游請求的 JSON body，
// 所以驗證錯誤不只是收到壞圖，而是整包請求的結構被破壞。
import { describe, it, expect } from "vitest";
import { sniffMime, b64Bytes, isB64, OK_IMAGE_MIME, FILE_DEFAULTS } from "../../src/lib/filestore.js";

// 各格式的真實檔頭（前幾個 byte）→ base64
function headB64(bytes: number[]): string {
  const u = new Uint8Array(24);
  for (let i = 0; i < bytes.length; i++) u[i] = bytes[i];
  let s = "";
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s);
}

describe("sniffMime（檔頭魔術位元組）", () => {
  it("認得四種允許的圖片格式", () => {
    expect(sniffMime(headB64([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffMime(headB64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
    expect(sniffMime(headB64([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe("image/gif");
    // WebP＝RIFF????WEBP（4–7 是長度，8–11 才是 WEBP）
    expect(sniffMime(headB64([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]))).toBe(
      "image/webp"
    );
  });
  it("認不出來的一律回空字串（＝拒收）", () => {
    expect(sniffMime(headB64([0x3c, 0x73, 0x76, 0x67]))).toBe(""); // "<svg" — 絕不能被當成圖片
    expect(sniffMime(headB64([0x50, 0x4b, 0x03, 0x04]))).toBe(""); // ZIP／Office
    expect(sniffMime(headB64([0x4d, 0x5a]))).toBe(""); // Windows 執行檔
    expect(sniffMime("")).toBe("");
    expect(sniffMime("!!!not base64!!!")).toBe("");
  });
  it("RIFF 開頭但不是 WEBP（例如 wav）不放行", () => {
    expect(sniffMime(headB64([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45]))).toBe("");
  });
  it("白名單不含 svg（可執行的 XML，等於讓人上傳 script）", () => {
    expect(OK_IMAGE_MIME["image/svg+xml"]).toBeUndefined();
  });
});

describe("b64Bytes（不解碼就算出真實大小）", () => {
  const cases: [string, number][] = [
    ["", 0],
    ["QQ==", 1], // "A"
    ["QUI=", 2], // "AB"
    ["QUJD", 3], // "ABC"
    ["QUJDRA==", 4] // "ABCD"
  ];
  it.each(cases)("%s → %i bytes", (b64, n) => {
    expect(b64Bytes(b64)).toBe(n);
  });
  it("跟實際解碼的長度一致（隨機資料）", () => {
    for (const len of [1, 2, 3, 100, 999, 4096]) {
      let s = "";
      for (let i = 0; i < len; i++) s += String.fromCharCode((i * 37) & 255);
      const b64 = btoa(s);
      expect(b64Bytes(b64)).toBe(len);
    }
  });
});

describe("isB64（字元集驗證＝字串串接快路徑的安全前提）", () => {
  it("合法 base64 放行", () => {
    expect(isB64("QUJD")).toBe(true);
    expect(isB64("QQ==")).toBe(true);
    expect(isB64("a+/9QQ==")).toBe(true);
  });
  it("含 JSON 特殊字元的一律擋掉", () => {
    // 這幾個若被放行，串進 body 就會破壞 JSON 結構（甚至注入額外欄位）
    expect(isB64('QU"J')).toBe(false);
    expect(isB64("QU\\J")).toBe(false);
    expect(isB64("QU\nJ")).toBe(false);
    expect(isB64("QU J")).toBe(false);
    expect(isB64('","x":"')).toBe(false);
  });
  it("長度不是 4 的倍數＝不完整，擋掉", () => {
    expect(isB64("QUJ")).toBe(false);
    expect(isB64("Q")).toBe(false);
  });
  it("空字串不算合法", () => {
    expect(isB64("")).toBe(false);
  });
});

describe("配額預設值", () => {
  it("單檔上限反推 base64 後不超過 D1 單值 2MB 硬限制", () => {
    // base64 膨脹 4/3；超過 2,000,000 bytes 的話 D1 會直接拒絕寫入
    expect(Math.ceil((FILE_DEFAULTS.pgfile_max_kb * 1024 * 4) / 3)).toBeLessThan(2000000);
  });
  it("全站上限留了餘裕給正職資料（D1 免費庫 500MB）", () => {
    expect(FILE_DEFAULTS.pgfile_total_mb).toBeLessThanOrEqual(300);
  });
});
