// E2E（v2.0.0 Phase M）：真瀏覽器＋真 worker（wrangler dev）＋mock 上游，串行跑。
// 流程對照計畫：管理員發文→/news 可見；會員 pending→批准→playground 串流；
// 匿名 /vpn 隱形；demo 打滿→429；外加 /api-docs 公開＋Scalar 能起來（Phase L 驗證）。
import { test, expect, type Page, type APIRequestContext } from "@playwright/test";

const ORIGIN = "http://localhost:8787";

// localhost 限定的 dev 登入表單（沒設 GOOGLE_CLIENT_ID 時 /auth/login 就是它）
async function devLogin(page: Page, email: string): Promise<void> {
  await page.goto("/auth/login");
  await page.fill('input[name="email"]', email);
  await page.click('button[type="submit"]');
  // 等轉址真的離開 /auth（匹配太寬會連登入頁自己都算，下一個 goto 會撞上進行中的導航）
  await page.waitForURL((u) => !u.pathname.startsWith("/auth"), { timeout: 15_000 });
}

// 帶登入 cookie 的 API 呼叫（寫入類要帶 Origin 過 CSRF 檢查）
function api(request: APIRequestContext, method: "get" | "post" | "put", path: string, data?: unknown) {
  return request[method](ORIGIN + path, {
    data: data as Record<string, unknown> | undefined,
    headers: { origin: ORIGIN }
  });
}

test("管理員發文 → /news 列表與內頁可見", async ({ page }) => {
  await devLogin(page, "admin@example.com");
  const title = "E2E 測試新聞 " + Date.now();
  const r = await api(page.request, "post", "/api/admin/articles", {
    category: "news",
    title: title,
    summary: "E2E 摘要",
    body_md: "E2E 內文段落 — **粗體**測試。",
    status: "published"
  });
  expect(r.ok()).toBeTruthy();

  await page.goto("/news");
  await expect(page.getByText(title)).toBeVisible();
  await page.getByText(title).first().click();
  await expect(page.getByText("E2E 內文段落")).toBeVisible();
});

test("會員 pending → 管理員批准 → playground 串流回覆", async ({ browser }) => {
  // 會員登入（新帳號＝pending）→ playground 是等待批准畫面
  const memberCtx = await browser.newContext();
  const member = await memberCtx.newPage();
  await devLogin(member, "e2e-member@example.com");
  await member.goto("/playground");
  // v2.2 起前端預設英文（伺服器端訊息仍是中文）
  await expect(member.getByText("Waiting for approval")).toBeVisible();

  // 管理員批准（approve＝全服務）
  const adminCtx = await browser.newContext();
  const admin = await adminCtx.newPage();
  await devLogin(admin, "admin@example.com");
  const users: any = await (await api(admin.request, "get", "/api/admin/users")).json();
  const row = (users.rows || []).find((u: any) => u.email === "e2e-member@example.com");
  expect(row).toBeTruthy();
  const ok = await api(admin.request, "put", "/api/admin/users/" + row.id, { action: "approve" });
  expect(ok.ok()).toBeTruthy();

  // 會員重進 → 完整聊天介面 → 送訊息 → mock 上游的串流回覆出現
  await member.goto("/playground");
  await expect(member.locator(".pg-ta")).toBeEnabled();
  await member.locator(".pg-ta").fill("哈囉");
  await member.locator(".pg-send").click();
  await expect(member.getByText("您好，這是 mock 回覆。")).toBeVisible({ timeout: 15_000 });

  // v2.5 直通（ADR-0014）：畫面上看得到**不代表存下來了** —— 直通模式下伺服器看不到內容，
  // 回覆是由瀏覽器串完之後回報的（POST /api/playground/chat/save）。那條路斷掉的話，
  // 症狀是「當下聊得很正常，重新整理就整段不見」，而上面那句斷言完全抓不到。
  await expect
    .poll(
      async () => {
        const list: any = await (await api(member.request, "get", "/api/playground/conversations")).json();
        const conv = (list.rows || [])[0];
        if (!conv) return "";
        const detail: any = await (
          await api(member.request, "get", "/api/playground/conversations/" + conv.id)
        ).json();
        return (detail.messages || [])
          .filter((m: any) => m.role === "assistant")
          .map((m: any) => m.content)
          .join("");
      },
      { timeout: 15_000 }
    )
    .toContain("mock 回覆");

  await memberCtx.close();
  await adminCtx.close();
});

test("匿名 /vpn 隱形：回 SPA 殼，看不出頁面存在", async ({ page }) => {
  await page.goto("/vpn");
  await expect(page).toHaveTitle(/IP · UA/); // SPA 殼的標題，不是 VPN 頁
  await expect(page.locator("body")).not.toContainText("訂閱");
});

test("demo 體驗模式：匿名可聊、打滿 IP 日額 → 429 提示", async ({ browser }) => {
  // 管理員開 demo（鎖 mock 渠道、IP 日額 1 — 第二句就會被擋）
  const adminCtx = await browser.newContext();
  const admin = await adminCtx.newPage();
  await devLogin(admin, "admin@example.com");
  const r = await api(admin.request, "put", "/api/admin/settings", {
    demo_mode: true,
    demo_channel: "mock",
    demo_per_ip_day: 1
  });
  expect(r.ok()).toBeTruthy();

  // 全新匿名 context：/playground 直接是體驗模式聊天
  const anonCtx = await browser.newContext();
  const anon = await anonCtx.newPage();
  await anon.goto("/playground");
  await expect(anon.locator(".pg-demo")).toContainText("Demo mode"); // 橫幅（v2.2 前端預設英文）
  await expect(anon.getByText("Sign in for full access")).toBeVisible();

  await anon.locator(".pg-ta").fill("第一句");
  await anon.locator(".pg-send").click();
  await expect(anon.getByText("您好，這是 mock 回覆。")).toBeVisible({ timeout: 15_000 });

  await anon.locator(".pg-ta").fill("第二句");
  await anon.locator(".pg-send").click();
  await expect(anon.locator(".m-err")).toContainText("體驗額度", { timeout: 15_000 }); // 429 demo-rate-limited

  // 收尾：關 demo，不影響其他測試
  await api(admin.request, "put", "/api/admin/settings", { demo_mode: false });
  await anonCtx.close();
  await adminCtx.close();
});

test("/api-docs 公開可讀，互動式參考（Scalar）載入成功", async ({ page }) => {
  await page.goto("/api-docs");
  await expect(page.getByText("端點總覽")).toBeVisible(); // API.md SSR 內容，免金鑰
  await page.getByRole("button", { name: /互動式參考/ }).click();
  // Scalar 起來後會渲染規格標題；3.6MB 懶載入給寬鬆時限
  await expect(page.locator("#scalarWrap")).toContainText("uaip.cc.cd API", { timeout: 30_000 });
});

// 迴歸測試（v2.3.4）：數學佔位符互咬。
// 災情：pgmath.js 的佔位符前綴曾因「字面控制字元被存檔吃掉」退化成 M0、M1…M50，
// restore 由前往後跑時 split("M5") 把 "M50" 切成兩半 —— 第 50 條公式被換成第 5 條的
// 內容再接一個 "0"。使用者看到的是解題過程後半段變成 x → 50、x → 51、x → 52……
// 而前 10 條是正常的（i<10 還沒撞上），所以上線當下沒被發現。
// 這條測試用 60 條公式（跨過 10 與 50 的邊界）確保編號長短不會互相咬。
test("數學渲染：60 條公式的佔位符不互咬，每條都對應到自己的 tex", async ({ page }) => {
  await page.goto("/playground"); // 未登入也會載入 pgmath.js
  await page.waitForFunction(() => !!(window as unknown as { PGM?: unknown }).PGM, null, {
    timeout: 15_000
  });
  const r = await page.evaluate(() => {
    const PGM = (window as unknown as { PGM: Record<string, (...a: unknown[]) => unknown> }).PGM;
    const parts: string[] = [];
    for (let i = 0; i < 60; i++) parts.push("步驟 " + i + "： $x + " + i + "$");
    const store: unknown[] = [];
    const src = PGM.protect(parts.join("\n"), store) as string;
    const html = PGM.restore(src, store) as string;
    return {
      n: store.length,
      texts: [...html.matchAll(/data-tex="([^"]*)"/g)].map((m) => m[1]),
      leftover: /\uE000|\uE001/.test(html)
    };
  });
  expect(r.n).toBe(60);
  expect(r.leftover).toBe(false); // 佔位符必須全部被換掉
  for (let i = 0; i < 60; i++) {
    expect(r.texts[i], "第 " + i + " 條公式被別條污染了").toBe("x + " + i);
  }
});
