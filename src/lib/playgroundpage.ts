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
  .m.user{display:flex;justify-content:flex-end}
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
  /* 訊息氣泡裡的附件（使用者訊息，圖片在文字上方） */
  .m-atts{display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end;margin-bottom:6px}
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
  const body =
    '<div id="root"><div class="gate"><div class="spin"></div></div></div>\n' +
    '<script data-nonce src="' +
    assetSrc("marked.js") +
    '"></script>\n' +
    // 附件處理（圖片壓縮、Office 抽文字、上傳）。只有這一頁需要，其他頁不載。
    '<script data-nonce src="' +
    assetSrc("pgattach.js") +
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
  var streaming=false,aborter=null;
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
    var raw=null;
    try{
      if(window.marked&&marked.parse)raw=marked.parse(text,{breaks:true,async:false});
    }catch(e){raw=null;}
    if(raw==null)return textHtml(text);
    var tpl=document.createElement("template");
    tpl.innerHTML=raw;
    sanitize(tpl.content);
    return tpl.innerHTML;
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
          return api("/api/playground/models").then(function(r){groups=r.rows||[];dumbMode=!!r.dumb;dumbVision=!!r.vision;buildApp();});
        });
      }
      if(!hasSvc()){paint();return;}
      return api("/api/playground/models").then(function(r){
        groups=r.rows||[];
        dumbMode=!!r.dumb;   // 模型被鎖定且隱藏：清單是空的但照樣能聊
        dumbVision=!!r.vision;
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
          /* 換到看不了圖的模型時，還掛著的圖片附件會在送出時被伺服器擋下來（400）。
             與其讓人打完字才發現，不如當下就清掉並講明原因。 */
          if(!seesImages()){
            var had=atts.filter(function(a){return a.kind==="image";}).length;
            if(had){
              atts=atts.filter(function(a){return a.kind!=="image";});
              renderAtts();
              MU.flash(tx("這個模型看不了圖片，已移除附加的圖片","This model can't read images — attached images removed"));
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
    });
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
    var plus=el("button","pg-plus");
    plus.type="button";plus.textContent="\\uff0b";
    plus.title=tx("附加檔案","Attach files");
    plus.addEventListener("click",function(e){e.stopPropagation();attachMenu(plus);});
    row.appendChild(plus);
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

  function attachMenu(btn){
    if(!window.SBPOP)return;
    /* pgattach.js 沒載進來（網路壞了／被擋）→ 講清楚，不要讓按鈕按下去毫無反應 */
    if(!window.PGA){MU.flash(tx("附件功能載入失敗，請重新整理","Attachment module failed to load — please refresh"));return;}
    var canImg=seesImages();
    window.SBPOP.open(btn,function(p){
      var it=window.SBPOP.item(p,tx("上傳照片","Upload photo"),function(){
        if(canImg)pickFiles(true);
        else MU.flash(tx("目前的模型看不了圖片 — 請先在上方換一個支援視覺的模型","This model can't read images — pick a vision model above"));
      });
      /* 不支援時不把選項藏起來，而是留著並變灰：藏起來的話使用者只會覺得「功能壞了」，
         留著才看得出「有這個功能，只是這個模型不行」。 */
      if(!canImg){it.style.opacity=".45";it.title=tx("目前的模型看不了圖片","Current model can't read images");}
      window.SBPOP.item(p,tx("上傳檔案","Upload file"),function(){pickFiles(false);});
    });
  }

  function pickFiles(imageOnly){
    var inp=document.createElement("input");
    inp.type="file";inp.multiple=true;
    inp.accept=imageOnly?PGA.acceptImage:PGA.acceptDoc;
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
    var maxBytes=1400*1024;   /* 跟伺服器 FILE_DEFAULTS.pgfile_max_kb 一致（超過那邊也會擋） */
    files.forEach(function(f){
      if(atts.length>=8){MU.flash(tx("一次最多 8 個附件","Up to 8 attachments at a time"));return;}
      if(PGA.isImage(f)){
        if(!seesImages()){
          MU.flash(tx("目前的模型看不了圖片","This model can't read images"));
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
        }).catch(function(e){
          dropAtt(ph);
          MU.flash(esc(e.message||e));
        });
      }else if(PGA.isDoc(f)){
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
    if(!msgs.length)return;
    msgs.forEach(function(m){
      if(m.role==="user")addUserMsg(m.content,m.files);
      else addAiMsg(m.content,true);
    });
    UI.stick=true;scrollBottom(true);
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
    if(final){md.innerHTML=mdRender(content);addPreCopy(md);}
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
            if(!p)continue;
            var j=null;try{j=JSON.parse(p);}catch(e){continue;}
            if(j.conv&&!cur){cur=j.conv;afterConvCreated();}
            if(j.r){var th=ensureThink(node);th.text+=j.r;thinkPaint(th);}
            // 正文第一個字＝思考階段結束（沒思考過的話這是 no-op）
            if(j.d){thinkDone(node);got+=j.d;streamPaint(node,got);}
            if(j.error){thinkDone(node);showErr(node,j.hint||j.error,j.contact_url);}
          }
          return pump();
        });
      }
      return pump();
    }).catch(function(e){
      if(!(e&&e.name==="AbortError"))showErr(node,String(e&&e.message||e),e&&e.contactUrl);
    }).then(function(){
      finishStream(node,got);
    });
  }
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
  function finishStream(node,got){
    setStreaming(false);aborter=null;
    thinkDone(node); // 只思考沒正文時，這裡才會是結束思考的時機
    if(got){
      msgs.push({role:"assistant",content:got,model:modelName()});
      node.md.innerHTML=mdRender(got);
      addPreCopy(node.md);
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
