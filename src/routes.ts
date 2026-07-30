// src/routes.ts — 路由表（v2.0.0 Phase D 建立；Phase F 起 handler 全面 TypeScript 化）。
// 註冊順序＝優先序（線性掃描，第一個命中者勝）。
// 每列 [樣式, { 方法: handler }]；ALL＝onRequest（所有方法，relay/vpn 轉發用）。
//
// 排序原則：靜態頁與 API 在前、單段動態（:id/:slug）居中、catch-all（*path）最後。
// 因為各路由的字面段幾乎不重疊，實際上只有 relay 的 *path 需要墊底。

import type { MethodMap } from "./router.js";

// —— 頂層頁面 ——
import { onRequestGet as home } from "./routes/index.js";
import { onRequestGet as feed } from "./routes/feed.js";
import { onRequestGet as sitemap } from "./routes/sitemap.js";
import { onRequestGet as adminPage } from "./routes/admin.js";
import { onRequestGet as apiDocs } from "./routes/api-docs.js";
import { onRequestGet as logsPage } from "./routes/logs.js";
import { onRequestGet as membersPage } from "./routes/members.js";
import { onRequestGet as settingsPage } from "./routes/settings.js";
import { onRequestGet as playgroundPage } from "./routes/playground.js";

// —— 內容頁 ——
import { onRequestGet as newsList } from "./routes/news/index.js";
import { onRequestGet as newsItem } from "./routes/news/[id].js";
import { onRequestGet as articlesList } from "./routes/articles/index.js";
import { onRequestGet as articlesItem } from "./routes/articles/[id].js";
import { onRequestGet as customPage } from "./routes/p/[slug].js";
import { onRequestGet as imgGet } from "./routes/img/[id].js";

// —— auth ——
import { onRequestGet as loginGet, onRequestPost as loginPost } from "./routes/auth/login.js";
import { onRequestGet as logoutGet, onRequestPost as logoutPost } from "./routes/auth/logout.js";
import { onRequestGet as authCallback } from "./routes/auth/callback.js";

// —— VPN（頁＋訂閱） ——
import { onRequestGet as vpnPage } from "./routes/vpn/index.js";
import { onRequestGet as vpnSub } from "./routes/vpn/sub/[token].js";

// —— relay 轉發（catch-all；也接 /relay 本身＝操作頁） ——
import { onRequest as relayAll } from "./routes/relay/[[path]].js";

// —— 公開 API ——
import { onRequestGet as openapiJson } from "./routes/openapi.js";
import { onRequestGet as apiHealth } from "./routes/api/health.js";
import { onRequestGet as apiWhoami } from "./routes/api/whoami.js";
import { onRequestGet as apiMe } from "./routes/api/me.js";
import { onRequestGet as apiMenu } from "./routes/api/menu.js";
import { onRequestGet as apiSettings } from "./routes/api/settings.js";
import { onRequestGet as apiLogs } from "./routes/api/logs.js";
import { onRequestPost as apiCspReport } from "./routes/api/csp-report.js";
import { onRequestGet as apiArticlesList } from "./routes/api/articles/index.js";
import { onRequestGet as apiArticleGet } from "./routes/api/articles/[id].js";
import { onRequestGet as apiPagesList } from "./routes/api/pages/index.js";
import { onRequestGet as apiPageGet } from "./routes/api/pages/[slug].js";
import { onRequestGet as apiRelayChannels } from "./routes/api/relay/channels.js";
import { onRequestGet as apiPgModels } from "./routes/api/playground/models.js";
import { onRequestPost as apiPgChat } from "./routes/api/playground/chat.js";
import { onRequestGet as apiPgConvList } from "./routes/api/playground/conversations/index.js";
import {
  onRequestGet as apiPgConvGet,
  onRequestPut as apiPgConvPut,
  onRequestDelete as apiPgConvDel
} from "./routes/api/playground/conversations/[id].js";
import { onRequestPost as apiPgFileUp } from "./routes/api/playground/files/index.js";
import { onRequestGet as apiPgFileGet } from "./routes/api/playground/files/[id].js";

// —— 會員自助 API ——
import { onRequestPost as acctKeyPost, onRequestDelete as acctKeyDel } from "./routes/api/account/key.js";
import { onRequestPost as acctVpnToken } from "./routes/api/account/vpn-token.js";
import { onRequestPost as acctLogoutAll } from "./routes/api/account/logout-all.js";

// —— 管理員 API ——
import { onRequestGet as admApidoc } from "./routes/api/admin/apidoc.js";
import { onRequestGet as admErrorsGet, onRequestDelete as admErrorsDel } from "./routes/api/admin/errors.js";
import { onRequestPost as admMedia } from "./routes/api/admin/media.js";
import { onRequestPut as admMenu } from "./routes/api/admin/menu.js";
import { onRequestGet as admSettingsGet, onRequestPut as admSettings } from "./routes/api/admin/settings.js";
import { onRequestGet as admStats } from "./routes/api/admin/stats.js";
import { onRequestGet as admConvList } from "./routes/api/admin/conversations/index.js";
import { onRequestGet as admConvGet } from "./routes/api/admin/conversations/[id].js";
import { onRequestGet as admPricesGet, onRequestPut as admPricesPut } from "./routes/api/admin/prices.js";
import {
  onRequestGet as admArtList,
  onRequestPost as admArtCreate
} from "./routes/api/admin/articles/index.js";
import {
  onRequestGet as admArtGet,
  onRequestPut as admArtPut,
  onRequestDelete as admArtDel
} from "./routes/api/admin/articles/[id].js";
import {
  onRequestGet as admPagesList,
  onRequestPost as admPagesCreate
} from "./routes/api/admin/pages/index.js";
import {
  onRequestGet as admPageGet,
  onRequestPut as admPagePut,
  onRequestDelete as admPageDel
} from "./routes/api/admin/pages/[key].js";
import { onRequestGet as admUsersList } from "./routes/api/admin/users/index.js";
import { onRequestPut as admUserPut, onRequestDelete as admUserDel } from "./routes/api/admin/users/[id].js";
import {
  onRequestGet as admRelayChList,
  onRequestPost as admRelayChCreate
} from "./routes/api/admin/relay/channels/index.js";
import {
  onRequestPut as admRelayChPut,
  onRequestDelete as admRelayChDel
} from "./routes/api/admin/relay/channels/[id].js";
import {
  onRequestGet as admVpnChList,
  onRequestPost as admVpnChCreate
} from "./routes/api/admin/vpn/channels/index.js";
import {
  onRequestPut as admVpnChPut,
  onRequestDelete as admVpnChDel
} from "./routes/api/admin/vpn/channels/[id].js";

export const ROUTES: Array<[string, MethodMap]> = [
  // 管理員內容 API（放最前面，確保 :id/:slug 段不被別的規則搶）
  ["/api/admin/apidoc", { GET: admApidoc }],
  ["/api/admin/errors", { GET: admErrorsGet, DELETE: admErrorsDel }],
  ["/api/admin/media", { POST: admMedia }],
  ["/api/admin/menu", { PUT: admMenu }],
  ["/api/admin/settings", { GET: admSettingsGet, PUT: admSettings }],
  ["/api/admin/stats", { GET: admStats }],
  ["/api/admin/conversations", { GET: admConvList }],
  ["/api/admin/conversations/:id", { GET: admConvGet }],
  ["/api/admin/prices", { GET: admPricesGet, PUT: admPricesPut }],
  ["/api/admin/articles", { GET: admArtList, POST: admArtCreate }],
  ["/api/admin/articles/:id", { GET: admArtGet, PUT: admArtPut, DELETE: admArtDel }],
  ["/api/admin/pages", { GET: admPagesList, POST: admPagesCreate }],
  ["/api/admin/pages/:key", { GET: admPageGet, PUT: admPagePut, DELETE: admPageDel }],
  ["/api/admin/users", { GET: admUsersList }],
  ["/api/admin/users/:id", { PUT: admUserPut, DELETE: admUserDel }],
  ["/api/admin/relay/channels", { GET: admRelayChList, POST: admRelayChCreate }],
  ["/api/admin/relay/channels/:id", { PUT: admRelayChPut, DELETE: admRelayChDel }],
  ["/api/admin/vpn/channels", { GET: admVpnChList, POST: admVpnChCreate }],
  ["/api/admin/vpn/channels/:id", { PUT: admVpnChPut, DELETE: admVpnChDel }],

  // 會員自助 API
  ["/api/account/key", { POST: acctKeyPost, DELETE: acctKeyDel }],
  ["/api/account/vpn-token", { POST: acctVpnToken }],
  ["/api/account/logout-all", { POST: acctLogoutAll }],

  // 公開 API
  ["/openapi.json", { GET: openapiJson }],
  ["/api/health", { GET: apiHealth }],
  ["/api/whoami", { GET: apiWhoami }],
  ["/api/me", { GET: apiMe }],
  ["/api/menu", { GET: apiMenu }],
  ["/api/settings", { GET: apiSettings }],
  ["/api/logs", { GET: apiLogs }],
  ["/api/csp-report", { POST: apiCspReport }],
  ["/api/articles", { GET: apiArticlesList }],
  ["/api/articles/:id", { GET: apiArticleGet }],
  ["/api/pages", { GET: apiPagesList }],
  ["/api/pages/:slug", { GET: apiPageGet }],
  ["/api/relay/channels", { GET: apiRelayChannels }],
  ["/api/playground/models", { GET: apiPgModels }],
  ["/api/playground/chat", { POST: apiPgChat }],
  ["/api/playground/conversations", { GET: apiPgConvList }],
  ["/api/playground/conversations/:id", { GET: apiPgConvGet, PUT: apiPgConvPut, DELETE: apiPgConvDel }],
  ["/api/playground/files", { POST: apiPgFileUp }],
  ["/api/playground/files/:id", { GET: apiPgFileGet }],

  // auth
  ["/auth/login", { GET: loginGet, POST: loginPost }],
  ["/auth/logout", { GET: logoutGet, POST: logoutPost }],
  ["/auth/callback", { GET: authCallback }],

  // 頂層頁面
  ["/", { GET: home }],
  ["/feed", { GET: feed }],
  ["/sitemap", { GET: sitemap }],
  ["/admin", { GET: adminPage }],
  ["/api-docs", { GET: apiDocs }],
  ["/logs", { GET: logsPage }],
  ["/members", { GET: membersPage }],
  ["/settings", { GET: settingsPage }],
  ["/playground", { GET: playgroundPage }],

  // 內容頁（單段動態）
  ["/news", { GET: newsList }],
  ["/news/:id", { GET: newsItem }],
  ["/articles", { GET: articlesList }],
  ["/articles/:id", { GET: articlesItem }],
  ["/p/:slug", { GET: customPage }],
  ["/img/:id", { GET: imgGet }],

  // VPN
  ["/vpn", { GET: vpnPage }],
  ["/vpn/sub/:token", { GET: vpnSub }],

  // relay catch-all（墊底）：也接 /relay 本身＝操作頁
  ["/relay/*path", { ALL: relayAll }],
  ["/relay", { ALL: relayAll }]
];
