// GET /settings — 管理員設定（2026-07-17 UI 改版新增）。
// 側邊欄「管理員」區統整後的三頁之一（管理員設定／訪客紀錄／API 文件）。
// 把以前散在各處、或只有 API 能改的設定全部收進來：
//   網站（站名、聯絡連結）、側邊欄選單（開編輯模式）、Playground（全員開放＋體驗模式 7 鍵）、
//   配額與限流（全域預設 3 鍵）、中轉計量開關、模型定價表、自訂頁面管理、管理捷徑。
// 驗證與 /admin、/logs 同款：管理員 Google 登入 cookie 或管理金鑰（LOGS_TOKEN）擇一；
// 資料全部走既有的 /api/admin/*（settings GET/PUT、prices、pages、relay/channels）。
import { html, pageShell, ADMIN_CSS } from "../lib/site.js";
import { getChromeFor } from "../lib/chrome.js";
import type { RouteCtx } from "../types.js";

const PAGE_CSS = `
  .wrap{max-width:760px}
  .field{margin-bottom:14px}
  .field label{display:block;font-size:12px;font-weight:700;color:var(--muted);letter-spacing:.06em;margin-bottom:6px}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:0 12px}
  .grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:0 12px}
  @media(max-width:560px){.grid2,.grid3{grid-template-columns:1fr}}
  /* 開關列：左說明右 chip（樣式同 /members 的服務開關） */
  .swrow{display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px dashed var(--line)}
  .swrow:last-child{border-bottom:0}
  .swrow .g{flex:1;min-width:0}
  .swrow .t1{font-weight:600;font-size:14px}
  .swrow .t2{font-size:12px;color:var(--muted);margin-top:2px;line-height:1.65}
  .tgl{border:1px dashed var(--line);background:transparent;color:var(--muted);border-radius:16px;padding:6px 14px;font-size:12.5px;font-weight:700;cursor:pointer;font-family:inherit;transition:.15s;white-space:nowrap;flex:0 0 auto}
  .tgl:hover{border-color:var(--line2);color:var(--fg)}
  .tgl.on{background:var(--accent);color:var(--accent-fg);border:1px solid var(--line2)}
  .tgl:disabled{opacity:.4;cursor:default}
  .saverow{display:flex;gap:10px;align-items:center;margin-top:2px}
  .savemsg{font-size:12.5px;color:var(--muted)}
  .warnnote{font-size:12.5px;border:1px solid var(--line2);border-radius:8px;padding:9px 12px;margin:10px 0 0;line-height:1.7}
  /* 定價表 */
  .prow{display:grid;grid-template-columns:1fr 88px 88px 1fr 34px;gap:8px;margin-bottom:8px;align-items:center}
  .prow input{padding:9px 10px;font-size:13px}
  .prow .del{width:34px;height:34px;min-width:34px;padding:0;border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:8px;font-size:12px;cursor:pointer;font-family:inherit}
  .prow .del:hover{border-color:#c33;color:#c33}
  .phead{display:grid;grid-template-columns:1fr 88px 88px 1fr 34px;gap:8px;margin-bottom:6px;font-size:11px;color:var(--muted);font-weight:700;letter-spacing:.05em;text-transform:uppercase}
  @media(max-width:640px){
    .prow,.phead{grid-template-columns:1fr 74px 74px 34px}
    .phead .h-note,.prow .in-note{display:none}
  }
  /* 自訂頁面列表 */
  .plist .swrow .t2 a{color:var(--muted)}
  .rowbtns{display:flex;gap:6px;flex:0 0 auto;flex-wrap:wrap;justify-content:flex-end}
  .mini{border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:7px;padding:6px 11px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;white-space:nowrap;transition:.15s}
  .mini:hover{border-color:var(--line2)}
  .mini.danger:hover{border-color:#c33;color:#c33}
  .chip{display:inline-block;font-size:10.5px;font-weight:700;border-radius:20px;padding:2px 9px;border:1px solid var(--line);color:var(--muted);vertical-align:1px}
  .chip.pub{background:var(--accent);color:var(--accent-fg);border-color:var(--line2)}
  /* 附件儲存（唯讀狀態磚） */
  .stogrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(148px,1fr));gap:10px}
  .stobox{border:1px solid var(--line);border-radius:9px;padding:10px 12px}
  .stobox .k{font-size:11px;color:var(--muted);font-weight:700;letter-spacing:.04em}
  .stobox .v{font-size:15px;font-weight:700;margin-top:3px;word-break:break-word}
  .stobox .s{font-size:11.5px;color:var(--muted);margin-top:3px;line-height:1.55}
  .meter{height:5px;border-radius:3px;background:var(--line);overflow:hidden;margin-top:8px}
  .meter i{display:block;height:100%;background:var(--accent);border-radius:3px}
  .meter.warn i{background:#c93}
  /* 管理捷徑 */
  .quick{display:flex;gap:8px;flex-wrap:wrap}
  /* 頁面編輯彈窗的內文欄 */
  #pgBody{min-height:220px;font-family:ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace;font-size:13px}
  .flash{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:var(--accent);color:var(--accent-fg);padding:10px 18px;border-radius:24px;font-size:13px;font-weight:600;box-shadow:0 8px 28px rgba(0,0,0,.24);opacity:0;transition:opacity .2s,transform .2s;pointer-events:none;z-index:200}
  .flash.show{opacity:1;transform:translateX(-50%) translateY(-4px)}
`;

const BODY = `
<!-- 金鑰驗證（與 /admin、/logs 同一把管理金鑰） -->
<section id="gate" class="card hidden">
  <div class="card-title">管理員驗證</div>
  <p class="hint">這一頁只有管理員能用。用管理員 Google 帳號 <a href="/auth/login?next=/settings">登入</a>，或輸入管理金鑰（與訪客紀錄相同那一把）；金鑰只存在這台裝置的瀏覽器裡。</p>
  <form id="gateForm" class="query">
    <input id="tokenInput" type="password" autocomplete="off" placeholder="管理金鑰">
    <button type="submit">進入</button>
  </form>
  <div id="gateErr" class="error hidden">⚠ 金鑰不正確，請再試一次。</div>
</section>

<section id="main" class="hidden">

  <!-- 網站 -->
  <div class="card">
    <div class="card-title">網站</div>
    <div class="field">
      <label for="fBrand">網站名稱</label>
      <input id="fBrand" type="text" autocomplete="off" maxlength="60">
      <p class="hint" style="margin-bottom:0">用在分頁標題、分享卡、RSS。留空＝還原預設（正式網址主機名）。</p>
    </div>
    <div class="field">
      <label for="fContact">聯絡連結</label>
      <input id="fContact" type="text" autocomplete="off" placeholder="https://…（Telegram、mailto 頁、表單…）">
      <p class="hint" style="margin-bottom:0">顯示在側邊欄左下角與會員頁登入閘門的「聯絡管理員」鈕。留空＝不顯示。</p>
    </div>
    <div class="saverow"><button id="saveSite" class="primary" type="button">儲存</button><span id="msgSite" class="savemsg"></span></div>
  </div>

  <!-- 側邊欄選單 -->
  <div class="card">
    <div class="card-title">側邊欄選單</div>
    <p class="hint">選單項目（分類、連結、排序、中英名稱）在側邊欄裡直接編輯 — 打開 ☰ 選單，按「選單」旁的 ✎。</p>
    <div class="saverow"><button id="menuEditBtn" class="ghost" type="button">✎ 編輯選單</button></div>
  </div>

  <!-- Playground -->
  <div class="card">
    <div class="card-title">Playground</div>
    <div class="swrow">
      <div class="g">
        <div class="t1">開放給所有登入會員</div>
        <div class="t2">開啟後任何登入會員不用逐一批准就能用 Playground（封鎖中的帳號照樣擋）；關閉＝回到 /members 逐人批准。</div>
      </div>
      <button id="tglPgOpen" class="tgl" type="button">—</button>
    </div>
    <div class="swrow">
      <div class="g">
        <div class="t1">體驗模式（未登入試聊）</div>
        <div class="t2">開啟後未登入訪客可直接在 /playground 試聊。<b>要同時選好下面的渠道才會生效</b>；試聊的對話會進「訪客紀錄 → 對話紀錄」給你看（訪客自己看不到歷史）、三道限流保險。</div>
        <div id="demoState" class="t2"></div>
      </div>
      <button id="tglDemo" class="tgl" type="button">—</button>
    </div>
    <div style="margin-top:12px">
      <div class="grid2">
        <div class="field">
          <label for="fDemoCh">體驗渠道（必選才生效）</label>
          <select id="fDemoCh"><option value="">（未選 — 體驗模式不生效）</option></select>
        </div>
        <div class="field">
          <label for="fDemoModels">模型白名單（逗號分隔，空＝該渠道全部）</label>
          <input id="fDemoModels" type="text" autocomplete="off" placeholder="gpt-4o-mini, gemini-2.0-flash">
        </div>
      </div>
      <div class="grid2">
        <div class="field">
          <label for="fDemoPerMin">每 IP 每分鐘上限</label>
          <input id="fDemoPerMin" type="text" inputmode="numeric" autocomplete="off">
        </div>
        <div class="field">
          <label for="fDemoPerIpDay">每 IP 每日上限</label>
          <input id="fDemoPerIpDay" type="text" inputmode="numeric" autocomplete="off">
        </div>
      </div>
      <div class="grid2">
        <div class="field">
          <label for="fDemoGlobalDay">全站每日上限（燒錢保險）</label>
          <input id="fDemoGlobalDay" type="text" inputmode="numeric" autocomplete="off">
        </div>
        <div class="field">
          <label for="fDemoMaxTokens">回覆 token 上限</label>
          <input id="fDemoMaxTokens" type="text" inputmode="numeric" autocomplete="off">
        </div>
      </div>
      <p class="hint">數字欄留空＝用內建預設（欄位裡的灰字）。</p>
      <div class="saverow"><button id="saveDemo" class="primary" type="button">儲存體驗模式設定</button><span id="msgDemo" class="savemsg"></span></div>
    </div>
    <div class="swrow" style="margin-top:14px;border-top:1px solid var(--line);padding-top:14px">
      <div class="g">
        <div class="t1">Dumb mode（鎖定單一隱藏模型）</div>
        <div class="t2">開啟後所有會員在 Playground 只能用下面指定的模型：模型選單整個消失、對話紀錄也查不到模型名稱 — 會員不知道也改不了正在用什麼（你自己不受限，照常有完整選單）。<b>要同時選好模型才會生效</b>。<b>體驗模式也會跟著隱藏模型選單</b>，但訪客實際跑的仍是體驗模式自己設定的渠道與模型（白名單第一個），成本上限不受影響。不影響 API 中轉。</div>
        <div id="dumbState" class="t2"></div>
      </div>
      <button id="tglDumb" class="tgl" type="button">—</button>
    </div>
    <div style="margin-top:8px">
      <div class="field">
        <label for="fDumbModel">指定模型（渠道 × 模型，必選才生效）</label>
        <select id="fDumbModel"><option value="">（未選 — Dumb mode 不生效）</option></select>
      </div>
      <div class="saverow"><button id="saveDumb" class="primary" type="button">儲存 Dumb mode 設定</button><span id="msgDumb" class="savemsg"></span></div>
    </div>
  </div>

  <!-- VPN 顯示（2026-07-22 v2.2） -->
  <div class="card">
    <div class="card-title">VPN</div>
    <div class="swrow">
      <div class="g">
        <div class="t1">對外展示</div>
        <div class="t2">開啟＝側邊欄選單與 /vpn 頁對<b>所有訪客</b>可見（沒批准的人進去會看到登入／等待批准畫面；訂閱本身還是要你批准才能用）。關閉＝維持隱形：只有你和被批准 vpn 服務的會員知道這個服務存在。</div>
      </div>
      <button id="tglVpnPub" class="tgl" type="button">—</button>
    </div>
  </div>

  <!-- Playground 預設系統提示詞（2026-07-21）：一次管全部渠道 -->
  <div class="card">
    <div class="card-title">Playground 預設系統提示詞</div>
    <p class="hint">所有<b>沒有自己填</b>系統提示詞的渠道都套這一段 — 改這裡等於一次改完全部渠道，不必逐個開視窗。某個渠道要不一樣的人設，就到 /relay 的「渠道管理」單獨填，那個渠道以自己填的為準（不會兩段疊加）。</p>
    <div class="field">
      <label for="fPgSys">預設系統提示詞</label>
      <textarea id="fPgSys" rows="6" autocomplete="off"></textarea>
      <p class="hint" style="margin-bottom:0">留空＝還原程式內建的那段（欄位裡的灰字就是它）。最長 4000 字。<b>只作用在 /playground</b>；API 中轉（/relay）是透明代理，不會注入任何提示詞。</p>
    </div>
    <div class="saverow"><button id="savePgSys" class="primary" type="button">儲存</button><span id="msgPgSys" class="savemsg"></span></div>
  </div>

  <!-- 配額與限流 -->
  <div class="card">
    <div class="card-title">配額與限流（全域預設）</div>
    <p class="hint">對所有會員生效的預設值；個人覆寫在 /members 各會員的「配額」鈕。管理員帳號完全不吃配額。留空＝用內建預設（灰字）。</p>
    <div class="grid3">
      <div class="field">
        <label for="fQuotaRelay">中轉每日請求數</label>
        <input id="fQuotaRelay" type="text" inputmode="numeric" autocomplete="off">
      </div>
      <div class="field">
        <label for="fQuotaPg">Playground 每日訊息數</label>
        <input id="fQuotaPg" type="text" inputmode="numeric" autocomplete="off">
      </div>
      <div class="field">
        <label for="fRlMin">每分鐘請求數上限</label>
        <input id="fRlMin" type="text" inputmode="numeric" autocomplete="off">
      </div>
    </div>
    <div class="saverow"><button id="saveQuota" class="primary" type="button">儲存</button><span id="msgQuota" class="savemsg"></span></div>
  </div>

  <!-- 附件儲存（唯讀） -->
  <div class="card">
    <div class="card-title">附件儲存</div>
    <p class="hint">聊天附件（圖片）存在哪、還剩多少。<b>這張卡只顯示現況，不能在這裡改</b> — 三層容量要調請用 API（<code>PUT /api/admin/settings</code> 的 <code>pgfile_max_kb</code>／<code>pgfile_user_mb</code>／<code>pgfile_total_mb</code>），而且只能往下調：上限寫死在程式裡，免得手滑越過 Cloudflare 免費額度。</p>
    <div id="stoBox"></div>
  </div>

  <!-- 中轉計量 -->
  <div class="card">
    <div class="card-title">API 中轉</div>
    <div class="swrow">
      <div class="g">
        <div class="t1">計量（usage 掃描與請求紀錄）</div>
        <div class="t2">關閉＝中轉退回純直通（不掃 token 用量、不寫 req_log），是計量出怪問題時的免部署保險 — <b>平常不要動</b>。</div>
      </div>
      <button id="tglMeter" class="tgl" type="button">—</button>
    </div>
  </div>

  <!-- Telegram 告警 -->
  <div class="card">
    <div class="card-title">Telegram 告警</div>
    <p class="hint">每 5 分鐘掃站內錯誤（errlog）增量，打包推播到 Telegram。跟 @BotFather 建 bot 拿 token、跟 bot 說句話後用 getUpdates 拿 chat id（詳見 ADMIN.md）。這裡的設定存資料庫並<b>優先於</b> Cloudflare secrets。</p>
    <div id="tgState" class="hint"></div>
    <div class="grid2">
      <div class="field">
        <label for="fTgToken">Bot token</label>
        <input id="fTgToken" type="password" autocomplete="off">
      </div>
      <div class="field">
        <label for="fTgChat">Chat ID</label>
        <input id="fTgChat" type="text" autocomplete="off" placeholder="例：123456789">
      </div>
    </div>
    <div class="saverow">
      <button id="saveTg" class="primary" type="button">儲存</button>
      <button id="clearTg" class="ghost danger" type="button">清除</button>
      <span id="msgTg" class="savemsg"></span>
    </div>
  </div>

  <!-- 模型定價 -->
  <div class="card">
    <div class="card-title">模型定價（成本記帳）</div>
    <p class="hint">讓用量統計把 token 換算成估算美元成本；只影響報告顯示，不影響配額。pattern 尾端 <span class="mono">*</span> ＝前綴匹配（例 <span class="mono">gpt-4o*</span>）。</p>
    <div class="phead"><span>模型 pattern</span><span>入/百萬$</span><span>出/百萬$</span><span class="h-note">備註</span><span></span></div>
    <div id="priceRows"></div>
    <div class="saverow">
      <button id="priceAdd" class="ghost" type="button">＋ 加一列</button>
      <button id="savePrices" class="primary" type="button">儲存定價表</button>
      <span id="msgPrices" class="savemsg"></span>
    </div>
  </div>

  <!-- 自訂頁面 -->
  <div class="card">
    <div class="card-title">自訂頁面（/p/…）</div>
    <p class="hint">獨立公開頁面，適合「關於本站」「隱私權政策」這類內容；發佈後上線在 /p/代稱，可再到選單編輯掛進側邊欄。</p>
    <div id="pageList" class="plist"></div>
    <div class="saverow"><button id="pageAdd" class="ghost" type="button">＋ 新增頁面</button></div>
  </div>

  <!-- 管理捷徑 -->
  <div class="card">
    <div class="card-title">其他管理頁</div>
    <div class="quick">
      <a class="ghost" href="/admin">文章管理</a>
      <a class="ghost" href="/members">成員管理</a>
      <a class="ghost" href="/logs">訪客紀錄</a>
      <a class="ghost" href="/api-docs">API 文件</a>
    </div>
  </div>

</section>`;

// 頁面行為：讀 GET /api/admin/settings 當編輯初值；各卡各自儲存（帶哪鍵改哪鍵）。
const PAGE_JS = `
(function(){
  "use strict";
  var $=function(id){return document.getElementById(id);};
  var token="";try{token=localStorage.getItem("ipua-logs-token")||"";}catch(e){}
  var st=null,channels=[],prices=[],pages=[];

  function api(path,opts){
    opts=opts||{};opts.headers=opts.headers||{};
    if(token)opts.headers["Authorization"]="Bearer "+token;
    if(opts.json!==undefined){opts.method=opts.method||"POST";opts.headers["content-type"]="application/json";opts.body=JSON.stringify(opts.json);delete opts.json;}
    return fetch(path,opts).then(function(r){
      if(r.status===401)throw{auth:true};
      return r.json().catch(function(){return{};}).then(function(d){
        if(!r.ok)throw new Error(d.hint||d.error||("HTTP "+r.status));
        return d;
      });
    });
  }
  function flash(msg){
    var f=$("sflash");
    if(!f){f=document.createElement("div");f.className="flash";f.id="sflash";document.body.appendChild(f);}
    f.textContent=msg;f.classList.add("show");
    clearTimeout(f._t);f._t=setTimeout(function(){f.classList.remove("show");},1800);
  }
  function err(e){flash(e&&e.auth?"登入已失效 — 重新整理後再驗證一次":("失敗："+((e&&e.message)||e)));}

  /* ===== 驗證閘門（同 /admin、/logs）===== */
  function showGate(bad){
    $("gate").classList.remove("hidden");$("main").classList.add("hidden");
    $("gateErr").classList.toggle("hidden",!bad);
    $("tokenInput").focus();
  }
  $("gateForm").addEventListener("submit",function(e){
    e.preventDefault();
    token=$("tokenInput").value.trim();
    if(!token)return;
    boot(true);
  });

  function boot(fromGate){
    Promise.all([
      api("/api/admin/settings"),
      api("/api/admin/relay/channels"),
      api("/api/admin/prices"),
      api("/api/admin/pages")
    ]).then(function(rs){
      st=rs[0];channels=rs[1].rows||[];prices=rs[2].items||[];pages=rs[3].rows||[];
      if(fromGate){try{localStorage.setItem("ipua-logs-token",token);}catch(e){}}
      $("gate").classList.add("hidden");$("main").classList.remove("hidden");
      fill();
    }).catch(function(e){
      if(e&&e.auth)showGate(!!fromGate);
      else{flash("讀取失敗："+((e&&e.message)||e));}
    });
  }

  /* ===== 填值與渲染 ===== */
  function numVal(v){return v==null?"":String(v);}
  function fill(){
    $("fBrand").value=st.custom?st.brand:"";
    $("fBrand").placeholder=st.custom?"":st.brand;
    $("fContact").value=st.contact_url||"";
    paintTgl($("tglPgOpen"),st.pg_open);
    paintTgl($("tglDemo"),st.demo_mode);
    paintTgl($("tglDumb"),st.dumb_mode);
    paintTgl($("tglVpnPub"),st.vpn_public);
    paintTgl($("tglMeter"),st.relay_meter);
    demoStateNote();
    dumbStateNote();
    fillDumbSel();
    var sel=$("fDemoCh");
    while(sel.options.length>1)sel.remove(1);
    channels.forEach(function(c){
      var o=document.createElement("option");
      o.value=c.slug;o.textContent=c.name+"（"+c.slug+"）"+(c.enabled?"":"（停用中）");
      if(st.demo_channel===c.slug)o.selected=true;
      sel.appendChild(o);
    });
    if(st.demo_channel&&!channels.some(function(c){return c.slug===st.demo_channel;})){
      var o2=document.createElement("option");
      o2.value=st.demo_channel;o2.textContent=st.demo_channel+"（已不存在）";o2.selected=true;
      sel.appendChild(o2);
    }
    $("fDemoModels").value=st.demo_models||"";
    // 預設系統提示詞：欄位放「有沒有自訂」，灰字放程式內建那段（留空時實際會送出的內容）
    $("fPgSys").value=st.pg_default_system||"";
    $("fPgSys").placeholder=(st.defaults||{}).pg_default_system||"";
    var D=st.defaults||{};
    [["fDemoPerMin","demo_per_min"],["fDemoPerIpDay","demo_per_ip_day"],
     ["fDemoGlobalDay","demo_global_day"],["fDemoMaxTokens","demo_max_tokens"],
     ["fQuotaRelay","quota_relay_day"],["fQuotaPg","quota_pg_day"],["fRlMin","rl_per_min"]].forEach(function(p){
      $(p[0]).value=numVal(st[p[1]]);
      // 內建預設 0 的鍵（回覆 token 上限）意思是「不壓長度」— 灰字要說人話，不能印「內建預設 0」
      $(p[0]).placeholder=D[p[1]]==null?"":(D[p[1]]>0?("內建預設 "+D[p[1]]):"不限");
    });
    fillTg();
    renderStorage();
    renderPrices();
    renderPages();
  }

  /* 附件儲存卡 —— 刻意做成唯讀（2026-07-30 站長拍板）。
     三層容量的天花板跟著儲存模式變（純 D1 1464KB／R2 10MB…），做成輸入框就得把
     「為什麼打 8192 會被擋」整套解釋塞進 UI；而那幾個數字一年動不到一次，
     真正每個月想看一眼的是「免費額度用到哪了」。所以這裡只顯示，改值走 API。 */
  function tile(k,v,sub,pct){
    var d=document.createElement("div");d.className="stobox";
    var a=document.createElement("div");a.className="k";a.textContent=k;d.appendChild(a);
    var b=document.createElement("div");b.className="v";b.textContent=v;d.appendChild(b);
    if(sub){var c=document.createElement("div");c.className="s";c.textContent=sub;d.appendChild(c);}
    if(pct!=null&&isFinite(pct)){
      var m=document.createElement("div");m.className="meter"+(pct>=80?" warn":"");
      var i=document.createElement("i");
      /* 至少 2% 才畫得出來 —— 0% 的空條看起來像壞掉，而不是「還沒用」 */
      i.style.width=Math.max(2,Math.min(100,pct))+"%";
      m.appendChild(i);d.appendChild(m);
    }
    return d;
  }
  /* 千分位 —— 900000 跟 9000000 用肉眼分不出差一個零，而這兩個數字就差 10 倍 */
  function num(n){return String(n).replace(/\\B(?=(\\d{3})+(?!\\d))/g,",");}
  function kbTxt(kb){return kb>=1024?((Math.round(kb/102.4)/10)+"MB"):(kb+"KB");}
  function mbTxt(mb){return mb>=1024?((Math.round(mb/102.4)/10)+"GB"):(mb+"MB");}
  function renderStorage(){
    var box=$("stoBox");if(!box)return;
    box.textContent="";
    var s=st&&st.storage;
    if(!s){box.appendChild(document.createTextNode("（讀不到儲存資訊）"));return;}
    var r2=s.mode==="r2",L=s.limits||{},u=s.used||{},o=s.ops||{},F=s.free||{},P=s.plan||{};
    var g=document.createElement("div");g.className="stogrid";

    g.appendChild(tile("儲存模式",r2?"R2":"純 D1",
      r2?"內容存 R2 桶，D1 只留中繼資料與鍵名":"內容存 D1 的 b64 欄位（沒有 R2 綁定）"));
    g.appendChild(tile("單檔上限",kbTxt(L.maxKb||0),
      st.pgfile_max_kb==null?"內建預設":"已自訂（內建 "+kbTxt((st.defaults||{}).pgfile_max_kb||0)+"）"));
    g.appendChild(tile("每人上限",mbTxt(L.userMb||0),st.pgfile_user_mb==null?"內建預設":"已自訂"));
    g.appendChild(tile("全站上限",mbTxt(L.totalMb||0),
      (u.filesRawMb!=null?("已用 "+mbTxt(u.filesRawMb)+"（原始大小）"):"")+
      (r2?" · 等於 R2 裡的 "+mbTxt(Math.ceil((L.totalMb||0)*4/3))+"（base64 脹 4/3）":""),
      L.totalMb?Math.round(((u.filesRawMb||0)/L.totalMb)*100):null));

    if(r2){
      g.appendChild(tile("R2 空間",mbTxt(u.r2TotalMb||0)+" / "+mbTxt(F.storageMb||0),
        "附件 "+mbTxt(u.r2FilesMb||0)+" · 備份 "+(u.backupMb==null?"待每日排程量測":mbTxt(u.backupMb)),
        u.r2Pct));
      g.appendChild(tile("本月寫入 (Class A)",num(o.a||0)+" 次",
        "預算 "+num(P.classA||0)+" / 免費額度 "+num(F.classA||0)+"。用完新檔自動改存 D1",o.aPct));
      g.appendChild(tile("本月讀取 (Class B)",num(o.b||0)+" 次",
        "預算 "+num(P.classB||0)+" / 免費額度 "+num(F.classB||0)+"。用完舊圖顯示佔位",o.bPct));
    }
    box.appendChild(g);

    var n=document.createElement("p");n.className="hint";n.style.marginBottom="0";n.style.marginTop="12px";
    n.textContent=r2
      ?"任一項到 80% 會寫 errlog、由 Telegram 告警帶出來。每日排程會量真實用量再從最舊的附件開始回收，所以這幾條線是自己會收斂的。"
      :"綁上 R2（wrangler.toml 的 FILES）就會切到 R2 模式，單檔上限自動放寬到 5MB；舊檔照樣讀得到，不必搬資料。";
    box.appendChild(n);
  }
  // Telegram 卡：token 只顯示遮罩提示（明文伺服器不回）；欄位留空＝保留現值
  function fillTg(){
    $("fTgToken").value="";
    $("fTgToken").placeholder=st.tg_token_set?("（留空＝不變；目前 "+st.tg_token_hint+"）"):"123456:ABC…（@BotFather 給的）";
    $("fTgChat").value=st.tg_chat_id||"";
    var n=$("tgState");
    if(st.tg_active)n.textContent="✓ 告警生效中"+(st.tg_token_set?"（網頁設定）":"（Cloudflare secrets）")+"。";
    else if(st.tg_token_set||st.tg_chat_id)n.textContent="⚠ 只設定了一半（token 與 chat id 都要有）— 目前不會發送。";
    else n.textContent="尚未設定 — 目前不會發送告警。";
  }
  function paintTgl(btn,on){
    btn.classList.toggle("on",!!on);
    btn.textContent=(on?"✓ 開啟":"關閉");
    btn.disabled=false;
  }
  function demoStateNote(){
    var n=$("demoState");
    if(st.demo_mode&&!st.demo_channel){n.textContent="⚠ 開關已開但還沒選渠道 — 目前不會生效。";n.style.color="";}
    else if(st.demo_mode&&st.demo_channel){n.textContent="✓ 生效中（渠道："+st.demo_channel+"）。";}
    else n.textContent="";
  }
  function dumbStateNote(){
    var n=$("dumbState");
    if(st.dumb_mode&&!(st.dumb_channel&&st.dumb_model)){n.textContent="⚠ 開關已開但還沒指定模型 — 目前不會生效。";}
    else if(st.dumb_mode){n.textContent="✓ 生效中（會員被鎖定在 "+st.dumb_model+"｜"+st.dumb_channel+"，且看不到這個資訊）。";}
    else n.textContent="";
  }
  // Dumb mode 的模型下拉：列出所有啟用渠道的所有模型（值＝slug|model）
  function fillDumbSel(){
    var sel=$("fDumbModel");
    while(sel.options.length>1)sel.remove(1);
    var cur=(st.dumb_channel&&st.dumb_model)?(st.dumb_channel+"|"+st.dumb_model):"";
    var has=false;
    channels.forEach(function(c){
      (c.models||[]).forEach(function(m){
        var o=document.createElement("option");
        o.value=c.slug+"|"+m;
        o.textContent=m+"｜"+c.name+(c.enabled?"":"（渠道停用中）");
        if(o.value===cur){o.selected=true;has=true;}
        sel.appendChild(o);
      });
    });
    if(cur&&!has){
      var o2=document.createElement("option");
      o2.value=cur;o2.textContent=st.dumb_model+"｜"+st.dumb_channel+"（已不存在）";o2.selected=true;
      sel.appendChild(o2);
    }
  }

  /* ===== 開關（點了立即儲存）===== */
  function bindTgl(btn,key,curFn,after){
    btn.addEventListener("click",function(){
      btn.disabled=true;
      var next=!curFn();
      var body={};body[key]=next;
      api("/api/admin/settings",{method:"PUT",json:body}).then(function(){
        if(key==="pg_open")st.pg_open=next;
        if(key==="demo_mode")st.demo_mode=next;
        if(key==="dumb_mode")st.dumb_mode=next;
        if(key==="vpn_public")st.vpn_public=next;
        if(key==="relay_meter")st.relay_meter=next;
        paintTgl(btn,next);demoStateNote();dumbStateNote();
        flash("已"+(next?"開啟":"關閉"));
      }).catch(function(e){btn.disabled=false;err(e);});
    });
  }
  bindTgl($("tglPgOpen"),"pg_open",function(){return st.pg_open;});
  bindTgl($("tglDemo"),"demo_mode",function(){return st.demo_mode;});
  bindTgl($("tglDumb"),"dumb_mode",function(){return st.dumb_mode;});
  bindTgl($("tglVpnPub"),"vpn_public",function(){return st.vpn_public;});
  bindTgl($("tglMeter"),"relay_meter",function(){return st.relay_meter;});

  /* ===== 各卡儲存 ===== */
  function saving(btn,msgEl,p,onOk){
    btn.disabled=true;var old=btn.textContent;btn.textContent="儲存中…";msgEl.textContent="";
    p.then(function(d){
      btn.disabled=false;btn.textContent=old;msgEl.textContent="✓ 已儲存";
      setTimeout(function(){msgEl.textContent="";},2200);
      if(onOk)onOk(d);
    }).catch(function(e){btn.disabled=false;btn.textContent=old;err(e);});
  }
  // 數字欄：空＝null（清覆寫）；否則要是正整數
  function intOrNull(el,label){
    var v=el.value.trim();
    if(v==="")return null;
    if(!/^[0-9]+$/.test(v)||parseInt(v,10)<1)throw new Error("「"+label+"」要是正整數，或留空＝用內建預設");
    return parseInt(v,10);
  }

  $("saveSite").addEventListener("click",function(){
    saving($("saveSite"),$("msgSite"),
      api("/api/admin/settings",{method:"PUT",json:{brand:$("fBrand").value.trim(),contact_url:$("fContact").value.trim()}}),
      function(d){st.brand=d.brand;st.custom=d.custom;st.contact_url=d.contact_url||"";
        $("fBrand").value=st.custom?st.brand:"";$("fBrand").placeholder=st.custom?"":st.brand;});
  });

  $("saveDemo").addEventListener("click",function(){
    var body;
    try{
      body={demo_channel:$("fDemoCh").value,demo_models:$("fDemoModels").value.trim(),
        demo_per_min:intOrNull($("fDemoPerMin"),"每 IP 每分鐘上限"),
        demo_per_ip_day:intOrNull($("fDemoPerIpDay"),"每 IP 每日上限"),
        demo_global_day:intOrNull($("fDemoGlobalDay"),"全站每日上限"),
        demo_max_tokens:intOrNull($("fDemoMaxTokens"),"回覆 token 上限")};
    }catch(e){err(e);return;}
    saving($("saveDemo"),$("msgDemo"),
      api("/api/admin/settings",{method:"PUT",json:body}),
      function(){st.demo_channel=body.demo_channel;st.demo_models=body.demo_models;demoStateNote();});
  });

  // Dumb mode：下拉值＝"渠道|模型"；未選＝清掉兩鍵（不生效）
  $("saveDumb").addEventListener("click",function(){
    var v=$("fDumbModel").value,pi=v.indexOf("|");
    var body={dumb_channel:pi<0?"":v.slice(0,pi),dumb_model:pi<0?"":v.slice(pi+1)};
    saving($("saveDumb"),$("msgDumb"),
      api("/api/admin/settings",{method:"PUT",json:body}),
      function(){st.dumb_channel=body.dumb_channel;st.dumb_model=body.dumb_model;dumbStateNote();});
  });

  // 預設系統提示詞：空字串照送（伺服器收到空＝刪鍵＝還原內建），存完把回傳值寫回 st
  $("savePgSys").addEventListener("click",function(){
    saving($("savePgSys"),$("msgPgSys"),
      api("/api/admin/settings",{method:"PUT",json:{pg_default_system:$("fPgSys").value.trim()}}),
      function(d){st.pg_default_system=d.pg_default_system||"";$("fPgSys").value=st.pg_default_system;});
  });

  $("saveTg").addEventListener("click",function(){
    var body={tg_chat_id:$("fTgChat").value.trim()};
    var tok=$("fTgToken").value.trim();
    if(tok)body.tg_bot_token=tok;   // 留空＝不帶＝保留舊 token（清除請用「清除」鈕）
    saving($("saveTg"),$("msgTg"),
      api("/api/admin/settings",{method:"PUT",json:body}),
      function(d){st.tg_chat_id=d.tg_chat_id;st.tg_token_set=d.tg_token_set;
        st.tg_token_hint=d.tg_token_hint;st.tg_active=d.tg_active;fillTg();});
  });
  $("clearTg").addEventListener("click",function(){
    if(!confirm("清除網頁上設定的 Telegram token 與 chat id？（Cloudflare secrets 若有設仍會生效）"))return;
    saving($("clearTg"),$("msgTg"),
      api("/api/admin/settings",{method:"PUT",json:{tg_bot_token:"",tg_chat_id:""}}),
      function(d){st.tg_chat_id="";st.tg_token_set=false;st.tg_token_hint="";st.tg_active=d.tg_active;fillTg();});
  });

  $("saveQuota").addEventListener("click",function(){
    var body;
    try{
      body={quota_relay_day:intOrNull($("fQuotaRelay"),"中轉每日請求數"),
        quota_pg_day:intOrNull($("fQuotaPg"),"Playground 每日訊息數"),
        rl_per_min:intOrNull($("fRlMin"),"每分鐘請求數上限")};
    }catch(e){err(e);return;}
    saving($("saveQuota"),$("msgQuota"),api("/api/admin/settings",{method:"PUT",json:body}));
  });

  /* ===== 選單編輯：交給 adminbar 的側邊欄編輯器 ===== */
  $("menuEditBtn").addEventListener("click",function(){
    if(window.__ipuaMenuEdit){window.__ipuaMenuEdit();return;}
    flash("編輯工具還沒載入 — 重新整理後再試");
  });

  /* ===== 模型定價 ===== */
  function renderPrices(){
    var box=$("priceRows");box.innerHTML="";
    if(!prices.length){
      var p=document.createElement("p");p.className="hint";p.textContent="還沒有定價 — 按「＋ 加一列」開始。";
      box.appendChild(p);
    }
    prices.forEach(function(row,i){
      var r=document.createElement("div");r.className="prow";
      function inp(val,ph,cls){
        var x=document.createElement("input");x.type="text";x.autocomplete="off";
        x.value=val==null?"":String(val);x.placeholder=ph;if(cls)x.className=cls;
        r.appendChild(x);return x;
      }
      var fPat=inp(row.pattern,"gpt-4o*");
      var fIn=inp(row.input_usd_per_m,"2.5");fIn.inputMode="decimal";
      var fOut=inp(row.output_usd_per_m,"10");fOut.inputMode="decimal";
      var fNote=inp(row.note,"備註（例：官網牌價 2026-07）","in-note");
      var del=document.createElement("button");del.type="button";del.className="del";del.textContent="✕";del.title="移除這列";
      del.addEventListener("click",function(){prices.splice(i,1);renderPrices();});
      r.appendChild(del);
      row._els=[fPat,fIn,fOut,fNote];
      box.appendChild(r);
    });
  }
  $("priceAdd").addEventListener("click",function(){
    syncPriceInputs();
    prices.push({pattern:"",input_usd_per_m:"",output_usd_per_m:"",note:""});
    renderPrices();
    var rows=$("priceRows").querySelectorAll(".prow input");
    if(rows.length)rows[rows.length-4].focus();
  });
  function syncPriceInputs(){
    prices.forEach(function(row){
      if(!row._els)return;
      row.pattern=row._els[0].value.trim();
      row.input_usd_per_m=row._els[1].value.trim();
      row.output_usd_per_m=row._els[2].value.trim();
      row.note=row._els[3].value.trim();
    });
  }
  $("savePrices").addEventListener("click",function(){
    syncPriceInputs();
    var items=[],bad=null;
    prices.forEach(function(row){
      if(!row.pattern&&row.input_usd_per_m===""&&row.output_usd_per_m===""&&!row.note)return; // 整列空白＝略過
      if(!row.pattern){bad="有一列沒填模型 pattern";return;}
      var i=parseFloat(row.input_usd_per_m),o=parseFloat(row.output_usd_per_m);
      if(!(i>=0)||!(o>=0)){bad="「"+row.pattern+"」的價格要是 0 以上的數字";return;}
      items.push({pattern:row.pattern,input_usd_per_m:i,output_usd_per_m:o,note:row.note||""});
    });
    if(bad){flash(bad);return;}
    saving($("savePrices"),$("msgPrices"),
      api("/api/admin/prices",{method:"PUT",json:{items:items}}),
      function(){return api("/api/admin/prices").then(function(d){prices=d.items||[];renderPrices();});});
  });

  /* ===== 自訂頁面 ===== */
  function renderPages(){
    var box=$("pageList");box.innerHTML="";
    if(!pages.length){
      var p=document.createElement("p");p.className="hint";p.textContent="還沒有自訂頁面。";
      box.appendChild(p);return;
    }
    pages.forEach(function(pg){
      var row=document.createElement("div");row.className="swrow";
      var g=document.createElement("div");g.className="g";
      var t1=document.createElement("div");t1.className="t1";
      t1.appendChild(document.createTextNode(pg.title+" "));
      var chip=document.createElement("span");chip.className="chip"+(pg.status==="published"?" pub":"");
      chip.textContent=pg.status==="published"?"已發佈":"草稿";
      t1.appendChild(chip);g.appendChild(t1);
      var t2=document.createElement("div");t2.className="t2";
      if(pg.status==="published"){
        var a=document.createElement("a");a.href="/p/"+pg.slug;a.target="_blank";a.rel="noopener";a.textContent="/p/"+pg.slug+" ↗";
        t2.appendChild(a);
      }else t2.textContent="/p/"+pg.slug+"（發佈後才看得到）";
      g.appendChild(t2);row.appendChild(g);
      var btns=document.createElement("div");btns.className="rowbtns";
      var ed=document.createElement("button");ed.type="button";ed.className="mini";ed.textContent="編輯";
      ed.addEventListener("click",function(){
        api("/api/admin/pages/"+pg.id).then(function(d){pageDialog(d.row);}).catch(err);
      });
      var del=document.createElement("button");del.type="button";del.className="mini danger";del.textContent="刪除";
      del.addEventListener("click",function(){
        if(!confirm("刪除頁面「"+pg.title+"」（/p/"+pg.slug+"）？此動作無法復原。"))return;
        api("/api/admin/pages/"+pg.id,{method:"DELETE"}).then(function(){flash("已刪除");reloadPages();}).catch(err);
      });
      btns.appendChild(ed);btns.appendChild(del);row.appendChild(btns);
      box.appendChild(row);
    });
  }
  function reloadPages(){
    api("/api/admin/pages").then(function(d){pages=d.rows||[];renderPages();}).catch(err);
  }
  $("pageAdd").addEventListener("click",function(){pageDialog(null);});

  function pageDialog(row){
    var isNew=!row;row=row||{status:"draft"};
    var ov=document.createElement("div");ov.className="mu-ov";
    var dlg=document.createElement("div");dlg.className="card mu-dlg";dlg.style.maxWidth="560px";
    function fld(labelText,node){
      var f=document.createElement("div");f.className="field";
      var lb=document.createElement("label");lb.textContent=labelText;
      f.appendChild(lb);f.appendChild(node);dlg.appendChild(f);return node;
    }
    var h=document.createElement("div");h.className="card-title";
    h.textContent=isNew?"新增頁面":"編輯頁面 — /p/"+row.slug;
    dlg.appendChild(h);
    var fSlug=document.createElement("input");fSlug.type="text";fSlug.autocomplete="off";
    fSlug.value=row.slug||"";fSlug.placeholder="about、privacy-policy…（小寫英數與連字號）";
    fld("網址代稱（slug，必填）",fSlug);
    var fTitle=document.createElement("input");fTitle.type="text";fTitle.autocomplete="off";
    fTitle.value=row.title||"";fTitle.placeholder="頁面標題";
    fld("標題（必填）",fTitle);
    var fStatus=document.createElement("select");
    [["draft","草稿（對外看不到）"],["published","發佈"]].forEach(function(p){
      var o=document.createElement("option");o.value=p[0];o.textContent=p[1];
      if(row.status===p[0])o.selected=true;fStatus.appendChild(o);
    });
    fld("狀態",fStatus);
    var fSummary=document.createElement("textarea");fSummary.rows=2;
    fSummary.value=row.summary||"";fSummary.placeholder="一兩句話簡介（SEO 與分享卡描述）";
    fld("摘要",fSummary);
    var fBody=document.createElement("textarea");fBody.id="pgBody";fBody.spellcheck=false;
    fBody.value=row.body_md||"";fBody.placeholder="內文 Markdown：空一行分段、## 小標、**粗體**、[文字](網址)…";
    fld("內文（Markdown）",fBody);
    var btns=document.createElement("div");btns.style.cssText="display:flex;gap:8px;justify-content:flex-end;margin-top:4px";
    var cancel=document.createElement("button");cancel.type="button";cancel.className="ghost";cancel.textContent="取消";
    var save=document.createElement("button");save.type="button";save.className="primary";save.textContent="儲存";
    btns.appendChild(cancel);btns.appendChild(save);dlg.appendChild(btns);
    ov.appendChild(dlg);document.body.appendChild(ov);
    fSlug.focus();
    function close(){ov.remove();}
    cancel.addEventListener("click",close);
    ov.addEventListener("click",function(e){if(e.target===ov)close();});
    save.addEventListener("click",function(){
      var payload={slug:fSlug.value.trim(),title:fTitle.value.trim(),status:fStatus.value,
                   summary:fSummary.value.trim(),body_md:fBody.value};
      if(!payload.slug||!payload.title){flash("slug 與標題都是必填");return;}
      save.disabled=true;save.textContent="儲存中…";
      var p=isNew?api("/api/admin/pages",{json:payload})
                 :api("/api/admin/pages/"+row.id,{method:"PUT",json:payload});
      p.then(function(){close();flash("已儲存");reloadPages();}).catch(function(e){
        save.disabled=false;save.textContent="儲存";err(e);
      });
    });
  }

  boot(false);
})();
`;

export async function onRequestGet({ request, env }: RouteCtx): Promise<Response> {
  const { chrome } = await getChromeFor(env, request); // 選單依身分過濾（VPN 隱形）
  return html(
    pageShell({
      title: "管理員設定",
      desc: "管理員專用的網站設定頁。",
      noindex: true,
      chrome: chrome,
      activePath: "/settings",
      h1: "管理員設定",
      headExtra: "<style>" + ADMIN_CSS + PAGE_CSS + "</style>\n",
      body: BODY + "\n<script data-nonce>" + PAGE_JS + "</script>"
    })
  );
}
