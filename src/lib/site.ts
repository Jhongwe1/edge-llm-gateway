// src/lib/site.ts — 新聞／文章功能的共用程式，給 src/routes/ 底下的路由 import。
// wrangler 部署時把 src/ 一併編譯打包進 Worker；src/ 在 public/ 之外，不會被當成靜態檔上傳。
// v2.2（2026-07-22）外殼全面改版：chatgpt.com 風格 — 左側常駐可收合側邊欄（含 History）、
// 頂部細列（頁名＋右側控制鈕）、預設深色主題、預設英文。設計規格見 v2.2plan.md。
// 外殼（選單、頁首、頁尾、相對時間等「框架」）支援中英切換 — 伺服器先輸出中文，
// 瀏覽器端依 localStorage `ipua-lang`（與主站共用）套用翻譯；文章內容本身不翻譯。

import type { Env } from "../types.js";

export const VERSION = "2.3.4"; // 站台版本（/api/health 回報；發佈時同步 git tag）

// 靜態資產的快取破壞參數（2026-07-22 收斂成單一常數）。
// public/assets/*.js 有 4 小時的邊緣／瀏覽器快取，改了就要把這個值調大，否則回訪的
// 使用者會拿到舊程式。以前這個版本號是**手抄在每個 <script> 標籤上**的，於是必然漂掉：
// 收斂前同時存在 account.js?v=20260717b、logs.js?v=20260721，以及 admin.js／marked.js
// 「根本沒帶」三種狀態 —— 後者等於那兩支的更新永遠要等快取自然過期。
// 一個常數、一個 assetSrc()，這一整類問題就不會再發生。
export const ASSET_V = "20260729c";
export function assetSrc(file: string): string {
  return "/assets/" + file + "?v=" + ASSET_V;
}

// 站台正式網址（canonical、og、sitemap、RSS 用）：優先 env.SITE_ORIGIN（wrangler.toml
// [vars]；fork 的人改那裡就好，程式碼不寫死網域），沒設定就用請求本身的 origin。
export function siteOrigin(env: Env, request: Request): string {
  const v = env && env.SITE_ORIGIN ? String(env.SITE_ORIGIN).trim().replace(/\/+$/, "") : "";
  return v || new URL(request.url).origin;
}

// 預設站名＝正式網址的主機名（正式站名可在編輯模式→網站名稱改，存 settings 表）。
export function siteBrand(env: Env, request: Request): string {
  try {
    return new URL(siteOrigin(env, request)).hostname;
  } catch (e) {
    return "";
  }
}

// 選單項：section＝分類標題、link＝連結（D1 menu 表與內建預設同形）。
export interface MenuItem {
  kind: string;
  label: string;
  label_en?: string;
  url?: string;
}

// 內建預設選單：menu 資料表是空的時候用這一份（也是「還原預設」的內容）。
// 管理員在編輯模式改過選單後，以資料表內容為準。
// v2.2 渲染規則（menuHtml）：第一個 section 的連結平鋪在 New chat 下方（標題不顯示、
// /playground 連結跳過 — New chat 就是它）；第二個以後的 section 變成可展開群組（預設收合）。
export const DEFAULT_MENU: MenuItem[] = [
  { kind: "section", label: "服務", label_en: "Services", url: "" },
  { kind: "link", label: "Playground", label_en: "Playground", url: "/playground" },
  { kind: "link", label: "API", label_en: "API", url: "/relay" },
  { kind: "link", label: "VPN", label_en: "VPN", url: "/vpn" },
  { kind: "section", label: "工具", label_en: "Tools", url: "" },
  { kind: "link", label: "IP 查詢", label_en: "IP Lookup", url: "/ip" },
  { kind: "link", label: "UA 查詢", label_en: "UA Lookup", url: "/ua" },
  { kind: "section", label: "內容", label_en: "Content", url: "" },
  { kind: "link", label: "新聞", label_en: "News", url: "/news" },
  { kind: "link", label: "文章", label_en: "Articles", url: "/articles" }
];

// 站台外觀資料（側邊欄選單＋站名＋VPN 展示開關）：一次 D1 batch 讀回。
// 資料表還沒建立、查詢失敗都退回內建預設 — 資料庫出狀況網站外殼照常運作。
// vpnPublic（v2.2）＝settings 表 vpn_public='1'：VPN 對外展示（選單與 /vpn 頁對所有人可見；
// 訂閱本身仍要批准）。搭進本來就要跑的 settings 查詢，不多花一次 D1 往返。
export interface Chrome {
  brand: string;
  menu: MenuItem[];
  custom: boolean;
  vpnPublic: boolean;
}

export async function getChrome(env: Env, request: Request): Promise<Chrome> {
  const chrome: Chrome = {
    brand: siteBrand(env, request),
    menu: DEFAULT_MENU,
    custom: false,
    vpnPublic: false
  };
  if (!env || !env.DB) return chrome;
  try {
    const res = await env.DB.batch([
      env.DB.prepare("SELECT kind,label,label_en,url FROM menu ORDER BY pos, id"),
      env.DB.prepare("SELECT k,v FROM settings WHERE k IN ('brand','vpn_public')")
    ]);
    const rows = (res[0].results || []) as unknown as MenuItem[];
    if (rows.length) {
      chrome.menu = rows;
      chrome.custom = true;
    }
    for (const r of (res[1].results || []) as { k: string; v: string }[]) {
      if (r.k === "brand" && r.v) chrome.brand = r.v;
      if (r.k === "vpn_public" && r.v === "1") chrome.vpnPublic = true;
    }
  } catch (e) {
    /* 表未建立／查詢失敗 → 預設 */
  }
  return chrome;
}

export interface Cat {
  key: string;
  path: string;
  label: string;
  tkey: string;
  desc: string;
}

export const CATS: Record<"news" | "article", Cat> = {
  news: { key: "news", path: "/news", label: "新聞", tkey: "cat.news", desc: "最新消息與快訊" },
  article: { key: "article", path: "/articles", label: "文章", tkey: "cat.article", desc: "專題、心得與長文" }
};
export type CatKey = keyof typeof CATS;

// 自訂頁面（/p/<slug>）的網址代稱規則：小寫英數與連字號、頭尾不能是連字號、最長 64 字。
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export function esc(s: unknown): string {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>
    )[c];
  });
}

// 第三參數 headers 可選（2026-07-14 加，向後相容）：429 要帶 Retry-After 這類額外標頭用
export function json(obj: unknown, status?: number, headers?: Record<string, string>): Response {
  const h = new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  if (headers) for (const k in headers) h.set(k, headers[k]);
  return new Response(JSON.stringify(obj), { status: status || 200, headers: h });
}

// ===== CSP（2026-07-14 v1.0.0；2026-07-16 v2 Phase B 改標記制）=====
// SSR 頁面全部經過 html() 這個單一入口 → 每個回應產一顆 nonce、
// **只對外殼自己標記的 <script data-nonce …> 蓋章**，並送出對應的 CSP 標頭。
// 以前是對 body 裡所有 <script 蓋章 — 文章夾帶的 <script> 也會被蓋到（stored-XSS 路徑）；
// 現在內容層就算混進 script（理論上 lib/sanitize.js 已擋）也拿不到 nonce，CSP 直接封殺。
// 靜態 SPA（public/index.html）走 public/_headers 的 sha256 版本（tools/check-csp.mjs 防漂移）。
// style-src 保留 'unsafe-inline'（外殼與各頁大量 inline style，記在 DEBT.md）。
function cspNonce(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}

// static.cloudflareinsights.com / cloudflareinsights.com＝Cloudflare Web Analytics 的
// beacon（主機在回應裡自動注入，拿不到 nonce）——2026-07-15 從 errlog 的 csp 違規發現被誤殺。
export function securityHeaders(nonce: string | null): Record<string, string> {
  const script = nonce ? "'self' 'nonce-" + nonce + "' https://static.cloudflareinsights.com" : "'none'";
  return {
    "content-security-policy":
      "default-src 'self'; script-src " +
      script +
      "; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: https:; connect-src 'self' https://cloudflareinsights.com; object-src 'none'; base-uri 'self'; " +
      "form-action 'self'; frame-ancestors 'none'; report-uri /api/csp-report",
    "strict-transport-security": "max-age=31536000; includeSubDomains",
    "cross-origin-opener-policy": "same-origin",
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin"
  };
}

export function html(body: string, status?: number): Response {
  const nonce = cspNonce();
  const stamped = String(body).replace(/<script data-nonce(?=[\s>])/g, '<script nonce="' + nonce + '"');
  const headers = Object.assign({ "content-type": "text/html; charset=utf-8" }, securityHeaders(nonce));
  return new Response(stamped, { status: status || 200, headers: headers });
}

// UTC ISO → 台灣日期 YYYY-MM-DD（台灣固定 UTC+8，無日光節約）
export function fmtDate(iso: string | null | undefined): string {
  const t = Date.parse(iso || "");
  if (isNaN(t)) return "";
  return new Date(t + 8 * 3600e3).toISOString().slice(0, 10);
}

// 伺服器先放絕對日期（沒有 JS 的環境與搜尋引擎都看得懂），
// 瀏覽器端外殼腳本再把它換算成「3 小時前 / 3 hr ago」這種相對時間。
export function timeAgo(iso: string | null | undefined): string {
  return '<time datetime="' + esc(iso) + '" data-ts="' + esc(iso) + '">' + fmtDate(iso) + "</time>";
}

// 眼睛小圖示（瀏覽數）
export const EYE =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';

// ===== 外殼小圖示（ChatGPT 風格的線條 SVG） =====
// 側欄開合（面板圖示）：頁首與側欄頂端共用
const ICON_PANEL =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9.5 4v16"/></svg>';
// New chat（鉛筆＋方框）
const ICON_NEW =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6"/><path d="M17.6 3.4a2 2 0 0 1 2.9 2.9L12 14.8 8 16l1.2-4z"/></svg>';
// 日夜切換的三態圖示（2026-07-22）。
// 原本用字元 ☀︎／☾／◐ — 但「黑白字形長什麼樣」完全由系統字型決定：Windows 的
// Segoe UI Symbol 把 ☀ 畫成粗八芒星，iOS 的 Apple Symbols 畫成細到看不見光芒的小圓點，
// 同一顆按鈕在兩台裝置上根本是兩個東西。改成 inline SVG＝自己帶字形，全平台一致。
const ICON_SUN =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.6v2M12 19.4v2M4.34 4.34l1.42 1.42M18.24 18.24l1.42 1.42M2.6 12h2M19.4 12h2M4.34 19.66l1.42-1.42M18.24 5.76l1.42-1.42"/></svg>';
const ICON_MOON =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.7 13.6A8.5 8.5 0 1 1 10.4 3.3a6.8 6.8 0 0 0 10.3 10.3z"/></svg>';
// 自動：半邊填滿的圓（原本的 ◐ 同義，但不吃系統字型）
const ICON_AUTO =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.2"/><path d="M12 3.8a8.2 8.2 0 0 0 0 16.4z" fill="currentColor" stroke="none"/></svg>';

// 側邊欄選單 HTML（v2.2）：
//   第一個 section → 標題不顯示，連結平鋪（/playground 連結跳過 — 側欄頂端的 New chat 就是它）
//   第二個以後的 section → <details> 可展開群組（預設收合；展開狀態由外殼腳本記 localStorage）
// 自訂英文名放 data-en，由外殼腳本依語言切換。activePath 命中的連結加 active。
function menuHtml(menu: MenuItem[], activePath?: string): string {
  let out = "";
  let secN = 0; // 已遇到幾個 section
  let inGrp = false;
  function linkHtml(it: MenuItem): string {
    const en = it.label_en ? ' data-en="' + esc(it.label_en) + '"' : "";
    const act = activePath && it.url === activePath ? " active" : "";
    return '<a class="sb-link' + act + '" href="' + esc(it.url) + '"' + en + ">" + esc(it.label) + "</a>\n";
  }
  for (const it of menu) {
    if (it.kind === "section") {
      secN++;
      if (inGrp) {
        out += "</div></details>\n";
        inGrp = false;
      }
      if (secN >= 2) {
        // data-grp 用中文名當 key（英文名可能沒填）；展開狀態存 localStorage ipua-grp:<key>
        const en = it.label_en ? ' data-en="' + esc(it.label_en) + '"' : "";
        out +=
          '<details class="sb-grp" data-grp="' +
          esc(it.label) +
          '"><summary class="sb-link"><span class="lb"' +
          en +
          ">" +
          esc(it.label) +
          '</span><span class="chev" aria-hidden="true">›</span></summary><div class="grp-body">\n';
        inGrp = true;
      }
      continue;
    }
    if (secN <= 1 && it.url === "/playground") continue; // 平鋪區的 Playground＝New chat，不重複
    out += linkHtml(it);
  }
  if (inGrp) out += "</div></details>\n";
  return out;
}

/* 頁面外殼：o = {
     title      分頁標題（會自動加上「 · 站名」）
     tkey       分頁標題的翻譯 key（列表頁用；文章頁標題不翻譯就不給）
     desc       meta description
     canonical  正式網址（絕對網址）
     activePath 側邊欄目前頁面的路徑（例 "/news"；選單連結相同者標 active）
     chrome     getChrome(env, request) 或 getChromeFor() 的結果（站名＋選單）
     h1         頁首左上的標題（HTML，可含連結與 data-i18n）
     headExtra  額外塞進 <head> 的東西（og、JSON-LD…）
     body       主要內容 HTML
     noindex    true = 不讓搜尋引擎收錄
   } */
export interface PageShellOpts {
  title: string;
  tkey?: string | null;
  desc?: string;
  canonical?: string;
  activePath?: string;
  chrome?: Chrome;
  h1: string;
  headExtra?: string;
  body: string;
  noindex?: boolean;
}

export function pageShell(o: PageShellOpts): string {
  const brand = (o.chrome && o.chrome.brand) || "";
  const menu = (o.chrome && o.chrome.menu) || DEFAULT_MENU;
  return (
    // 預設深色（v2.2）：伺服器直接輸出 data-theme="dark"，腳本再依 localStorage 修正 — 避免白閃
    '<!DOCTYPE html>\n<html lang="zh-Hant" data-theme="dark" class="noanim">\n<head>\n' +
    // interactive-widget=resizes-content：Android Chrome 鍵盤彈出時縮排版而不是蓋住/亂捲（其他瀏覽器忽略）
    '<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width, initial-scale=1.0, interactive-widget=resizes-content">\n' +
    "<title>" +
    esc(o.title) +
    " · " +
    esc(brand) +
    "</title>\n" +
    '<meta name="description" content="' +
    esc(o.desc || "") +
    '">\n' +
    (o.noindex ? '<meta name="robots" content="noindex,nofollow">\n' : "") +
    (o.canonical ? '<link rel="canonical" href="' + esc(o.canonical) + '">\n' : "") +
    '<link rel="alternate" type="application/rss+xml" title="' +
    esc(brand) +
    ' RSS" href="/feed">\n' +
    '<meta name="theme-color" media="(prefers-color-scheme: light)" content="#ffffff">\n' +
    '<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#212121">\n' +
    // favicon（2026-07-22 改）：本來是塞進 SVG 的 🌐 emoji — 跟日夜按鈕同一個毛病，
    // 各家系統的 emoji 字型長相不同（有的裝置甚至畫成豆腐框）。改成純線條的圓角方框 □，
    // 自己帶字形、到哪都一樣。灰階 #8f8f8f 是深淺兩色系都看得清的中間值（＝全站 --sub）。
    "<link rel=\"icon\" href=\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect x='6' y='6' width='20' height='20' rx='5' fill='none' stroke='%238f8f8f' stroke-width='3'/%3E%3C/svg%3E\">\n" +
    // 外殼樣式先、headExtra（各頁自訂樣式）後 — 同權重時後者贏，各頁才蓋得過外殼。
    // v2.1 以前順序相反，頁面得用 html body 之類的 hack 拉權重；v2.2 改正。
    "<style>" +
    SHELL_CSS +
    "</style>\n" +
    (o.headExtra || "") +
    "</head>\n<body>\n" +
    '<div id="app" class="app">\n' +
    '<div id="sbOverlay" class="sb-overlay"></div>\n' +
    // 側邊欄：桌機常駐可收合、手機抽屜。#sbMenu／#sbAdmin 掛點名稱不能改（adminbar.js 選單編輯器依賴）。
    '<aside id="sidebar" class="sb" aria-label="Sidebar">\n' +
    '  <div class="sb-top"><button id="sbCollapse" class="sb-icon" aria-label="收合側邊欄" data-i18n-aria="sb.close">' +
    '<span class="ic-d">' +
    ICON_PANEL +
    '</span><span class="ic-m" aria-hidden="true">✕</span></button></div>\n' +
    "  <nav>\n" +
    '  <a id="sbNewChat" class="sb-link sb-new" href="/playground">' +
    ICON_NEW +
    '<span data-i18n="sb.newchat">新交談</span></a>\n' +
    '  <div id="sbMenu">\n' +
    menuHtml(menu, o.activePath) +
    '  </div>\n  <div id="sbAdmin"></div>\n' +
    // History（playground 歷史對話）：外殼腳本在確認登入＋有 playground 服務後才顯示並填入。
    // 可收折（仿 ChatGPT Recents）：預設展開，狀態記 localStorage ipua-hist。
    '  <div id="sbHist" class="hidden"><div class="sb-div"></div><details id="sbHistGrp" open>' +
    '<summary class="sb-sec sb-histhd"><span data-i18n="sb.history">對話紀錄</span><span class="chev" aria-hidden="true">›</span></summary>' +
    '<div id="sbHistList"></div></details></div>\n' +
    "  </nav>\n" +
    // 左下角帳號區：account.js 渲染（未登入＝登入鈕；登入＝頭像＋名字＋聯絡我）
    '  <div id="sbAcct" class="sb-acct"></div>\n' +
    "</aside>\n" +
    '<div class="main">\n' +
    "  <header>" +
    '<button id="sbToggle" class="sb-icon" aria-label="開啟側邊欄" data-i18n-aria="sb.open">' +
    ICON_PANEL +
    "</button>" +
    "<h1>" +
    o.h1 +
    '</h1><div class="ctrls">' +
    '<button id="langToggle" class="ctrl" title="Language / 語言">EN</button>' +
    // 初始內容＝月亮（伺服器預設輸出 data-theme="dark"）；腳本讀完 localStorage 再換成正確那顆
    '<button id="themeToggle" class="ctrl" title="Day / Night">' +
    ICON_MOON +
    "</button></div></header>\n" +
    '  <div class="content"><div class="wrap">\n' +
    o.body +
    "\n" +
    // foot.tool 連到 /ip：根網址 / 已改跳 Playground，工具入口改走 /ip
    '  <footer><a href="/news" data-i18n="cat.news">新聞</a> · <a href="/articles" data-i18n="cat.article">文章</a> · <a href="/ip" data-i18n="foot.tool">IP·UA 查詢</a> · <a href="/feed" data-i18n="foot.rss">RSS 訂閱</a></footer>\n' +
    "  </div></div>\n</div>\n</div>\n" +
    "<script data-nonce>var __TKEY=" +
    JSON.stringify(o.tkey || null) +
    ",__BRAND=" +
    JSON.stringify(brand) +
    ";" +
    SHELL_JS +
    "</script>\n" +
    '<script data-nonce src="' +
    assetSrc("account.js") +
    '"></script>\n</body>\n</html>\n'
  );
}

// ===== 外殼樣式（v2.2 ChatGPT 風格）=====
// 色票變數名稱沿用 v2.1（--bg/--fg/--card/--line/--field/--accent…），值換成 ChatGPT 的深淺色系，
// 各頁既有元件（卡片、表格、表單）不用改就自動換皮。新增：--sb 側欄底、--hov/--hov2 懸停層。
const SHELL_CSS = `
  *{box-sizing:border-box;margin:0;padding:0}
  :root{--bg:#ffffff;--fg:#0d0d0d;--muted:#5d5d5d;--sub:#8f8f8f;--line:#e6e6e6;--line2:#0d0d0d;--card:#ffffff;--accent:#0d0d0d;--accent-fg:#ffffff;--field:#f4f4f4;--sb:#f9f9f9;--hov:rgba(0,0,0,.05);--hov2:rgba(0,0,0,.1);color-scheme:light}
  [data-theme="dark"]{--bg:#212121;--fg:#ececec;--muted:#b4b4b4;--sub:#8f8f8f;--line:#3a3a3a;--line2:#ececec;--card:#2f2f2f;--accent:#ececec;--accent-fg:#0d0d0d;--field:#2f2f2f;--sb:#171717;--hov:rgba(255,255,255,.06);--hov2:rgba(255,255,255,.12);color-scheme:dark}
  html,body{height:100%;background:var(--bg);color:var(--fg)}
  body{font-family:-apple-system,"Segoe UI","Microsoft JhengHei",system-ui,"PingFang TC",sans-serif;line-height:1.55;-webkit-font-smoothing:antialiased;overflow:hidden;transition:background .25s,color .25s}
  .hidden{display:none!important}
  /* 首次載入不要播側欄滑動動畫（noanim 由腳本在第一幀後移除） */
  .noanim *{transition:none!important}
  .app{display:flex;height:100vh;height:100dvh}
  /* ===== 側邊欄 ===== */
  .sb{width:260px;flex:0 0 260px;background:var(--sb);display:flex;flex-direction:column;min-width:0;transition:margin-left .22s ease}
  .app.nosb .sb{margin-left:-260px}
  .sb-top{display:flex;align-items:center;justify-content:flex-end;gap:4px;padding:10px 10px 2px}
  .sb-icon{width:36px;height:36px;flex:0 0 auto;border:0;background:none;color:var(--muted);border-radius:8px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;font-family:inherit;font-size:14px;transition:.15s}
  .sb-icon:hover{background:var(--hov);color:var(--fg)}
  .sb-icon svg{display:block}
  .ic-m{display:none}
  .sb nav{flex:1;overflow-y:auto;padding:4px 10px 12px;min-height:0}
  .sb-link{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:9px;color:var(--fg);text-decoration:none;font-size:13.5px;font-weight:500;transition:background .12s;min-width:0;cursor:pointer}
  .sb-link:hover{background:var(--hov)}
  .sb-link.active{background:var(--hov2)}
  .sb-new{font-weight:600;margin-bottom:2px}
  .sb-new svg{flex:0 0 auto}
  .sb-sec{font-size:11.5px;font-weight:600;color:var(--sub);padding:12px 10px 5px}
  .sb-div{border-top:1px solid var(--line);margin:10px 4px 2px}
  /* History 標題列（可收折，仿 ChatGPT Recents） */
  .sb-histhd{display:flex;align-items:center;gap:6px;cursor:pointer;list-style:none;user-select:none}
  .sb-histhd::-webkit-details-marker{display:none}
  .sb-histhd:hover{color:var(--fg)}
  .sb-histhd .chev{color:var(--sub);font-size:13px;line-height:1;transition:transform .15s}
  #sbHistGrp[open] .sb-histhd .chev{transform:rotate(90deg)}
  /* 可展開群組（Tools / Content…） */
  .sb-grp>summary{list-style:none}
  .sb-grp>summary::-webkit-details-marker{display:none}
  .sb-grp>summary .lb{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .sb-grp>summary .chev{flex:0 0 auto;color:var(--sub);font-size:14px;line-height:1;transition:transform .15s}
  .sb-grp[open]>summary .chev{transform:rotate(90deg)}
  .grp-body .sb-link{padding-left:26px}
  /* History 列（外殼腳本渲染） */
  .sb-conv{display:flex;align-items:center;gap:2px;padding:7px 4px 7px 10px;border-radius:9px;cursor:pointer;color:var(--fg);min-width:0}
  .sb-conv:hover{background:var(--hov)}
  .sb-conv.on{background:var(--hov2)}
  .sb-conv .tt{flex:1;min-width:0;font-size:13.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .sb-conv .dots{flex:0 0 auto;border:0;background:none;color:var(--muted);border-radius:6px;padding:3px 7px;cursor:pointer;font-size:14px;line-height:1;font-family:inherit;opacity:0;transition:.12s}
  .sb-conv:hover .dots,.sb-conv.on .dots{opacity:.85}
  .sb-conv .dots:hover{background:var(--hov2);color:var(--fg)}
  @media(hover:none){.sb-conv .dots{opacity:.6}}
  .sb-empty{padding:8px 10px;font-size:12.5px;color:var(--sub)}
  /* 左下角帳號區（account.js 渲染內容） */
  .sb-acct{flex:0 0 auto;border-top:1px solid var(--line);padding:8px}
  /* ===== 主區 ===== */
  .main{flex:1;min-width:0;display:flex;flex-direction:column;background:var(--bg)}
  header{flex:0 0 auto;display:flex;align-items:center;gap:6px;padding:8px 14px;min-height:54px}
  h1{font-size:16px;font-weight:600;letter-spacing:0;display:flex;align-items:center;gap:6px;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
  h1 a{color:var(--fg);text-decoration:none}
  h1 a:hover{text-decoration:underline}
  .ctrls{margin-left:auto;display:flex;gap:4px;flex:0 0 auto;align-items:center}
  .ctrl{height:34px;min-width:34px;padding:0 11px;border:0;background:none;color:var(--muted);border-radius:8px;cursor:pointer;font-size:12.5px;font-weight:600;line-height:1;font-family:inherit;transition:.15s;display:inline-flex;align-items:center;justify-content:center;text-decoration:none}
  .ctrl:hover{background:var(--hov);color:var(--fg)}
  #themeToggle{width:34px;padding:0;font-size:15px}
  /* 桌機：側欄展開時頁首的開啟鈕藏起來（側欄內已有收合鈕） */
  @media(min-width:840px){.app:not(.nosb) #sbToggle{display:none}}
  .content{flex:1;min-height:0;overflow-y:auto;padding:22px 16px 48px}
  .wrap{max-width:720px;margin:0 auto}
  /* 細滾動條（全站） */
  .content::-webkit-scrollbar,.sb nav::-webkit-scrollbar{width:8px}
  .content::-webkit-scrollbar-track,.sb nav::-webkit-scrollbar-track{background:transparent}
  .content::-webkit-scrollbar-thumb,.sb nav::-webkit-scrollbar-thumb{background:var(--line);border-radius:4px;border:2px solid transparent;background-clip:content-box}
  /* ===== 共用彈出選單（頭像選單、History「…」、模型選單共用） ===== */
  .pop{position:fixed;z-index:130;min-width:200px;max-width:300px;background:var(--card);border:1px solid var(--line);border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.35);padding:6px;display:none}
  .pop.open{display:block}
  .pop .phead{padding:9px 12px 7px;font-size:12px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .pop .phr{border-top:1px solid var(--line);margin:5px 4px}
  .pop .pi{display:flex;width:100%;align-items:center;gap:9px;text-align:left;padding:9px 12px;border:0;background:none;color:var(--fg);font-family:inherit;font-size:13.5px;font-weight:500;line-height:1.45;border-radius:9px;cursor:pointer;text-decoration:none;box-sizing:border-box}
  .pop .pi:hover{background:var(--hov)}
  .pop .pi.danger{color:#e02e2a}
  .pop .pi.danger:hover{background:rgba(224,46,42,.12)}
  .pop .pi .pk{margin-left:auto;color:var(--muted);font-size:12px}
  /* ===== 手機（<840px）：側欄變抽屜 ===== */
  .sb-overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);opacity:0;visibility:hidden;transition:opacity .2s,visibility .2s;z-index:60}
  @media(max-width:839.98px){
    .sb{position:fixed;top:0;left:0;bottom:0;z-index:61;max-width:84vw;margin:0!important;transform:translateX(-105%);transition:transform .22s ease}
    .app.sbopen .sb{transform:none;box-shadow:0 0 42px rgba(0,0,0,.35)}
    .app.sbopen .sb-overlay{opacity:1;visibility:visible}
    .ic-d{display:none}
    .ic-m{display:inline}
    .content{padding:18px 13px 44px}
  }
  footer{margin-top:34px;text-align:center;color:var(--sub);font-size:11px;line-height:1.8}
  footer a{color:var(--muted);text-decoration:none}
  footer a:hover{text-decoration:underline}
  /* ===== 列表（排版仿 antutu：左縮圖、右標題＋兩行摘要＋時間/瀏覽數） ===== */
  .list{border-top:1px solid var(--line)}
  .item{display:flex;gap:18px;padding:20px 0;border-bottom:1px solid var(--line);text-decoration:none;color:var(--fg)}
  .thumb{flex:0 0 228px;aspect-ratio:5/3;border-radius:10px;overflow:hidden;background:var(--field);border:1px solid var(--line);display:flex;align-items:center;justify-content:center;font-size:34px}
  .thumb img{width:100%;height:100%;object-fit:cover;display:block}
  .it{flex:1;min-width:0;display:flex;flex-direction:column}
  .it h2{font-size:17.5px;line-height:1.5;font-weight:700;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  .item:hover h2{text-decoration:underline}
  .it p{margin-top:7px;font-size:13.5px;color:var(--muted);line-height:1.65;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  .meta{margin-top:auto;padding-top:8px;font-size:12.5px;color:var(--sub);display:flex;gap:16px;align-items:center}
  .meta .views{display:inline-flex;align-items:center;gap:5px}
  .empty{padding:44px 0;text-align:center;color:var(--muted);font-size:14px;border-bottom:1px solid var(--line)}
  @media(max-width:560px){
    .item{gap:12px;padding:14px 0}
    .thumb{flex-basis:124px;aspect-ratio:3/2;border-radius:8px;font-size:22px}
    .it h2{font-size:15px}
    .it p{display:none}
    .meta{padding-top:4px;font-size:12px}
  }
  /* ===== 頁碼分頁 ===== */
  .pager{display:flex;gap:8px;justify-content:center;align-items:center;margin:26px 0 4px;flex-wrap:wrap}
  .pager a,.pager .cur,.pager .gap{min-width:36px;height:36px;padding:0 12px;border:1px solid var(--line);border-radius:9px;display:inline-flex;align-items:center;justify-content:center;font-size:13.5px;font-weight:600;text-decoration:none;color:var(--fg)}
  .pager a:hover{border-color:var(--line2)}
  .pager .cur{background:var(--accent);color:var(--accent-fg);border-color:var(--line2)}
  .pager .gap{border:0;color:var(--sub);min-width:auto;padding:0 2px}
  /* ===== 文章頁 ===== */
  .art h1.t{font-size:24px;line-height:1.45;font-weight:700;margin:2px 0 12px;letter-spacing:0}
  .ameta{color:var(--sub);font-size:13px;display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin-bottom:18px}
  .ameta .views{display:inline-flex;align-items:center;gap:5px}
  .cover{width:100%;border-radius:11px;border:1px solid var(--line);display:block;margin-bottom:20px}
  .prose{font-size:16px;line-height:1.95;overflow-wrap:anywhere}
  .prose p{margin:0 0 1.1em}
  .prose h2{font-size:20px;line-height:1.5;margin:1.5em 0 .65em}
  .prose h3{font-size:17.5px;margin:1.3em 0 .55em}
  .prose h4{font-size:16px;margin:1.2em 0 .5em}
  .prose img{max-width:100%;height:auto;border-radius:10px;display:block;margin:18px auto}
  .prose a{color:var(--fg)}
  .prose ul,.prose ol{padding-left:1.7em;margin:0 0 1.1em}
  .prose li{margin:.28em 0}
  .prose blockquote{border-left:3px solid var(--line2);padding:2px 0 2px 14px;color:var(--muted);margin:0 0 1.1em}
  .prose code{font-family:ui-monospace,Menlo,Consolas,monospace;background:var(--field);border:1px solid var(--line);border-radius:5px;padding:1px 6px;font-size:.88em}
  .prose pre{background:var(--field);border:1px solid var(--line);border-radius:10px;padding:14px;overflow-x:auto;margin:0 0 1.1em;line-height:1.6}
  .prose pre code{border:0;background:none;padding:0}
  .prose hr{border:0;border-top:1px solid var(--line);margin:1.6em 0}
  .prose table{border-collapse:collapse;margin:0 0 1.1em;max-width:100%;display:block;overflow-x:auto}
  .prose th,.prose td{border:1px solid var(--line);padding:6px 12px;font-size:14px}
  /* 上一篇／下一篇 */
  .anav{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:28px}
  .anav a{border:1px solid var(--line);border-radius:11px;padding:12px 14px;text-decoration:none;color:var(--fg);min-width:0;transition:.15s}
  .anav a:hover{border-color:var(--line2)}
  .anav a.nx{text-align:right}
  .anav .lbl{display:block;font-size:11px;font-weight:700;letter-spacing:.08em;color:var(--muted);margin-bottom:4px;text-transform:uppercase}
  .anav .ttl{display:block;font-size:14px;font-weight:600;line-height:1.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  @media(max-width:560px){.anav{grid-template-columns:1fr}.anav a.nx{text-align:left}}
  .backrow{margin-top:16px}
  @media(max-width:480px){h1{font-size:15px}.art h1.t{font-size:20px}.prose{font-size:15.5px}}
  /* ===== 共用彈窗（relay/vpn/members 的渠道編輯、/settings 的頁面編輯等）=====
     overlay 本身可捲＋dialog margin:auto：內容矮＝置中、高（或手機鍵盤彈出）＝順順捲動，
     不會像以前 align-items:center 那樣被鍵盤蓋住看不到下半截。 */
  .mu-ov{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:120;display:flex;align-items:flex-start;justify-content:center;padding:16px;overflow:auto;overscroll-behavior:contain}
  .mu-dlg{max-width:440px;width:100%;margin:auto}
  /* ===== 觸控裝置：表單控制項字級一律 ≥16px =====
     iOS Safari 在 input/select/textarea 字級 <16px 時，聚焦（鍵盤彈出）會自動把整頁放大 —
     這就是「手機點欄位頁面莫名變大」的元凶。!important 是刻意的：要壓過各頁面
     較晚注入的 <style> 與元素上的 inline style（playground 已自帶同款處方，此為全站版）。 */
  @media(hover:none){
    input,select,textarea{font-size:16px!important}
  }
`;

// ===== 管理頁共用樣式（/logs、/admin 的卡片、表單、表格元件；接在 SHELL_CSS 之後使用） =====
export const ADMIN_CSS = `
  .card{border:1px solid var(--line);border-radius:11px;padding:14px 16px;margin-bottom:14px;background:var(--card)}
  .card-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);padding-bottom:9px;margin-bottom:9px;border-bottom:1px solid var(--line)}
  .hint{font-size:12.5px;color:var(--muted);margin:4px 0 10px}
  .error{border:1px solid var(--line2);border-radius:8px;padding:11px 14px;margin-top:12px;font-size:13px}
  .hidden{display:none!important}
  .mono{font-family:ui-monospace,"SFMono-Regular",Menlo,Consolas,"Courier New",monospace}
  .query{display:flex;gap:8px;margin-bottom:14px}
  input[type=text],input[type=password],select,textarea{
    width:100%;border:1px solid var(--line);background:var(--field);color:var(--fg);
    border-radius:8px;padding:11px 12px;font-size:14px;font-family:inherit;outline:none;transition:.15s}
  .query input{flex:1}
  input:focus,select:focus,textarea:focus{border-color:var(--line2)}
  textarea{resize:vertical;line-height:1.7}
  button[type=submit],.primary{
    border:1px solid var(--line2);background:var(--accent);color:var(--accent-fg);
    border-radius:8px;padding:11px 22px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;white-space:nowrap}
  .ghost{
    border:1px solid var(--line);background:transparent;color:var(--fg);border-radius:8px;
    padding:11px 16px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;white-space:nowrap;transition:.15s;
    text-decoration:none;display:inline-flex;align-items:center;gap:6px}
  .ghost:hover{border-color:var(--line2)}
  .danger:hover{border-color:#c33;color:#c33}
  button:disabled{opacity:.5;cursor:default}
  .toolbar{display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap;align-items:center}
  .toolbar .sp{flex:1}
  .tbl-card{padding:0;overflow:hidden}
  .tbl-wrap{overflow-x:auto}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{text-align:left;font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;
     padding:10px 12px;border-bottom:1px solid var(--line);white-space:nowrap;background:var(--card)}
  td{padding:10px 12px;border-bottom:1px dashed var(--line)}
  tbody tr:last-child td{border-bottom:0}
  td.nowrap{white-space:nowrap}
  .tbl-empty{padding:22px;text-align:center;color:var(--muted);font-size:13px}
`;

// ===== 外殼腳本：中英切換（預設英文）、主題（預設深色）、側欄開合、群組展開、History、管理員捷徑 =====
const SHELL_JS = `
(function(){
  "use strict";
  /* --- 框架翻譯字典（只翻框架，文章內容不翻） --- */
  var I18N={
    zh:{"sb.title":"選單","sb.content":"內容","sb.tools":"工具","sb.admin":"管理員","sb.manage":"文章管理","sb.logs":"訪客紀錄",
        "sb.newchat":"新交談","sb.history":"對話紀錄","sb.open":"開啟側邊欄","sb.close":"收合側邊欄",
        "hist.rename":"改名","hist.delete":"刪除","hist.untitled":"（未命名）","hist.empty":"還沒有對話",
        "hist.confirm":"刪除這則對話？此動作無法復原。","hist.title":"對話名稱",
        "cat.news":"新聞","cat.article":"文章","tab.ip":"IP 查詢","tab.ua":"UA 查詢",
        "foot.tool":"IP·UA 查詢","foot.rss":"RSS 訂閱",
        "page.relay":"API 中轉站","page.vpn":"VPN","page.members":"成員管理","page.playground":"Chat",
        "back.news":"← 回新聞列表","back.article":"← 回文章列表",
        "empty.list":"目前還沒有內容，敬請期待。","empty.404":"找不到這篇內容 — 可能已下架或網址有誤。",
        "pg.prev":"‹ 上一頁","pg.next":"下一頁 ›","an.prev":"上一篇","an.next":"下一篇",
        "t.now":"剛剛","t.min":"{n} 分鐘前","t.hour":"{n} 小時前","t.day":"{n} 天前",
        "theme.day":"白天模式（點擊切換）","theme.night":"夜間模式（點擊切換）","theme.auto":"自動日夜（點擊切換）"},
    en:{"sb.title":"Menu","sb.content":"Content","sb.tools":"Tools","sb.admin":"Admin","sb.manage":"Manage posts","sb.logs":"Visitor logs",
        "sb.newchat":"New chat","sb.history":"History","sb.open":"Open sidebar","sb.close":"Close sidebar",
        "hist.rename":"Rename","hist.delete":"Delete","hist.untitled":"(untitled)","hist.empty":"No conversations yet",
        "hist.confirm":"Delete this conversation? This cannot be undone.","hist.title":"Conversation title",
        "cat.news":"News","cat.article":"Articles","tab.ip":"IP Lookup","tab.ua":"UA Lookup",
        "foot.tool":"IP·UA Lookup","foot.rss":"RSS",
        "page.relay":"API relay","page.vpn":"VPN subscription","page.members":"Members","page.playground":"Chat",
        "back.news":"← Back to News","back.article":"← Back to Articles",
        "empty.list":"Nothing here yet — stay tuned.","empty.404":"Content not found — it may have been removed or the URL is wrong.",
        "pg.prev":"‹ Prev","pg.next":"Next ›","an.prev":"Previous","an.next":"Next",
        "t.now":"just now","t.min":"{n} min ago","t.hour":"{n} hr ago","t.day":"{n} days ago",
        "theme.day":"Day mode (tap to switch)","theme.night":"Night mode (tap to switch)","theme.auto":"Auto day/night (tap to switch)"}
  };
  /* v2.2：預設英文（存過偏好者除外） */
  var lang="en";
  try{
    var saved=localStorage.getItem("ipua-lang");
    if(saved==="zh"||saved==="en") lang=saved;
  }catch(e){}
  function t(key,vars){
    var s=(I18N[lang]&&I18N[lang][key])||I18N.zh[key]||key;
    if(vars)for(var k in vars)s=s.split("{"+k+"}").join(vars[k]);
    return s;
  }
  /* --- 相對時間：伺服器輸出絕對日期，這裡換算成「3 小時前」；太久以前維持日期 --- */
  function relText(iso){
    var ts=Date.parse(iso);if(isNaN(ts))return null;
    var s=(Date.now()-ts)/1000;if(s<0)return null;
    if(s<60)return t("t.now");
    if(s<3600)return t("t.min",{n:Math.floor(s/60)});
    if(s<86400)return t("t.hour",{n:Math.floor(s/3600)});
    if(s<86400*30)return t("t.day",{n:Math.floor(s/86400)});
    return null;
  }
  function renderTimes(){
    var ts=document.querySelectorAll("time[data-ts]");
    for(var i=0;i<ts.length;i++){
      var el=ts[i];
      if(!el.getAttribute("data-abs"))el.setAttribute("data-abs",el.textContent);
      var r=relText(el.getAttribute("data-ts"));
      el.textContent=r||el.getAttribute("data-abs");
    }
  }
  function applyI18n(){
    document.documentElement.lang=(lang==="zh"?"zh-Hant":"en");
    var els=document.querySelectorAll("[data-i18n]");
    for(var i=0;i<els.length;i++)els[i].textContent=t(els[i].getAttribute("data-i18n"));
    var ars=document.querySelectorAll("[data-i18n-aria]");
    for(var j=0;j<ars.length;j++)ars[j].setAttribute("aria-label",t(ars[j].getAttribute("data-i18n-aria")));
    /* 自訂選單項目：中文寫在內容裡、英文放 data-en；第一次先把中文備份到 data-zh 再切換 */
    var ens=document.querySelectorAll("[data-en]");
    for(var m=0;m<ens.length;m++){
      var en=ens[m];
      if(!en.getAttribute("data-zh"))en.setAttribute("data-zh",en.textContent);
      var ev=en.getAttribute("data-en");
      en.textContent=(lang==="en"&&ev)?ev:en.getAttribute("data-zh");
    }
    var lb=document.getElementById("langToggle");if(lb)lb.textContent=(lang==="zh"?"EN":"中");
    if(typeof __TKEY==="string"&&__TKEY)document.title=t(__TKEY)+" · "+__BRAND;
    renderTimes();
  }
  document.getElementById("langToggle").addEventListener("click",function(){
    lang=(lang==="zh")?"en":"zh";
    try{localStorage.setItem("ipua-lang",lang)}catch(e){}
    applyI18n();applyTheme();renderHist();
    // 廣播給 JS 動態渲染的區塊（帳號區、/relay /vpn /members 面板）跟著切語言
    try{window.dispatchEvent(new CustomEvent("ipua:lang",{detail:{lang:lang}}));}catch(e){}
  });
  /* --- 主題三段式（同儲存鍵）：night 深色（v2.2 起預設）/ day 淺色 / auto 依當地日夜。 --- */
  var THEME_MODES=["day","night","auto"],themeMode="night",autoCache=null;
  var THEME_ICONS={day:${JSON.stringify(ICON_SUN)},night:${JSON.stringify(ICON_MOON)},auto:${JSON.stringify(ICON_AUTO)}};
  try{var m0=localStorage.getItem("ipua-theme-mode");if(THEME_MODES.indexOf(m0)>=0)themeMode=m0}catch(e){}
  try{autoCache=localStorage.getItem("ipua-auto")}catch(e){}
  function autoThemeGuess(){
    if(autoCache==="light"||autoCache==="dark")return autoCache;
    var h=new Date().getHours();return(h>=6&&h<18)?"light":"dark";
  }
  function applyTheme(){
    var th=themeMode==="night"?"dark":(themeMode==="auto"?autoThemeGuess():"light");
    document.documentElement.setAttribute("data-theme",th);
    var b=document.getElementById("themeToggle");
    /* 三顆都是 inline SVG（不吃系統字型 — 見 ICON_SUN 上方註解） */
    b.innerHTML=themeMode==="day"?THEME_ICONS.day:(themeMode==="night"?THEME_ICONS.night:THEME_ICONS.auto);
    b.title=t("theme."+themeMode);b.setAttribute("aria-label",t("theme."+themeMode));
  }
  document.getElementById("themeToggle").addEventListener("click",function(){
    themeMode=THEME_MODES[(THEME_MODES.indexOf(themeMode)+1)%THEME_MODES.length];
    try{localStorage.setItem("ipua-theme-mode",themeMode)}catch(e){}
    applyTheme();
  });
  /* --- 側邊欄：桌機常駐可收合（記 localStorage）、手機抽屜 --- */
  var app=document.getElementById("app"),sb=document.getElementById("sidebar"),
      ov=document.getElementById("sbOverlay"),tgl=document.getElementById("sbToggle"),
      clp=document.getElementById("sbCollapse");
  var mqDesk=window.matchMedia("(min-width:840px)");
  var collapsed=false;
  try{collapsed=localStorage.getItem("ipua-sbc")==="1"}catch(e){}
  function isDesk(){return mqDesk.matches}
  function applySb(){
    if(isDesk()){
      app.classList.remove("sbopen");
      app.classList.toggle("nosb",collapsed);
      if(collapsed)sb.setAttribute("inert","");else sb.removeAttribute("inert");
      document.body.style.overflow="";
    }else{
      app.classList.remove("nosb");
      var open=app.classList.contains("sbopen");
      if(open)sb.removeAttribute("inert");else sb.setAttribute("inert","");
    }
  }
  function drawerOpen(open){
    app.classList.toggle("sbopen",!!open);
    if(open)sb.removeAttribute("inert");else sb.setAttribute("inert","");
  }
  tgl.addEventListener("click",function(){
    if(isDesk()){collapsed=false;try{localStorage.setItem("ipua-sbc","0")}catch(e){}applySb();}
    else drawerOpen(true);
  });
  clp.addEventListener("click",function(){
    if(isDesk()){collapsed=true;try{localStorage.setItem("ipua-sbc","1")}catch(e){}applySb();}
    else drawerOpen(false);
  });
  ov.addEventListener("click",function(){drawerOpen(false)});
  document.addEventListener("keydown",function(e){
    if(e.key==="Escape"&&!isDesk()&&app.classList.contains("sbopen"))drawerOpen(false);
  });
  if(mqDesk.addEventListener)mqDesk.addEventListener("change",applySb);
  else if(mqDesk.addListener)mqDesk.addListener(applySb);
  /* 手機：點側欄裡的連結後把抽屜關上（換頁前視覺乾淨；同頁 SPA 行為也適用） */
  sb.addEventListener("click",function(e){
    var a=e.target&&e.target.closest?e.target.closest("a.sb-link,.sb-conv"):null;
    if(a&&!isDesk())drawerOpen(false);
  });
  /* --- 群組（Tools/Content…）展開狀態記憶 --- */
  var grps=document.querySelectorAll(".sb-grp");
  for(var gi=0;gi<grps.length;gi++)(function(g){
    var key="ipua-grp:"+(g.getAttribute("data-grp")||"");
    try{if(localStorage.getItem(key)==="1")g.open=true}catch(e){}
    g.addEventListener("toggle",function(){
      try{localStorage.setItem(key,g.open?"1":"0")}catch(e){}
    });
  })(grps[gi]);
  /* --- History 收折狀態（與群組相反：預設展開） --- */
  var hg=document.getElementById("sbHistGrp");
  if(hg){
    try{if(localStorage.getItem("ipua-hist")==="0")hg.open=false}catch(e){}
    hg.addEventListener("toggle",function(){
      try{localStorage.setItem("ipua-hist",hg.open?"1":"0")}catch(e){}
    });
  }
  /* --- 共用彈出選單管理（頭像／History…／模型選單共用一套定位與關閉邏輯）。
         同一顆按鈕再點一次＝收回（toggle）：記住 curAnchor，
         document 的關閉監聽也要放過 anchor 本身，不然按鈕的 click 還沒進來選單就先被關掉、
         接著又被重開 — 永遠收不回去。 --- */
  var curPop=null,curAnchor=null;
  function closePop(){if(curPop){curPop.remove();curPop=null;curAnchor=null;}}
  function openPop(anchor,build,alignUp){
    if(curPop&&curAnchor===anchor){closePop();return null;}
    closePop();
    curAnchor=anchor;
    var p=document.createElement("div");p.className="pop";
    build(p);
    document.body.appendChild(p);
    p.classList.add("open");
    var r=anchor.getBoundingClientRect();
    var pw=p.offsetWidth,ph=p.offsetHeight;
    var x=alignUp?r.left:Math.min(r.left,window.innerWidth-pw-8);
    if(x+pw>window.innerWidth-8)x=window.innerWidth-pw-8;
    if(x<8)x=8;
    var y=alignUp?(r.top-ph-8):(r.bottom+6);
    if(!alignUp&&y+ph>window.innerHeight-8)y=r.top-ph-6;
    if(y<8)y=8;
    p.style.left=x+"px";p.style.top=y+"px";
    curPop=p;
    return p;
  }
  document.addEventListener("click",function(e){
    if(curPop&&!curPop.contains(e.target)&&!(curAnchor&&curAnchor.contains(e.target)))closePop();
  },true);
  document.addEventListener("keydown",function(e){if(e.key==="Escape")closePop()});
  window.addEventListener("resize",closePop);
  function popItem(p,text,fn,danger){
    var b=document.createElement("button");
    b.type="button";b.className="pi"+(danger?" danger":"");b.textContent=text;
    b.addEventListener("click",function(ev){ev.stopPropagation();closePop();fn();});
    p.appendChild(b);
    return b;
  }
  /* 外殼彈出選單開放給 account.js／playground 用 */
  window.SBPOP={open:openPop,close:closePop,item:popItem,t:t};
  /* --- History（playground 歷史對話）：登入＋有 playground 服務才顯示 --- */
  var histBox=document.getElementById("sbHist"),histList=document.getElementById("sbHistList");
  var convs=[],activeConv=null,histOn=false;
  function isPg(){return location.pathname==="/playground"}
  function canHist(u){
    return !!(u&&(u.is_admin||(u.services||[]).indexOf("playground")>=0));
  }
  function api(path,opts){
    opts=opts||{};opts.headers=opts.headers||{};opts.cache="no-store";
    if(opts.json!==undefined){opts.method=opts.method||"POST";opts.headers["content-type"]="application/json";opts.body=JSON.stringify(opts.json);delete opts.json;}
    return fetch(path,opts).then(function(r){
      return r.json().catch(function(){return{}}).then(function(d){
        if(!r.ok)throw new Error(d.hint||d.error||("HTTP "+r.status));
        return d;
      });
    });
  }
  function loadHist(){
    api("/api/playground/conversations").then(function(d){
      convs=d.rows||[];histOn=true;
      histBox.classList.remove("hidden");
      renderHist();
    }).catch(function(){/* 讀不到就整區不顯示 */});
  }
  function renderHist(){
    if(!histOn||!histList)return;
    histList.innerHTML="";
    if(!convs.length){
      var em=document.createElement("div");em.className="sb-empty";em.textContent=t("hist.empty");
      histList.appendChild(em);return;
    }
    convs.forEach(function(c){
      var row=document.createElement("div");
      row.className="sb-conv"+(activeConv===c.id?" on":"");
      var tt=document.createElement("span");tt.className="tt";
      tt.textContent=c.title||t("hist.untitled");tt.title=c.title||"";
      row.appendChild(tt);
      var d=document.createElement("button");d.type="button";d.className="dots";
      d.textContent="\\u22ef";d.setAttribute("aria-label","\\u22ef");
      d.addEventListener("click",function(e){
        e.stopPropagation();
        openPop(d,function(p){
          popItem(p,t("hist.rename"),function(){renameConv(c)});
          popItem(p,t("hist.delete"),function(){deleteConv(c)},true);
        });
      });
      row.appendChild(d);
      row.addEventListener("click",function(){
        if(isPg()&&window.__pgOpenConv){window.__pgOpenConv(c.id);}
        else location.href="/playground#c="+encodeURIComponent(c.id);
      });
      histList.appendChild(row);
    });
  }
  function renameConv(c){
    var v=prompt(t("hist.title"),c.title||"");
    if(v==null)return;
    v=v.replace(/\\s+/g," ").trim();
    if(!v)return;
    api("/api/playground/conversations/"+c.id,{method:"PUT",json:{title:v}})
      .then(function(d){c.title=d.title||v;renderHist();})
      .catch(function(e){alert(String(e&&e.message||e))});
  }
  function deleteConv(c){
    if(!confirm(t("hist.confirm")))return;
    api("/api/playground/conversations/"+c.id,{method:"DELETE"}).then(function(){
      convs=convs.filter(function(x){return x.id!==c.id});
      if(activeConv===c.id){
        activeConv=null;
        if(window.__pgConvDeleted)window.__pgConvDeleted(c.id);
      }
      renderHist();
    }).catch(function(e){alert(String(e&&e.message||e))});
  }
  /* playground 頁用的橋接：refresh＝重抓列表、setActive＝標記目前對話 */
  window.SBH={
    refresh:function(){if(histOn)loadHist();},
    setActive:function(id){activeConv=id;renderHist();},
    enabled:function(){return histOn;}
  };
  /* account.js 抓到 /api/me 後廣播 ipua:me → 這裡決定要不要載 History */
  function onMe(u){if(u&&canHist(u))loadHist();}
  window.addEventListener("ipua:me",function(e){onMe(e&&e.detail&&e.detail.user)});
  if(window.__ipuaMe)onMe(window.__ipuaMe);
  /* New chat：在 playground 頁內就地清空（不重載），其他頁正常連過去 */
  var nc=document.getElementById("sbNewChat");
  if(nc)nc.addEventListener("click",function(e){
    if(isPg()&&window.__pgNewChat){e.preventDefault();window.__pgNewChat();}
  });
  /* --- 管理員工具（✎ 編輯模式）：登入過後台的裝置（localStorage 有金鑰）
         或本機開發才載入 /assets/adminbar.js；一般訪客完全不會下載這支程式 --- */
  try{
    if(localStorage.getItem("ipua-logs-token")||location.hostname==="localhost"||location.hostname==="127.0.0.1"){
      var abs=document.createElement("script");abs.src="${assetSrc("adminbar.js")}";document.head.appendChild(abs);
    }
  }catch(e){}
  applyI18n();
  applyTheme();
  applySb();
  /* 首幀後才允許過場動畫（不然側欄會在載入瞬間滑一下） */
  requestAnimationFrame(function(){requestAnimationFrame(function(){
    document.documentElement.classList.remove("noanim");
  })});
})();
`;
