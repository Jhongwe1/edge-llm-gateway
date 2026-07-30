// GET /playground — Playground（會員頁；v2.2 起是「聊天主頁」，外觀仿 chatgpt.com）。
// 未登入 → 登入閘門；沒被批准 playground 服務 → 等待批准畫面；批准後是完整聊天介面：
// 頂部「Chat ∨」＝模型選單（管理員在 /relay 渠道裡設定的清單）、右上「⋯」＝刪除目前對話、
// 串流回覆、Markdown 渲染（含程式碼複製）、空對話置中歡迎語＋輸入框。
// 歷史對話列表（History）由外殼側邊欄負責（src/lib/site.ts 的 SHELL_JS），這裡透過
// window.__pgOpenConv / __pgNewChat / __pgConvDeleted 與 window.SBH 橋接。
// 後端邏輯在 src/lib/playground.ts 與 src/routes/api/playground/*。
import { html, pageShell, assetSrc } from "./site.js";
import { getChromeFor } from "./chrome.js";
import { MEMBER_CSS, MEMBER_JS } from "./memberui.js";
import { imgBytesBudget } from "./playground.js";
import { uploadPlan } from "./filestore.js";
import type { Env } from "../types.js";

const PG_CSS = `
  /* 聊天鋪滿內容區：外殼 .content 的留白歸零、頁尾藏起來 */
  .content{padding:0}
  .wrap{max-width:none;margin:0;height:100%;display:flex;flex-direction:column;min-height:0}
  footer{display:none}
  #root{flex:1;min-height:0;display:flex;flex-direction:column}
  /* 頂部「Chat ∨」模型選單鈕（放在外殼 h1 裡） */
  .pg-title{border:0;background:none;color:var(--fg);font-family:inherit;font-size:16px;font-weight:600;
            display:inline-flex;align-items:center;gap:5px;padding:6px 10px;border-radius:9px;cursor:pointer;min-width:0}
  .pg-title:hover{background:var(--hov)}
  .pg-title .cv{color:var(--muted);font-size:11px}
  .pg-title .mn{color:var(--muted);font-weight:500;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:180px}
  @media(max-width:560px){.pg-title .mn{display:none}}
  /* 今日用量小字（頁首右側） */
  .pg-usage{font-size:11.5px;color:var(--sub);white-space:nowrap;margin-right:2px}
  /* ---- 聊天主體 ---- */
  .pg{flex:1;min-height:0;display:flex;flex-direction:column}
  .pg-msgs{flex:1;min-height:0;overflow-y:auto;padding:18px 16px 8px;display:flex;flex-direction:column;gap:16px}
  .pg-msgs::-webkit-scrollbar{width:8px}
  .pg-msgs::-webkit-scrollbar-track{background:transparent}
  .pg-msgs::-webkit-scrollbar-thumb{background:var(--line);border-radius:4px;border:2px solid transparent;background-clip:content-box}
  .m{width:100%;max-width:760px;margin:0 auto;flex:0 0 auto}
  /* 直向堆疊：附件在上、文字氣泡在下，整組靠右（跟主流聊天介面一致）。
     ⚠ 這裡一定要 column —— 用 row 的話附件列與氣泡會變成左右並排，
     送出一張圖加一句話就會看到「圖在左、字在右」的怪版面（2026-07-29 上線後才發現）。 */
  .m.user{display:flex;flex-direction:column;align-items:flex-end}
  /* 使用者訊息：ChatGPT 式灰底氣泡（不再用反色） */
  .mb-user{background:var(--field);color:var(--fg);border-radius:18px;padding:10px 16px;max-width:84%;
           font-size:15px;line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere}
  .m.ai .md{font-size:15px;line-height:1.85;overflow-wrap:anywhere;min-width:0}
  .m-act{margin-top:6px}
  .mab{border:0;background:none;color:var(--muted);border-radius:7px;padding:4px 9px;
       font-size:11.5px;font-weight:600;cursor:pointer;font-family:inherit;transition:.15s}
  .mab:hover{background:var(--hov);color:var(--fg)}
  .m-err{color:#e02e2a;font-size:13px;border:1px solid rgba(224,46,42,.5);border-radius:10px;padding:8px 12px;margin-top:8px}
  /* 額度用完時附在錯誤框裡的「聯絡我」鈕：自己一行 */
  .m-err .gcontact{display:flex;width:fit-content;margin-top:8px}
  /* Markdown（AI 回覆） */
  .md p{margin:0 0 .85em}
  .md>:last-child{margin-bottom:0}
  .md h1,.md h2{font-size:18px;line-height:1.5;margin:1.1em 0 .5em}
  .md h3,.md h4{font-size:16px;margin:1em 0 .45em}
  .md ul,.md ol{padding-left:1.6em;margin:0 0 .85em}
  .md li{margin:.22em 0}
  .md blockquote{border-left:3px solid var(--line2);padding:2px 0 2px 13px;color:var(--muted);margin:0 0 .85em}
  .md code{font-family:ui-monospace,Menlo,Consolas,monospace;background:var(--field);border:1px solid var(--line);border-radius:5px;padding:1px 5px;font-size:.86em}
  .md pre{position:relative;background:var(--field);border:1px solid var(--line);border-radius:10px;padding:12px;
          overflow-x:auto;margin:0 0 .9em;line-height:1.6;font-size:13px}
  .md pre code{border:0;background:none;padding:0;font-size:inherit}
  .md pre .cpb{position:absolute;top:6px;right:6px;border:1px solid var(--line);background:var(--card);color:var(--muted);
               border-radius:6px;padding:3px 8px;font-size:11px;font-weight:600;cursor:pointer;font-family:inherit;opacity:0;transition:.15s}
  .md pre:hover .cpb{opacity:1}
  @media(hover:none){.md pre .cpb{opacity:.7}}
  .md hr{border:0;border-top:1px solid var(--line);margin:1.2em 0}
  .md table{border-collapse:collapse;margin:0 0 .9em;max-width:100%;display:block;overflow-x:auto}
  .md th,.md td{border:1px solid var(--line);padding:5px 10px;font-size:13.5px}
  .md a{color:var(--fg)}
  .md img{max-width:100%;height:auto;border-radius:8px}
  /* 數學式（KaTeX）：長公式（積分、矩陣）在手機上一定會超出寬度 —— 讓它自己橫向捲，
     不要把整個訊息氣泡撐破、也不要讓整頁出現橫向捲軸。 */
  .md .katex-display{overflow-x:auto;overflow-y:hidden;margin:.85em 0;padding:2px 0}
  .md .katex{font-size:1.05em}
  .md .katex-error{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.9em}
  /* 區塊公式的外殼是 span（<p> 裡不能放 <div>），要自己撐成整行才會置中、才有上下留白 */
  .md .pgm[data-d="1"]{display:block}
  /* KaTeX 還在下載時，這裡是原始 LaTeX。給等寬字＋淡一點，看起來像「還沒渲染完」
     而不是「壞掉了」；載入失敗時也維持這個樣子，至少內容看得懂。 */
  .md .pgm:not([data-done]){font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.92em;opacity:.75}
  /* 等待中的三顆點 */
  .dots-w{display:inline-flex;gap:4px;padding:8px 0}
  .dots-w i{width:6px;height:6px;border-radius:50%;background:var(--muted);animation:pgb 1s infinite}
  .dots-w i:nth-child(2){animation-delay:.15s}
  .dots-w i:nth-child(3){animation-delay:.3s}
  @keyframes pgb{0%,60%,100%{opacity:.25;transform:none}30%{opacity:1;transform:translateY(-3px)}}
  /* 推理模型的思考過程：串流中自動展開（畫面才不會空白），正文一開始吐就自動收合 */
  .think{border:1px solid var(--line);border-radius:10px;margin:0 0 9px;background:var(--field);overflow:hidden}
  .think>summary{cursor:pointer;list-style:none;padding:7px 11px;font-size:11.5px;color:var(--muted);
    letter-spacing:.03em;user-select:none;display:flex;align-items:center;gap:6px}
  .think>summary::-webkit-details-marker{display:none}
  .think>summary::before{content:"▸";font-size:9px;transition:transform .15s;flex:0 0 auto}
  .think[open]>summary::before{transform:rotate(90deg)}
  .think>summary:hover{color:var(--fg)}
  .think-body{padding:0 11px 9px;font-size:12.5px;line-height:1.75;color:var(--muted);
    white-space:pre-wrap;overflow-wrap:anywhere;max-height:220px;overflow-y:auto}
  /* 空狀態：置中歡迎語（ChatGPT「How can I help?」），輸入框跟著置中 */
  .pg-hero{text-align:center;padding:0 16px 4px;max-width:640px;margin:0 auto;width:100%}
  .pg-hero h2{font-size:26px;font-weight:600;letter-spacing:0}
  .pg-hero p{font-size:13.5px;color:var(--muted);line-height:1.75;margin:10px 0 0}
  .pg.empty{justify-content:center;gap:22px}
  .pg.empty .pg-msgs{display:none}
  .pg:not(.empty) .pg-hero{display:none}
  /* ---- 輸入區（膠囊）---- */
  .pg-comp-w{flex:0 0 auto;padding:8px 16px 18px;width:100%}
  .pg.empty .pg-comp-w{flex:0 0 auto;padding-top:0}
  .pg-comp{display:flex;align-items:flex-end;gap:4px;max-width:760px;margin:0 auto;
           background:var(--field);border:1px solid var(--line);border-radius:26px;padding:7px 8px}
  [data-theme="dark"] .pg-comp{border-color:transparent}
  .pg-plus{width:36px;height:36px;flex:0 0 auto;border:0;background:none;color:var(--fg);border-radius:50%;
           font-size:18px;line-height:1;cursor:pointer;font-family:inherit;display:inline-flex;align-items:center;justify-content:center;transition:.15s}
  .pg-plus:hover{background:var(--hov)}
  /* 目前模型看不了圖片：整顆鈕變灰。刻意不用 disabled —— 那樣按下去不會有任何反應，
     使用者只會覺得功能壞了；留著可按才有機會解釋「換個模型就能傳圖」。 */
  /* overflow-y 平常藏起來，長文超過 max-height 時才由 autoGrow 放出捲軸 */
  .pg-ta{flex:1;resize:none;border:0;background:none;color:var(--fg);
         padding:8px 6px;font-size:15px;font-family:inherit;line-height:1.55;outline:none;
         min-height:36px;max-height:200px;box-sizing:border-box;overflow-y:hidden}
  .pg-ta::placeholder{color:var(--sub)}
  .pg-send{width:36px;height:36px;flex:0 0 auto;border-radius:50%;border:0;background:var(--accent);
           color:var(--accent-fg);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;font-family:inherit;transition:.15s}
  .pg-send svg{display:block}
  .pg-send:not(:disabled):active{transform:translateY(1px)}
  .pg-send:disabled{opacity:.3;cursor:default}
  .pg-send.stop{background:var(--fg);color:var(--bg)}
  @media(max-width:560px){
    .pg-comp-w{padding:6px 10px 12px}
    .pg-hero h2{font-size:22px}
  }
  /* 觸控裝置：輸入框字級 <16px 時 iOS Safari 聚焦會自動放大整頁 — 拉到 16px 就不會 */
  @media(hover:none){
    .pg-ta{font-size:16px}
  }
  /* ---- 附件（v2.3）---- */
  /* 輸入框上方的待送出附件列。整個 .pg-comp 改成直向堆疊：附件列在上、輸入列在下 */
  .pg-comp{flex-direction:column;align-items:stretch;gap:0}
  .pg-comp-row{display:flex;align-items:flex-end;gap:4px;width:100%}
  .pg-atts{display:flex;flex-wrap:wrap;gap:8px;padding:6px 6px 8px}
  .pg-att{position:relative;display:flex;align-items:center;gap:8px;background:var(--card);
          border:1px solid var(--line);border-radius:12px;padding:6px 10px 6px 6px;max-width:230px}
  .pg-att img{width:38px;height:38px;object-fit:cover;border-radius:8px;flex:0 0 auto;display:block}
  /* 文件附件的方形圖示（顯示副檔名） */
  .pg-att .fic{width:38px;height:38px;border-radius:8px;flex:0 0 auto;display:flex;align-items:center;
               justify-content:center;background:var(--field);color:var(--muted);font-size:10px;font-weight:700;
               text-transform:uppercase;letter-spacing:.02em;overflow:hidden}
  .pg-att .fm{min-width:0;display:flex;flex-direction:column;gap:2px}
  .pg-att .fn{font-size:12.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .pg-att .fs{font-size:11px;color:var(--muted)}
  .pg-att .fx{position:absolute;top:-6px;right:-6px;width:20px;height:20px;border-radius:50%;border:0;
              background:var(--fg);color:var(--bg);font-size:12px;line-height:1;cursor:pointer;
              display:flex;align-items:center;justify-content:center;font-family:inherit;padding:0}
  .pg-att.busy{opacity:.55}
  /* 拖放整個聊天區時的提示框 */
  .pg.drop{outline:2px dashed var(--accent);outline-offset:-10px;border-radius:12px}
  /* 訊息氣泡裡的附件（使用者訊息，圖片在文字上方、跟氣泡一樣靠右對齊） */
  .m-atts{display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end;margin-bottom:6px;max-width:84%}
  .m-atts img{max-width:220px;max-height:220px;border-radius:12px;display:block;cursor:zoom-in;
              border:1px solid var(--line)}
  /* 內容被淘汰／過期清掉的附件：中繼資料還在，畫成佔位而不是破圖 */
  .m-att-gone{display:flex;align-items:center;gap:7px;background:var(--field);border:1px dashed var(--line2);
              border-radius:10px;padding:7px 11px;font-size:12px;color:var(--muted)}
  /* 使用者訊息裡的檔案內容：摺疊起來，不然一個 Excel 抽出來的幾萬字會淹掉整個對話 */
  .mb-doc{margin-top:8px;border:1px solid var(--line);border-radius:10px;background:var(--bg);overflow:hidden}
  .mb-doc:first-child{margin-top:0}
  .mb-doc>summary{cursor:pointer;list-style:none;padding:7px 11px;font-size:12.5px;font-weight:600;
                  user-select:none;display:flex;align-items:center;gap:6px}
  .mb-doc>summary::-webkit-details-marker{display:none}
  .mb-doc-body{padding:0 11px 9px;font-size:12px;line-height:1.7;color:var(--muted);white-space:pre-wrap;
               overflow-wrap:anywhere;max-height:260px;overflow-y:auto}
  /* 點縮圖看原圖的燈箱 */
  .pg-lb{position:fixed;inset:0;background:rgba(0,0,0,.82);z-index:60;display:flex;align-items:center;
         justify-content:center;padding:24px;cursor:zoom-out}
  .pg-lb img{max-width:100%;max-height:100%;border-radius:8px}
  @media(max-width:560px){
    .m-atts img{max-width:150px;max-height:150px}
  }
  /* 體驗模式橫幅（Phase K）：未登入＋demo 開時顯示在聊天區頂端 */
  .pg-demo{flex:0 0 auto;max-width:760px;width:calc(100% - 32px);margin:10px auto 0;border:1px solid var(--line);
           background:var(--card);border-radius:12px;padding:9px 14px;font-size:13px;color:var(--muted);line-height:1.7}
  .pg-demo b{color:var(--fg)}
  .pg-demo a{color:var(--fg);font-weight:700;white-space:nowrap}
  .pg.empty .pg-demo{margin:0 auto}
`;

export async function playgroundPageResponse(env: Env, request: Request): Promise<Response> {
  const { chrome } = await getChromeFor(env, request); // 選單依身分過濾（VPN 隱形）

  // 前端壓縮圖片時要壓到多小 —— 兩條線取小的那條：
  //   1. 伺服器這次收得下多大（純 D1 1400KB／R2 5MB；R2 寫入額度用完會自動退回 D1 那條）
  //   2. 單次對話能送給上游多少圖（imgBytesBudget，可在 /settings 調 pg_img_total_kb）
  // 第 2 條是**CPU** 換算出來的，換到 R2 也不會變。少了它的話會出現最難解釋的那種壞法：
  // 圖傳得上去、縮圖也看得到，但模型永遠說「我沒看到圖」—— 因為它在組上游 body 之前
  // 就被降級成文字佔位了（見 loadImages）。壓縮目標壓在模型吃得下的線內，才不會發生。
  const plan = await uploadPlan(env);
  const imgTotal = await imgBytesBudget(env);
  const compressTo = Math.min(plan.maxKb * 1024, imgTotal);

  const body =
    // total＝整趟請求所有圖片的 bytes 上限。前端要知道它，才有辦法在「加圖」與「送出」
    // 當下就講清楚 —— 以前這個預算只有伺服器知道，超過的圖被默默降級成文字佔位，
    // 會員完全不知道自己少送了東西（2026-07-29 修）。
    "<script data-nonce>window.__PGFILE=" +
    JSON.stringify({ max: compressTo, store: plan.store, total: imgTotal }) +
    ";</script>\n" +
    '<div id="root"><div class="gate"><div class="spin"></div></div></div>\n' +
    '<script data-nonce src="' +
    assetSrc("marked.js") +
    '"></script>\n' +
    // pdf.js 的資產路徑（帶快取版本）。pgattach.js 只有在使用者真的丟 PDF 進來時
    // 才會動態 import 這兩個檔案 —— 它們合計 1.8MB，不能讓每個進聊天頁的人都下載。
    '<script data-nonce>window.__PDFJS={main:"' +
    assetSrc("pdf.js") +
    '",worker:"' +
    assetSrc("pdf.worker.js") +
    '"};</script>\n' +
    // 附件處理（圖片壓縮、Office／PDF 抽文字、上傳）。只有這一頁需要，其他頁不載。
    '<script data-nonce src="' +
    assetSrc("pgattach.js") +
    '"></script>\n' +
    // 數學式渲染（KaTeX）。同樣是按需 —— 這裡只給路徑與那支很小的協調程式，
    // 真正的 KaTeX 本體（272KB＋字型）要等訊息裡真的出現 LaTeX 才下載。
    '<script data-nonce>window.__KATEX={js:"' +
    assetSrc("katex/katex.min.js") +
    '",css:"' +
    assetSrc("katex/katex.min.css") +
    '"};</script>\n' +
    '<script data-nonce src="' +
    assetSrc("pgmath.js") +
    '"></script>\n' +
    "<script data-nonce>" +
    MEMBER_JS +
    "</script>\n" +
    "<script data-nonce>" +
    PG_JS +
    "</script>";
  return html(
    pageShell({
      title: "Chat",
      tkey: "page.playground",
      desc: "會員專用的 Playground — 在網頁上直接試用站上的 AI 模型。",
      noindex: true,
      chrome: chrome,
      activePath: "/playground",
      // 頁首標題＝模型選單鈕（PG_JS 接手；模型清單載入前先顯示純「Chat」）
      h1: '<button id="pgTitle" class="pg-title" type="button">Chat <span class="cv">▼</span></button>',
      // 蓋掉外殼的 viewport（後出現者生效）：鎖 maximum-scale，手機點輸入框不會自動放大頁面
      headExtra:
        '<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">\n' +
        "<style>" +
        MEMBER_CSS +
        PG_CSS +
        "</style>\n",
      body: body
    })
  );
}

const PG_JS = `
(function(){
  "use strict";
  var $=MU.$,el=MU.el,tx=MU.tx,esc=MU.esc;
  var root=$("root");
  // 送出／停止圖示（SVG 線條箭頭與圓角方塊）
  var SEND_ICON='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
  var STOP_ICON='<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="3"/></svg>';
  var me=null,groups=[],cur=null,msgs=[];
  var demoMode=false;  // 體驗模式（未登入＋管理員開 demo）：無歷史（對話只有管理員看得到）
  var dumbMode=false;  // Dumb mode（v2.2）：模型被管理員鎖定且隱藏 — 沒有模型選單、送出不帶模型
  var dumbVision=false;// dumb 模式下前端不知道模型是誰，只由伺服器告知「能不能附圖」
  var dumbImgmax=0;    // 同上：dumb 模式下的「單則最多幾張圖」（0＝伺服器沒說，不特別限制）
  var streaming=false,aborter=null;
  /* v2.5 直通模式（ADR-0014）：伺服器把上游串流原樣轉推過來，Worker 看不到內容 ——
     所以「回覆落地」與「token 用量」都由這裡回報。livePt 是目前這一趟的狀態，
     關網頁時（pagehide）靠它把已收到的部分用 sendBeacon 送回去。 */
  var livePt=null;
  var UI={};
  var model="";        // 目前選的模型（"channelSlug|modelName"）
  var coarse=!!(window.matchMedia&&matchMedia("(pointer:coarse)").matches);

  function api(path,opts){
    opts=opts||{};opts.headers=opts.headers||{};
    if(opts.json!==undefined){opts.method=opts.method||"POST";opts.headers["content-type"]="application/json";opts.body=JSON.stringify(opts.json);delete opts.json;}
    if(!opts.cache)opts.cache="no-store";
    return fetch(path,opts).then(function(r){
      return r.json().catch(function(){return{};}).then(function(d){
        if(!r.ok)throw new Error(d.hint||d.error||("HTTP "+r.status));
        return d;
      });
    });
  }
  function hasSvc(){return !!(me&&(me.services||[]).indexOf("playground")>=0);}

  /* ================= Markdown（含消毒）================= */
  function textHtml(t){return esc(t).replace(/\\n/g,"<br>");}
  function sanitize(rootNode){
    var BAD={SCRIPT:1,STYLE:1,IFRAME:1,OBJECT:1,EMBED:1,LINK:1,META:1,FORM:1,BASE:1};
    var els=rootNode.querySelectorAll("*");
    for(var i=els.length-1;i>=0;i--){
      var n=els[i];
      if(BAD[n.tagName]){n.remove();continue;}
      for(var j=n.attributes.length-1;j>=0;j--){
        var a=n.attributes[j],nm=a.name.toLowerCase(),v=String(a.value||"");
        if(nm.indexOf("on")===0){n.removeAttribute(a.name);continue;}
        if((nm==="href"||nm==="src")&&/^\\s*(javascript|vbscript|data):/i.test(v))n.removeAttribute(a.name);
      }
      if(n.tagName==="A"){n.setAttribute("target","_blank");n.setAttribute("rel","noopener noreferrer");}
    }
  }
  function mdRender(text){
    /* 數學區塊先抽走換成佔位符，否則 markdown 會把 \\lim_{x} … \\int_{5} 裡的兩個
       底線當成斜體語法，中間整段被包進 <em>，公式就毀了。markdown 跑完再放回去，
       最後由 PGM.render() 交給 KaTeX。細節見 public/assets/pgmath.js。 */
    var store=[];
    var src=text;
    if(window.PGM&&PGM.has(text))src=PGM.protect(text,store);
    var raw=null;
    try{
      if(window.marked&&marked.parse)raw=marked.parse(src,{breaks:true,async:false});
    }catch(e){raw=null;}
    if(raw==null)return textHtml(text);
    var tpl=document.createElement("template");
    tpl.innerHTML=raw;
    sanitize(tpl.content);
    var out=tpl.innerHTML;
    return store.length?PGM.restore(out,store):out;
  }
  /* 把節點裡的 LaTeX 渲染成數學式。串流「中」刻意不做 —— 那時公式多半只有半截
     （$$ 開了還沒關），渲染不但會失敗還會每一幀重跑一次。等收完再一次渲染。 */
  function mathify(node){
    if(node&&window.PGM)PGM.render(node);
  }
  function addPreCopy(md){
    var pres=md.querySelectorAll("pre");
    for(var i=0;i<pres.length;i++)(function(pre){
      if(pre.querySelector(".cpb"))return;
      var b=el("button","cpb",tx("複製","Copy"));
      MU.copyBtn(b,function(){var c=pre.querySelector("code");return (c||pre).innerText;});
      pre.appendChild(b);
    })(pres[i]);
  }

  /* ================= 進入點與閘門 ================= */
  function paint(){
    if(streaming)return;   // 串流中不整頁重畫
    if(!me){MU.gateLogin(root,"Playground",tx("請先用 Google 登入","Please sign in with Google first."));return;}
    if(!hasSvc()){MU.gatePending(root,me);return;}
    buildApp();
  }
  function start(){
    MU.me(true).then(function(u){
      me=u;
      if(!me){
        /* 未登入：demo 開著就直接進體驗模式聊天，關著照舊顯示登入閘門 */
        return api("/api/settings").then(function(s){
          if(!s.demo){paint();return;}
          demoMode=true;
          /* dumb 開著時體驗模式同樣拿到空清單＋dumb:true — 沒有模型選單，照樣能聊 */
          return api("/api/playground/models").then(function(r){groups=r.rows||[];dumbMode=!!r.dumb;dumbVision=!!r.vision;dumbImgmax=r.imgmax||0;buildApp();});
        });
      }
      if(!hasSvc()){paint();return;}
      return api("/api/playground/models").then(function(r){
        groups=r.rows||[];
        dumbMode=!!r.dumb;   // 模型被鎖定且隱藏：清單是空的但照樣能聊
        dumbVision=!!r.vision;
        dumbImgmax=r.imgmax||0;
        paint();
        /* 側欄 History 由外殼載入；#c=<id> 進來（他頁點歷史）就直接打開那筆 */
        var m=location.hash.match(/^#c=(.+)$/);
        if(m)openConv(decodeURIComponent(m[1]));
      });
    }).catch(function(e){root.innerHTML='<div class="gate"><p>'+tx("讀取失敗：","Failed: ")+esc(e.message||e)+'</p></div>';});
  }
  MU.onLang(function(){paint();updateTitle();updateMore();});

  /* ================= 頂部：模型選單（Chat ∨）與「⋯」刪除 ================= */
  function savedModel(){var s="";try{s=localStorage.getItem("ipua-pg-model")||"";}catch(e){}return s;}
  function allModels(){
    var out=[];
    groups.forEach(function(g){(g.models||[]).forEach(function(m){out.push({v:g.slug+"|"+m,name:m,ch:g.name});});});
    return out;
  }
  function ensureModel(){
    if(dumbMode){model="";return;}   // 鎖定模式：前端不知道也不需要知道模型
    var list=allModels();
    if(!list.length){model="";return;}
    var s=savedModel();
    model=list.some(function(x){return x.v===s;})?s:list[0].v;
  }
  function modelName(){
    var pi=model.indexOf("|");
    return pi<0?"":model.slice(pi+1);
  }
  function updateTitle(){
    var b=document.getElementById("pgTitle");
    if(!b)return;
    if(dumbMode){b.innerHTML="Chat";b.title="";b.style.cursor="default";return;}
    b.innerHTML="Chat "+(modelName()?'<span class="mn">'+esc(modelName())+"</span> ":"")+'<span class="cv">\\u25bc</span>';
    b.title=tx("選擇模型","Choose a model");
  }
  function modelMenu(){
    if(dumbMode)return;   // 鎖定模式沒有模型選單
    var b=document.getElementById("pgTitle");
    if(!b||!window.SBPOP)return;
    var list=allModels();
    /* 平常每列只寫模型名 — 渠道名是管理員的內部命名，會員看了也沒用。
       只有「同一個模型名掛在兩個以上渠道」時才補上「· 渠道名」，讓那幾列還分得出來。
       鍵加 "m:" 前綴：模型名要是剛好叫 constructor／toString，裸物件會撞到原型上的東西。 */
    var dup={};
    list.forEach(function(x){dup["m:"+x.name]=(dup["m:"+x.name]||0)+1;});
    window.SBPOP.open(b,function(p){
      if(!list.length){
        var d=el("div","phead",tx("尚無可用模型","No models yet"));p.appendChild(d);return;
      }
      list.forEach(function(x){
        var it=window.SBPOP.item(p,"",function(){
          model=x.v;
          try{localStorage.setItem("ipua-pg-model",model);}catch(e){}
          updateTitle();
          /* 換模型時，已經掛著的圖片可能就不合新模型的規矩了。與其讓人打完字才發現，
             不如當下就處理掉並講明原因。兩種情況：
               看不了圖   → 圖片全部移除（文件留著，它們跟 vision 無關）
               張數變少   → 只留前幾張（保留挑選順序，多的那幾張移除） */
          if(!seesImages()){
            var had=atts.filter(function(a){return a.kind==="image";}).length;
            if(had){
              atts=atts.filter(function(a){return a.kind!=="image";});
              renderAtts();
              MU.flash(tx("這個模型看不了圖片，已移除附加的圖片","This model can't read images — attached images removed"));
            }
          }else{
            var lim2=maxImgs();
            if(lim2&&imgCount()>lim2){
              var seen=0;
              atts=atts.filter(function(a){
                if(a.kind!=="image")return true;
                seen++;return seen<=lim2;
              });
              renderAtts();
              MU.flash(lim2===1
                ?tx("這個模型一次只看得懂 1 張圖，已只留下第 1 張",
                    "This model reads only 1 image at a time — kept the first one")
                :tx("這個模型一次最多 "+lim2+" 張圖，多的已移除",
                    "This model takes at most "+lim2+" images — extras removed"));
            }
          }
        });
        it.textContent=dup["m:"+x.name]>1?(x.name+" \\u00b7 "+x.ch):x.name;
        if(x.v===model){
          var k=el("span","pk","\\u2713");
          it.appendChild(k);
        }
      });
    });
  }
  function mountTop(){
    var b=document.getElementById("pgTitle");
    if(b&&!b.getAttribute("data-pg")){
      b.setAttribute("data-pg","1");
      b.addEventListener("click",function(e){e.stopPropagation();modelMenu();});
    }
    updateTitle();
    var c=document.querySelector("header .ctrls");
    if(c&&!document.getElementById("pgMore")&&!demoMode){
      /* 今日用量（/api/me 的 usage 區塊；管理員無上限顯示 ∞） */
      if(me&&me.usage&&me.usage.pg_today!=null){
        var uq=el("span","pg-usage");
        uq.id="pgUsage";
        uq.textContent=me.usage.pg_today+" / "+(me.usage.pg_limit==null?"\\u221e":me.usage.pg_limit);
        uq.title=tx("今日已用訊息數／每日上限（UTC 午夜重置）","Messages today / daily limit (resets at UTC midnight)");
        c.insertBefore(uq,c.firstChild);
      }
      var mb=el("button","ctrl");
      mb.id="pgMore";mb.type="button";mb.textContent="\\u22ef";
      mb.style.display="none";
      mb.addEventListener("click",function(e){
        e.stopPropagation();
        window.SBPOP.open(mb,function(p){
          window.SBPOP.item(p,tx("刪除","Delete"),function(){deleteCur();},true);
        });
      });
      c.insertBefore(mb,c.firstChild);
    }
    updateMore();
  }
  function updateMore(){
    var mb=document.getElementById("pgMore");
    if(mb){mb.style.display=cur?"":"none";mb.title=tx("對話選項","Conversation options");}
  }
  function deleteCur(){
    if(!cur)return;
    if(!confirm(tx("刪除這則對話？此動作無法復原。","Delete this conversation? This cannot be undone.")))return;
    api("/api/playground/conversations/"+cur,{method:"DELETE"}).then(function(){
      newChat();
      if(window.SBH)window.SBH.refresh();
      MU.flash(tx("已刪除","Deleted"));
    }).catch(function(e){MU.flash(esc(e.message||e));});
  }

  /* ================= 介面骨架 ================= */
  function buildApp(){
    root.innerHTML="";
    ensureModel();
    var app=el("div","pg");UI.app=app;

    if(demoMode){
      /* 體驗模式橫幅＋登入 CTA（限制細節不寫這裡 — 真的撞到限流時錯誤訊息才會講） */
      var bn=el("div","pg-demo");
      bn.innerHTML="<b>"+tx("體驗模式","Demo mode")+"</b> · "
        +'<a href="/auth/login?next=/playground">'+tx("登入解鎖完整功能 →","Sign in for full access →")+"</a>";
      app.appendChild(bn);
    }

    UI.msgs=el("div","pg-msgs");
    UI.msgs.addEventListener("scroll",function(){
      UI.stick=UI.msgs.scrollHeight-UI.msgs.scrollTop-UI.msgs.clientHeight<90;
      morphNew();
    },{passive:true});
    UI.stick=true;
    app.appendChild(UI.msgs);

    /* 空狀態歡迎語（ChatGPT「How can I help?」） */
    UI.hero=el("div","pg-hero");
    var hh=el("h2",null,tx("有什麼我能幫上的？","How can I help?"));
    UI.hero.appendChild(hh);
    if(!groups.length&&!dumbMode){
      UI.hero.appendChild(el("p",null,
        demoMode?tx("體驗模式暫時沒有可用的模型，請稍後再來或登入。","Demo mode has no models available right now.")
        :tx("管理員還沒設定任何模型。","The site owner hasn't configured any models yet.")+(me&&me.is_admin?tx("到「API 中轉站」的管道管理幫渠道加上模型名稱即可。"," Add model names to a channel in the relay admin.") : "")));
    }
    app.appendChild(UI.hero);

    var compW=el("div","pg-comp-w");
    var comp=el("div","pg-comp");
    /* 待送出的附件列（在輸入框上方；沒有附件時整條隱藏） */
    UI.atts=el("div","pg-atts");
    UI.atts.style.display="none";
    comp.appendChild(UI.atts);
    var row=el("div","pg-comp-row");
    UI.plus=el("button","pg-plus");
    UI.plus.type="button";UI.plus.textContent="\\uff0b";
    UI.plus.addEventListener("click",function(e){e.stopPropagation();attachClick();});
    UI.plus.title=tx("附加檔案","Attach files");
    row.appendChild(UI.plus);
    UI.ta=el("textarea","pg-ta");
    UI.ta.rows=1;
    UI.ta.placeholder=tx("詢問任何問題","Ask anything");
    UI.ta.disabled=!groups.length&&!dumbMode;
    UI.ta.addEventListener("input",autoGrow);
    UI.ta.addEventListener("keydown",function(e){
      if(e.key==="Enter"&&!e.shiftKey&&!e.isComposing&&!coarse){e.preventDefault();send();}
    });
    row.appendChild(UI.ta);
    UI.send=el("button","pg-send");
    UI.send.innerHTML=SEND_ICON;
    UI.send.title=tx("送出","Send");
    UI.send.disabled=!groups.length&&!dumbMode;
    UI.send.addEventListener("click",function(){
      if(streaming){if(aborter)aborter.abort();return;}
      send();
    });
    row.appendChild(UI.send);
    comp.appendChild(row);
    compW.appendChild(comp);
    app.appendChild(compW);

    /* 貼上圖片（截圖後直接 Ctrl+V — 主流聊天網站都有，而且是最常用的附圖方式） */
    UI.ta.addEventListener("paste",function(e){
      var items=(e.clipboardData&&e.clipboardData.files)||null;
      if(!items||!items.length)return;
      var fs=[];
      for(var i=0;i<items.length;i++)if(PGA.isImage(items[i]))fs.push(items[i]);
      if(!fs.length)return;      /* 純文字貼上照原本的行為走 */
      e.preventDefault();
      addFiles(fs);
    });
    /* 拖放整個聊天區。dragover 一定要 preventDefault，否則瀏覽器會直接開啟那個檔案 */
    app.addEventListener("dragover",function(e){
      if(!e.dataTransfer)return;
      e.preventDefault();
      app.classList.add("drop");
    });
    app.addEventListener("dragleave",function(e){
      if(e.target===app)app.classList.remove("drop");
    });
    app.addEventListener("drop",function(e){
      e.preventDefault();
      app.classList.remove("drop");
      var fs=(e.dataTransfer&&e.dataTransfer.files)||[];
      if(fs.length)addFiles(Array.prototype.slice.call(fs));
    });

    root.appendChild(app);
    mountTop();
    renderMsgs();
  }

  /* 右上角「日夜切換 ⇄ New chat」變形鈕的驅動（2026-07-30）。
     這裡只算一個 0→1 的進度餵給外殼（外殼負責畫、負責點下去要做什麼）。

     MORPH_PX＝捲多少距離換完。90px 大約是手機上一個小滑動的量：
     太短會在手指微動時就翻面（看起來像閃爍），太長則要捲很久才等到 New chat。
     判斷用的是「離頂端多遠」而不是「離底端多遠」—— 聊天是往下長的，串流時畫面
     一直黏在底部，用離底端算的話會在生成過程中一直抖。

     還沒長到可以捲（scrollHeight 幾乎等於視窗高）就一律回 0：短對話不該讓
     日夜切換莫名其妙消失。 */
  var MORPH_PX=90;
  function morphNew(){
    if(!window.__ipuaMorph||!UI.msgs)return;
    var room=UI.msgs.scrollHeight-UI.msgs.clientHeight;
    window.__ipuaMorph(room<MORPH_PX?0:UI.msgs.scrollTop/MORPH_PX);
  }

  /* ================= 附件（v2.3）================= */
  /* 待送出的附件。兩種形狀：
       { kind:"image", id, url, name, bytes }  已上傳完成，送出時只帶 id
       { kind:"doc", name, text, truncated }   在瀏覽器抽好的文字，送出時併進訊息內容
     圖片是「選好就上傳」而不是「按送出才上傳」—— 使用者挑圖之後通常還要打字，
     那段時間拿來把檔案傳完，按下送出時就不必再等。 */
  var atts=[];

  /* 目前選的模型看不看得懂圖片（管理員在管道裡標的 vision_models）。
     dumb mode 下前端不知道模型是什麼，伺服器另外回一個布林。 */
  function seesImages(){
    if(dumbMode)return !!dumbVision;
    if(!model)return false;
    var pi=model.indexOf("|");
    var cs=pi<0?"":model.slice(0,pi),mn=pi<0?"":model.slice(pi+1);
    for(var i=0;i<groups.length;i++){
      if(groups[i].slug===cs)return (groups[i].vision||[]).indexOf(mn)>=0;
    }
    return false;
  }

  /* 目前的模型單則最多吃幾張圖（v2.4.1）。數字由伺服器算好（上游自己回報的能力，
     見 lib/modelcaps.ts）；取不到就回 0＝不特別限制，交給下面那道 8 個附件的總上限。
     為什麼要在前端擋：有些模型單次只吃 1 張，多送上游直接回 400，而會員看到的只會是
     「上游回應異常」這種無解的字（2026-07-30 事故）。挑第 2 張的當下就講清楚，
     比讓他打完問題、送出、再看到一句看不懂的錯誤好太多。 */
  function maxImgs(){
    if(dumbMode)return dumbImgmax||0;
    if(!model)return 0;
    var pi=model.indexOf("|");
    var cs=pi<0?"":model.slice(0,pi),mn=pi<0?"":model.slice(pi+1);
    for(var i=0;i<groups.length;i++){
      if(groups[i].slug===cs)return (groups[i].imgmax||{})[mn]||0;
    }
    return 0;
  }

  /* 目前待送出的附件裡有幾張圖（文件不算 —— 它在送出時會被轉成文字併進訊息，
     根本不會變成上游眼中的圖片） */
  function imgCount(){
    var n=0;
    for(var i=0;i<atts.length;i++)if(atts[i].kind==="image")n++;
    return n;
  }
  /* 圖片的 bytes 總和，與伺服器的 maxImgBytesTotal 對照。
     **張數不是真正的天花板，這個才是** —— 組上游 body 的 CPU 成本跟總 bytes 成正比，
     跟幾張無關（10 張各 150KB 與 3 張各 500KB 對 CPU 一模一樣）。所以 10 張沒滿
     也可能先撞到這條，必須讓使用者看得到，不能讓伺服器默默砍掉。 */
  function imgBytes(){
    var n=0;
    for(var i=0;i<atts.length;i++)if(atts[i].kind==="image")n+=atts[i].bytes||0;
    return n;
  }
  function bytesBudget(){
    return (window.__PGFILE&&window.__PGFILE.total)||1500000;
  }
  function mb(n){return Math.round(n/100000)/10;}

  /* ＋ 按下去：直接開檔案選擇器，不插一層「上傳照片／上傳檔案」的選單 ——
     多一次點擊只為了選類別，而檔案選擇器本來就分得出來。

     ＋ 永遠是亮的、永遠打得開（2026-07-30 改；在此之前模型看不了圖就整個附件功能關掉）。
     改回來的理由有兩個：
       1. **文件根本不需要 vision** —— PDF／Office 是在瀏覽器裡抽成文字才送出的，
          對上游來說就是一段普通文字。為了圖片的限制把文件一起鎖死是多擋的。
       2. 限制改成擋在「挑到不能用的那個檔案」那一刻，訊息可以講得很具體
          （看不了圖／最多幾張），比一個灰按鈕能傳達的資訊多得多。
     一句話：閘門從「功能總開關」下放到「單一檔案」，能做的事變多、講的話變準。 */
  function attachClick(){
    if(!window.PGA){MU.flash(tx("附件功能載入失敗，請重新整理","Attachment module failed to load — please refresh"));return;}
    pickFiles();
  }

  function pickFiles(){
    var inp=document.createElement("input");
    inp.type="file";inp.multiple=true;
    inp.accept=PGA.acceptImage+","+PGA.acceptDoc;
    inp.style.display="none";
    inp.addEventListener("change",function(){
      var fs=Array.prototype.slice.call(inp.files||[]);
      inp.remove();
      if(fs.length)addFiles(fs);
    });
    document.body.appendChild(inp);
    inp.click();
  }

  /* 一次收一批檔案：圖片走壓縮＋上傳，文件在本地抽文字。
     每個檔案各自成敗、互不影響 —— 一個壞檔不該讓整批都白選。 */
  function addFiles(files){
    if(streaming){MU.flash(tx("回覆生成中 — 先按停止","Still streaming — stop it first"));return;}
    /* 拖放與貼上也走這裡，所以圖片的兩道檢查（看不看得了圖、最多幾張）寫在這個
       函式裡而不是 ＋ 按鈕上 —— 否則就會變成「按鈕擋得住、把檔案拖進來卻可以」的
       隱藏後門，那種不一致最難跟使用者解釋。 */
    /* 伺服器算好的壓縮目標（window.__PGFILE，見 playgroundPageResponse）。
       取不到就退回 1400KB —— 那是純 D1 模式的上限，任何模式下都收得進去。 */
    var maxBytes=(window.__PGFILE&&window.__PGFILE.max)||1400*1024;
    var canImg=seesImages(),lim=maxImgs();
    files.forEach(function(f){
      /* 附件總數的上限（圖片＋文件）。要比「單則最多幾張圖」大，否則圖片還沒到
         自己的上限就先被這條擋掉，訊息會變成前後矛盾（說最多 10 張、8 張就擋）。 */
      if(atts.length>=12){MU.flash(tx("一次最多 12 個附件","Up to 12 attachments at a time"));return;}
      if(PGA.isImage(f)){
        /* 這個模型根本看不了圖。只擋圖片 —— 同一批裡的文件照收，它們會被轉成文字，
           跟 vision 無關。 */
        if(!canImg){
          MU.flash(tx("這個模型看不了圖片 — 請換一個支援視覺的模型",
                      "This model can't read images — switch to a vision model"));
          return;
        }
        /* 模型的張數上限：擋在「加進來」這一步，而不是送出時才砍掉 —— 使用者要能
           當場看到自己到底送得出去幾張，而不是以為 5 張都送到了、模型卻只看到 1 張。
           （2026-07-30 事故就是這樣：一次丟 4 張，上游只吃 1 張，直接回 400。）
           1 張的模型講法特別寫過：那是最容易讓人以為壞掉的情況。 */
        if(lim&&imgCount()>=lim){
          MU.flash(lim===1
            ?tx("這個模型一次只看得懂 1 張圖 — 想比較多張請換一個模型",
                "This model reads only 1 image at a time — switch models to compare several")
            :tx("這個模型一次最多 "+lim+" 張圖","This model takes at most "+lim+" images at a time"));
          return;
        }
        var ph={kind:"image",name:f.name,bytes:f.size,busy:true,url:""};
        atts.push(ph);renderAtts();
        PGA.toImage(f,maxBytes).then(function(img){
          ph.url="data:"+img.mime+";base64,"+img.b64;   /* 本地預覽，不必回讀伺服器 */
          ph.bytes=img.bytes;
          return PGA.upload(img);
        }).then(function(d){
          ph.id=d.id;ph.busy=false;renderAtts();
          /* 壓完才知道真實大小，所以容量檢查放在這裡（挑檔案當下只知道原始大小，
             壓縮後可能差好幾倍）。超了就當場講，但**不自動移除** —— 該犧牲哪一張
             是使用者的決定，不是我們的。 */
          if(imgBytes()>bytesBudget()){
            MU.flash(tx("這幾張圖加起來太大（上限約 "+mb(bytesBudget())+"MB）— 送出前請先移除幾張",
                        "These images exceed the ~"+mb(bytesBudget())+"MB total limit — remove some before sending"));
          }
        }).catch(function(e){
          dropAtt(ph);
          MU.flash(esc(e.message||e));
        });
      }else if(PGA.isDoc(f)){
        /* 第一次讀 PDF 要先下載 1.8MB 的解析器，慢網路可能等好幾秒 —— 先講一聲，
           不然附件晶片就只是卡在「處理中…」，看起來像當掉了。 */
        if(PGA.isPdf(f)&&!PGA.pdfReady())MU.flash(tx("首次讀取 PDF 需要先下載解析器…","Loading PDF parser…"));
        var pd={kind:"doc",name:f.name,bytes:f.size,busy:true,text:""};
        atts.push(pd);renderAtts();
        PGA.toText(f).then(function(r){
          pd.text=r.text;pd.truncated=r.truncated;pd.busy=false;renderAtts();
        }).catch(function(e){
          dropAtt(pd);
          MU.flash(esc(e.message||e));
        });
      }else{
        MU.flash(tx("不支援這種檔案："+f.name,"Unsupported file: "+f.name));
      }
    });
  }

  function dropAtt(a){
    var i=atts.indexOf(a);
    if(i>=0)atts.splice(i,1);
    renderAtts();
  }

  function renderAtts(){
    if(!UI.atts)return;
    UI.atts.innerHTML="";
    UI.atts.style.display=atts.length?"flex":"none";
    atts.forEach(function(a){
      var box=el("div","pg-att"+(a.busy?" busy":""));
      if(a.kind==="image"&&a.url){
        var im=document.createElement("img");im.src=a.url;im.alt=a.name||"";
        box.appendChild(im);
      }else{
        var ic=el("div","fic",a.kind==="image"?"IMG":(PGA.ext(a.name)||"FILE").slice(0,4));
        box.appendChild(ic);
      }
      var meta=el("div","fm");
      meta.appendChild(el("div","fn",a.name||tx("未命名","Untitled")));
      meta.appendChild(el("div","fs",a.busy?tx("處理中…","Processing…")
        :(a.kind==="doc"?tx("文字 "+a.text.length+" 字","text, "+a.text.length+" chars")
                        :PGA.fmtBytes(a.bytes||0))));
      box.appendChild(meta);
      var x=el("button","fx","\\u00d7");
      x.type="button";x.title=tx("移除","Remove");
      x.addEventListener("click",function(){dropAtt(a);});
      box.appendChild(x);
      UI.atts.appendChild(box);
    });
  }
  function busy(){if(streaming){MU.flash(tx("回覆生成中 — 先按停止","Still streaming — stop it first"));return true;}return false;}
  function setEmpty(){
    if(UI.app)UI.app.classList.toggle("empty",!msgs.length);
  }
  // scrollHeight 不含上下邊框且會取整，直接拿來當 height 會差 1~2px（假性溢出 → Windows 擠出捲軸箭頭）。
  function autoGrow(){
    UI.ta.style.height="auto";
    var need=UI.ta.scrollHeight+2;
    UI.ta.style.height=Math.min(need,200)+"px";
    UI.ta.style.overflowY=need>200?"auto":"hidden";
  }

  /* ================= 對話切換（側欄 History 呼叫） ================= */
  function openConv(id){
    if(busy())return;
    api("/api/playground/conversations/"+id).then(function(d){
      cur=id;
      /* 附件是整串一次撈回來的，這裡按 msg_id 分回各則訊息。
         purged=1（內容被淘汰）的照樣掛上去 —— 畫成「檔案已刪除」比整個消失清楚。 */
      var byMsg={};
      (d.files||[]).forEach(function(f){
        if(!f.msg_id)return;
        (byMsg[f.msg_id]=byMsg[f.msg_id]||[]).push({id:f.id,name:f.name,bytes:f.bytes,gone:!!f.purged});
      });
      msgs=(d.messages||[]).map(function(m){
        return{id:m.id,role:m.role,content:m.content,model:m.model,files:byMsg[m.id]||[]};
      });
      if(d.conv&&d.conv.channel&&d.conv.model){
        var v=d.conv.channel+"|"+d.conv.model;
        if(allModels().some(function(x){return x.v===v;})){model=v;updateTitle();}
      }
      if(window.SBH)window.SBH.setActive(id);
      renderMsgs();updateMore();
    }).catch(function(e){MU.flash(esc(e.message||e));});
  }
  function newChat(){
    cur=null;msgs=[];
    atts=[];renderAtts();   /* 換對話＝丟掉還沒送出的附件（它們是屬於那句話的） */
    if(window.SBH)window.SBH.setActive(null);
    renderMsgs();updateMore();
    if(!coarse&&UI.ta&&!UI.ta.disabled)UI.ta.focus();
  }
  /* 外殼側欄的橋接點 */
  window.__pgOpenConv=openConv;
  window.__pgNewChat=function(){if(!busy())newChat();};
  window.__pgConvDeleted=function(id){if(cur===id)newChat();};

  /* ================= 訊息渲染 ================= */
  function renderMsgs(){
    UI.msgs.innerHTML="";
    setEmpty();
    if(!msgs.length){morphNew();return;}   /* 清空＝捲動歸零，右上角要變回日夜切換 */
    msgs.forEach(function(m){
      if(m.role==="user")addUserMsg(m.content,m.files);
      else addAiMsg(m.content,true);
    });
    UI.stick=true;scrollBottom(true);
    /* 內容被整批換掉時瀏覽器不保證會補一次 scroll 事件，這裡自己算一次 */
    morphNew();
  }
  function scrollBottom(force){
    if(force||UI.stick)UI.msgs.scrollTop=UI.msgs.scrollHeight;
  }
  /* 把「使用者打的字」與「併進去的檔案內容」拆開。
     送出時用 【附件：檔名】\\n 內容 這個固定標記串起來（見 send），這裡照樣拆回來，
     檔案內容才不會在氣泡裡攤成一大坨 —— 一個 Excel 抽出來的文字可以有幾萬字。 */
  function splitDocs(s){
    var MK="\\n\\n\\u3010\\u9644\\u4ef6\\uff1a";   /* \\n\\n【附件： */
    var END="\\u3011\\n";                          /* 】\\n */
    var out={text:s,docs:[]};
    var i=s.indexOf(MK);
    if(i<0)return out;
    out.text=s.slice(0,i);
    var rest=s.slice(i);
    while(rest.indexOf(MK)===0){
      var e=rest.indexOf(END);
      if(e<0)break;
      var name=rest.slice(MK.length,e);
      var bodyAt=e+END.length;
      var next=rest.indexOf(MK,bodyAt);
      out.docs.push({name:name,body:next<0?rest.slice(bodyAt):rest.slice(bodyAt,next)});
      rest=next<0?"":rest.slice(next);
    }
    return out;
  }

  function addUserMsg(text,files){
    var m=el("div","m user");
    /* 圖片排在氣泡上方（跟主流聊天網站一致：先看到圖，再看到問題） */
    if(files&&files.length){
      var wrap=el("div","m-atts");
      files.forEach(function(f){
        if(f.gone){
          var g=el("div","m-att-gone","\\u{1F5BC} "+(f.name||tx("圖片","Image"))
            +"\\u30fb"+tx("檔案已刪除","file removed"));
          wrap.appendChild(g);
          return;
        }
        var im=document.createElement("img");
        /* 剛送出的用本地 data URL（零請求）；翻歷史對話的走端點，瀏覽器會快取起來 */
        im.src=f.url||("/api/playground/files/"+f.id);
        im.alt=f.name||"";
        im.loading="lazy";
        im.addEventListener("click",function(){lightbox(im.src);});
        wrap.appendChild(im);
      });
      m.appendChild(wrap);
    }
    var parts=splitDocs(String(text==null?"":text));
    var b=el("div","mb-user");
    if(parts.text)b.textContent=parts.text;
    parts.docs.forEach(function(d){
      var det=document.createElement("details");det.className="mb-doc";
      var sum=document.createElement("summary");
      sum.textContent="\\u{1F4C4} "+d.name;
      det.appendChild(sum);
      var body=el("div","mb-doc-body");body.textContent=d.body;
      det.appendChild(body);
      b.appendChild(det);
    });
    m.appendChild(b);
    /* 自己說過的話也要能複製（跟 AI 回覆一樣）。複製的是「使用者實際打的字」——
       不含附件被併進去的檔案內容，那動輒幾萬字，不會是他想貼到別處的東西。 */
    if(parts.text)addActions(m,parts.text);
    UI.msgs.appendChild(m);scrollBottom();
    return m;
  }

  /* 點縮圖看原圖 */
  function lightbox(src){
    var lb=el("div","pg-lb");
    var im=document.createElement("img");im.src=src;
    lb.appendChild(im);
    lb.addEventListener("click",function(){lb.remove();});
    document.body.appendChild(lb);
  }
  function addAiMsg(content,final){
    var m=el("div","m ai");
    var md=el("div","md");
    if(final){md.innerHTML=mdRender(content);addPreCopy(md);mathify(md);}
    else md.innerHTML='<span class="dots-w"><i></i><i></i><i></i></span>';
    m.appendChild(md);
    if(final&&content)addActions(m,content);
    UI.msgs.appendChild(m);scrollBottom();
    return{box:m,md:md};
  }
  function addActions(box,text){
    var act=el("div","m-act");
    var cp=el("button","mab","\\u29c9 "+tx("複製","Copy"));
    MU.copyBtn(cp,text);
    act.appendChild(cp);box.appendChild(act);
  }
  var rafOn=false,rafNode=null,rafText="";
  function streamPaint(node,text){
    rafNode=node;rafText=text;
    if(rafOn)return;rafOn=true;
    requestAnimationFrame(function(){
      rafOn=false;
      rafNode.md.innerHTML=mdRender(rafText);
      scrollBottom();
    });
  }
  /* ---- 思考過程（推理模型的 reasoning_content）---- */
  // 第一筆思考增量到才建區塊 — 非推理模型完全不會看到這個東西
  function ensureThink(node){
    if(node.think)return node.think;
    var d=el("details","think");d.open=true;
    var s=el("summary",null,tx("思考中…","Thinking…"));
    var b=el("div","think-body");
    d.appendChild(s);d.appendChild(b);
    node.box.insertBefore(d,node.md);
    node.think={box:d,sum:s,body:b,t0:Date.now(),text:"",done:false};
    return node.think;
  }
  function thinkSecs(t){return Math.round((Date.now()-t.t0)/1000);}
  var trafOn=false,trafT=null;
  function thinkPaint(t){
    trafT=t;
    if(trafOn)return;trafOn=true;
    requestAnimationFrame(function(){
      trafOn=false;
      // textContent — 思考內容一律當純文字，不進 markdown、不會被當 HTML 解析
      trafT.body.textContent=trafT.text;
      trafT.sum.textContent=tx("思考中… ","Thinking… ")+thinkSecs(trafT)+"s";
      trafT.body.scrollTop=trafT.body.scrollHeight;
      scrollBottom();
    });
  }
  // 思考結束（正文開始吐、或整串結束）→ 收合並把標題改成最終秒數
  function thinkDone(node){
    var t=node&&node.think;
    if(!t||t.done)return;
    t.done=true;t.box.open=false;
    t.sum.textContent=tx("已思考 ","Thought for ")+thinkSecs(t)+"s";
  }

  /* ================= 送出與串流 ================= */
  function setStreaming(on){
    streaming=on;
    UI.send.classList.toggle("stop",on);
    UI.send.innerHTML=on?STOP_ICON:SEND_ICON;
    UI.send.title=on?tx("停止","Stop"):tx("送出","Send");
    // 輸入框保持可打字（先打下一句），送出由 streaming 旗標擋住
  }
  function send(){
    if(streaming)return;
    var text=UI.ta.value.replace(/\\s+$/,"");
    /* 附件還在壓縮／上傳／抽文字 — 這時送出會漏掉它們，擋下來比默默送出好 */
    var pending=atts.filter(function(a){return a.busy;});
    if(pending.length){MU.flash(tx("附件還在處理中，稍等一下","Attachments still processing…"));return;}
    var imgs=atts.filter(function(a){return a.kind==="image"&&a.id;});
    var docs=atts.filter(function(a){return a.kind==="doc";});
    if(!text.trim()&&!imgs.length&&!docs.length)return;
    if(!model&&!dumbMode){MU.flash(tx("先選一個模型","Pick a model first"));return;}
    /* 送出前最後一道圖片檢查（2026-07-30）。加圖時與換模型時都已經擋過一輪，
       這裡是收口：任何繞過前兩關的路徑（模型清單重載、上傳競態、把舊分頁擱著很久
       才按送出）都會在這裡被攔下來，而不是送出去讓伺服器默默砍掉幾張、或吃上游一發
       400。擋下來不清空輸入框 —— 使用者打的字跟挑的圖都還在，改完就能直接再送。 */
    if(imgs.length){
      if(!seesImages()){
        MU.flash(tx("這個模型看不了圖片 — 請換一個支援視覺的模型，或把圖片移除",
                    "This model can't read images — switch models or remove the images"));
        return;
      }
      var lim3=maxImgs();
      if(lim3&&imgs.length>lim3){
        MU.flash(lim3===1
          ?tx("這個模型一次只看得懂 1 張圖 — 請移除多餘的圖片，或換一個模型",
              "This model reads only 1 image at a time — remove the extras or switch models")
          :tx("這個模型一次最多 "+lim3+" 張圖 — 請移除多餘的圖片",
              "This model takes at most "+lim3+" images — please remove the extras"));
        return;
      }
      /* 容量：張數沒滿也可能先撞到這條（見 imgBytes 的註解）。
         擋在這裡而不是讓伺服器降級 —— 伺服器現在也會回錯誤了，但那要多跑一趟。 */
      if(imgBytes()>bytesBudget()){
        MU.flash(tx("這幾張圖加起來太大（上限約 "+mb(bytesBudget())+"MB）— 請移除幾張再送",
                    "These images exceed the ~"+mb(bytesBudget())+"MB total limit — remove some and try again"));
        return;
      }
    }
    // Dumb mode：channel/model 留空 — 伺服器端會蓋成管理員指定的值
    var pi=model.indexOf("|"),channel=pi<0?"":model.slice(0,pi),mname=pi<0?"":model.slice(pi+1);

    /* 文件類附件在這裡併進訊息內容 —— 從此它就是普通文字，模型不必支援 vision，
       存進 D1、回讀、重送上下文全部照舊，不需要任何特殊處理。
       標記固定用中文全形括號、不隨介面語言變：它同時是「顯示時要摺疊成檔案卡片」的依據，
       跟著語言變的話，用中文送出的訊息改成英文介面回來就散開成一大坨純文字。 */
    var outText=text;
    docs.forEach(function(d){
      outText+=(outText?"\\n\\n":"")+"\\u3010\\u9644\\u4ef6\\uff1a"+d.name+"\\u3011\\n"+d.text
        +(d.truncated?"\\n\\u2026\\uff08\\u6a94\\u6848\\u904e\\u9577\\uff0c\\u4ee5\\u4e0a\\u53ea\\u662f\\u524d\\u9762\\u90e8\\u5206\\uff09":"");
    });
    var sentImgs=imgs.map(function(a){return{id:a.id,url:a.url,name:a.name,bytes:a.bytes};});

    msgs.push({role:"user",content:outText,files:sentImgs});
    setEmpty();
    addUserMsg(outText,sentImgs);
    UI.ta.value="";autoGrow();
    atts=[];renderAtts();
    UI.stick=true;

    var node=addAiMsg("",false);
    var got="";
    /* 這一趟的直通狀態（v2.5）。on 要等收到回應標頭才知道 —— 在那之前一律當轉譯路徑，
       所以就算伺服器把直通關掉，這裡的行為也自動退回 v2.4，不必改前端。 */
    var pt={on:false,log:0,tin:null,tout:null,text:"",status:"ok",saved:false,t0:Date.now()};
    setStreaming(true);
    aborter=("AbortController" in window)?new AbortController():null;

    /* 上下文只帶檔案「編號」，不帶內容 —— 圖片絕不重新上傳（省頻寬，也讓伺服器的
       request.json() 不必去解析幾 MB 的 base64）。內容已經淘汰的（gone）就不帶了，
       伺服器那邊會自動補成文字佔位。 */
    var ctx=msgs.slice(-40).map(function(m){
      var o={role:m.role,content:m.content};
      if(m.files&&m.files.length){
        var ids=m.files.filter(function(f){return f.id&&!f.gone;}).map(function(f){return f.id;});
        if(ids.length)o.files=ids;
      }
      return o;
    });
    fetch("/api/playground/chat",{
      method:"POST",
      headers:{"content-type":"application/json"},
      body:JSON.stringify({conv_id:cur,channel:channel,model:mname,messages:ctx}),
      signal:aborter?aborter.signal:undefined
    }).then(function(r){
      if(!r.ok){
        return r.json().catch(function(){return{};}).then(function(d){
          if(d.conv&&!cur){cur=d.conv;afterConvCreated();}
          // 額度 429 會附 contact_url — 掛在 Error 上帶到 catch，那裡才有 node 可以畫
          var er=new Error(d.hint||d.error||("HTTP "+r.status));
          er.contactUrl=d.contact_url||"";
          throw er;
        });
      }
      /* 伺服器用標頭告訴我們這一趟走哪條路（v2.5）：
           x-pg-mode=passthrough → 下面收到的是**上游的原始 chunk**，而且落地要自己回報
           沒有這個標頭          → 轉譯路徑，跟 v2.4 完全一樣，伺服器已經存好了
         同一頁可能一則直通、一則轉譯（換到 anthropic／gemini 渠道就會切換），
         所以兩種格式都要認得，不能二選一。 */
      if(r.headers.get("x-pg-mode")==="passthrough"){
        pt.on=true;
        pt.log=parseInt(r.headers.get("x-pg-log")||"0",10)||0;
        livePt=pt;
      }
      var reader=r.body.getReader(),dec=new TextDecoder(),buf="";
      function pump(){
        return reader.read().then(function(s){
          if(s.done)return;
          buf+=dec.decode(s.value,{stream:true});
          var i;
          while((i=buf.indexOf("\\n"))>=0){
            var line=buf.slice(0,i).replace(/\\r$/,"");buf=buf.slice(i+1);
            if(line.indexOf("data:")!==0)continue;
            var p=line.slice(5).trim();
            if(!p||p==="[DONE]")continue;   /* [DONE] 是上游的收尾訊框（直通才看得到） */
            var j=null;try{j=JSON.parse(p);}catch(e){continue;}
            /* ── 直通：上游原始形狀 {choices:[{delta:{content|reasoning_content}}]} ── */
            if(j.choices){
              var c0=j.choices[0],dl=c0&&c0.delta;
              if(dl){
                var rc=dl.reasoning_content||dl.reasoning;
                if(rc){var th2=ensureThink(node);th2.text+=rc;thinkPaint(th2);}
                if(dl.content){thinkDone(node);got+=dl.content;pt.text=got;streamPaint(node,got);}
              }
              /* 上游的 usage 訊框（我們自己加的 stream_options.include_usage）——
                 直通模式伺服器看不到它，只有這裡收得到，串完要交回去補進 req_log。 */
              if(j.usage){
                if(typeof j.usage.prompt_tokens==="number")pt.tin=j.usage.prompt_tokens;
                if(typeof j.usage.completion_tokens==="number")pt.tout=j.usage.completion_tokens;
              }
              continue;
            }
            /* ── 轉譯：伺服器統一過的極簡形狀（也含直通的第一筆 {conv}）── */
            if(j.conv&&!cur){cur=j.conv;afterConvCreated();}
            if(j.log&&!pt.log)pt.log=j.log;
            if(j.r){var th=ensureThink(node);th.text+=j.r;thinkPaint(th);}
            // 正文第一個字＝思考階段結束（沒思考過的話這是 no-op）
            if(j.d){thinkDone(node);got+=j.d;pt.text=got;streamPaint(node,got);}
            if(j.error){
              thinkDone(node);
              /* 直通模式下這是**上游的原文**（會露出提供商身分）。伺服器那條路有 safeHint
                 幫忙淨化，直通沒有，所以分界移到這裡：管理員看全文，會員看安全字。 */
              var em=j.hint||(j.error&&j.error.message)||j.error;
              if(pt.on&&!(me&&me.is_admin))em=tx("上游發生錯誤，請稍後再試","Upstream error, please try again");
              showErr(node,String(em),j.contact_url);
              pt.status="upstream-error";
            }
          }
          return pump();
        });
      }
      return pump();
    }).catch(function(e){
      if(e&&e.name==="AbortError")pt.status="aborted";
      else{showErr(node,String(e&&e.message||e),e&&e.contactUrl);pt.status="upstream-error";}
    }).then(function(){
      finishStream(node,got,pt);
    });
  }
  /* 直通模式的落地回報。beacon＝關網頁那一刻用 sendBeacon（不保證送達，但比什麼都不做好）。
     ⚠ sendBeacon 與 keepalive fetch 都有 64KB 本體上限 —— 超長回覆在「關網頁」這條路上
     會送不出去（正常串完那條路沒有這個限制）。這是已知邊界，記在 DEBT。 */
  function ptSave(pt,conv,text,status,beacon){
    if(!pt||!pt.on||!conv||pt.saved)return;
    if(!text&&status==="ok")status="empty-output";
    var body=JSON.stringify({conv_id:conv,log_id:pt.log||0,content:text||"",
      tokens_in:pt.tin,tokens_out:pt.tout,dur_ms:Date.now()-pt.t0,status:status});
    if(beacon&&navigator.sendBeacon){
      try{navigator.sendBeacon("/api/playground/chat/save",new Blob([body],{type:"application/json"}));return;}catch(e){}
    }
    pt.saved=true;
    fetch("/api/playground/chat/save",{method:"POST",headers:{"content-type":"application/json"},body:body})
      .catch(function(){pt.saved=false;});
  }
  /* 關掉分頁／切到背景：把已經收到的部分先送回去。轉譯路徑不需要這個（伺服器自己會存，
     而且還會在背景把回覆跑完 —— 那是直通模式換不到的東西，見 ADR-0014）。 */
  window.addEventListener("pagehide",function(){
    if(livePt&&livePt.on&&!livePt.saved)ptSave(livePt,cur,livePt.text||"","aborted",true);
  });
  /* 新對話在伺服器端建立完成：更新側欄 History＋右上「⋯」（體驗模式沒有側欄歷史） */
  function afterConvCreated(){
    updateMore();
    if(!demoMode&&window.SBH){window.SBH.refresh();window.SBH.setActive(cur);}
  }
  // 額度用完之類的錯誤，伺服器會附 contact_url — 直接放一顆跟登入閘門同款的「聯絡我」鈕，
  // 比丟一長串網址叫人自己複製好按。
  //
  // ⚠ 這整段是「樣板字串裡的 JS」：反斜線會先被樣板字串吃掉一層，正則要寫成 \\s、\\/ 才對。
  // 少跳一次的話這包腳本會整個解析失敗 → /playground 永遠停在轉圈圈，而且 console 之外
  // 完全看不出來（頁面沒有任何錯誤畫面）。2026-07-21 實際踩過一次。
  // 所以這裡刻意只用字串操作，連正則都不碰。
  function showErr(node,msg,contact){
    var s=String(msg==null?"":msg);
    // hint 尾端那份網址是給 /relay 的 API 使用者看的（他們沒有前端可以渲染按鈕）；
    // 網頁這邊已經有按鈕了，把它切掉免得同一條網址在同一格出現兩次。
    if(contact){
      var tail="："+contact;
      if(s.length>tail.length&&s.slice(-tail.length)===tail)s=s.slice(0,s.length-tail.length);
    }
    var er=el("div","m-err",s);
    if(contact)er.appendChild(MU.contactBtn(contact));
    node.box.appendChild(er);
  }
  function finishStream(node,got,pt){
    setStreaming(false);aborter=null;
    thinkDone(node); // 只思考沒正文時，這裡才會是結束思考的時機
    /* 直通模式：伺服器沒看過這段內容，由這裡交回去落地（含 token 用量）。
       放在最前面 —— 後面的 Markdown／數學渲染萬一丟例外，回覆也已經送出去了。 */
    if(pt&&pt.on){ptSave(pt,cur,got,pt.status,false);livePt=null;}
    if(got){
      msgs.push({role:"assistant",content:got,model:modelName()});
      node.md.innerHTML=mdRender(got);
      addPreCopy(node.md);
      mathify(node.md);   /* 串流結束才渲染數學（中途公式常常只有半截） */
      addActions(node.box,got);
    }else{
      var d=node.md.querySelector(".dots-w");if(d)d.remove();
    }
    if(cur&&!demoMode&&window.SBH)window.SBH.refresh();
    scrollBottom();
    if(!coarse)UI.ta.focus();
  }

  start();
})();
`;
