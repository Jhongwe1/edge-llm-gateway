// GET /relay — API 中轉站（會員頁）。
// 未登入 → 登入閘門；待核准 → 提示等核准；已核准 → 顯示自己的金鑰、可用管道與接法範例。
// 管理員另外看到「管道管理」卡：新增／編輯／刪除上游管道（存 relay_channels 表）。
// 真正的轉發在 src/routes/relay/[[path]].ts；這頁只是操作面板，所有寫入都打 API。
import { html, pageShell } from "./site.js";
import { getChromeFor } from "./chrome.js";
import { MEMBER_CSS, MEMBER_JS } from "./memberui.js";
import { PG_DEFAULT_SYSTEM, pgDefaultSystem } from "./playground.js";
import type { Env } from "../types.js";

const PAGE_CSS = `
  .card{border:1px solid var(--line);border-radius:13px;padding:16px 18px;margin-bottom:16px;background:var(--card)}
  .card h2{font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:0 0 12px;padding-bottom:9px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;gap:8px}
  .btn{border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:8px;padding:9px 15px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;transition:.15s;white-space:nowrap}
  .btn:hover{border-color:var(--line2)}
  .btn.pri{background:var(--accent);color:var(--accent-fg);border-color:var(--line2)}
  .btn.danger:hover{border-color:#c33;color:#c33}
  .btn:disabled{opacity:.5;cursor:default}
  .field{margin-bottom:12px}
  .field label{display:block;font-size:12px;font-weight:700;color:var(--muted);letter-spacing:.05em;margin-bottom:5px}
  .field input,.field select{width:100%;border:1px solid var(--line);background:var(--field);color:var(--fg);border-radius:8px;padding:10px 11px;font-size:14px;font-family:inherit;outline:none;box-sizing:border-box}
  .field input:focus,.field select:focus{border-color:var(--line2)}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  @media(max-width:560px){.grid2{grid-template-columns:1fr}}
  .chlist .rowline .t2 code{font-size:11.5px}
  .tag{font-size:10.5px;font-weight:700;border:1px solid var(--line);border-radius:5px;padding:1px 6px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
  .mrow{display:flex;gap:6px;flex-wrap:wrap;margin-top:7px}
  /* 模型複製鈕。文字一律不換行 —— 讓長模型名撐成兩行會使同一排的晶片高矮不一，
     手機上尤其醜（2026-07-29 站長截圖回報）。塞不下就靠 min-width:0＋ellipsis 截斷，
     反正點下去複製的是完整名稱，title 也有全名。 */
  .mchip{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line);background:var(--field);color:var(--fg);border-radius:7px;padding:4px 9px;font-size:12px;font-weight:600;cursor:pointer;font-family:ui-monospace,Menlo,Consolas,monospace;transition:.15s;max-width:100%;min-width:0}
  .mchip:hover{border-color:var(--line2)}
  .mchip .mn{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
  .mchip .cp{opacity:.55;font-family:inherit;flex:0 0 auto}
  /* 手機：一顆一行、等寬對齊，模型名靠左、複製圖示靠右 —— 比擠成不等寬的兩排好讀 */
  @media(max-width:560px){
    .mrow{flex-direction:column;align-items:stretch}
    .mchip{justify-content:space-between}
  }
  /* 管道列的按鈕組（↑ ↓ 停用 編輯 刪除） */
  .rowline .acts{display:flex;gap:6px;flex-wrap:wrap;flex:0 0 auto}
  /* 手機：整列改直向 —— 第一行資訊、第二行按鈕。
     橫向排時五顆按鈕會把左邊的文字欄壓到只剩一個字寬（.g 有 min-width:0，
     會一路被壓縮），整欄變成一個字一行的長條（2026-07-29 站長截圖回報）。 */
  @media(max-width:560px){
    .chlist .rowline,.chadmin .rowline{flex-direction:column;align-items:stretch;gap:10px}
    .chadmin .rowline .acts{width:100%}
    /* 五顆按鈕等分寬度排成一列。原本讓它們照內容寬度排，結果是 4+1 —— 「刪除」
       被擠到下一行還撐滿整排，而那種寬度最容易誤按。等分之後每顆 60px，
       Disable／Enable／Edit／Delete 的字都放得下（實測 390px 視窗）。 */
    .chadmin .rowline .acts .btn{flex:1 1 0;min-width:0;padding-left:6px;padding-right:6px}
    /* 「可用管道」那列只有一顆「複製網址」，讓它撐滿比縮在右邊好按 */
    .chlist .rowline>.btn{width:100%}
  }
  .field textarea{width:100%;border:1px solid var(--line);background:var(--field);color:var(--fg);border-radius:8px;padding:10px 11px;font-size:13px;font-family:ui-monospace,Menlo,Consolas,monospace;line-height:1.7;outline:none;box-sizing:border-box;resize:vertical}
  .field textarea:focus{border-color:var(--line2)}
  .egtabs{display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap}
  .egtab{border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:7px;padding:6px 12px;font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit}
  .egtab.on{background:var(--accent);color:var(--accent-fg);border-color:var(--line2)}
`;

export async function relayPageResponse(env: Env, request: Request): Promise<Response> {
  const { chrome } = await getChromeFor(env, request); // 選單依身分過濾（VPN 隱形）
  // 渠道視窗「系統提示詞」欄的灰字＝這個渠道留空時伺服器實際會送出的那段。
  // 站台預設可在 /settings 改（settings.pg_default_system），所以要每次請求現查、
  // 不能像以前那樣把 PG_DEFAULT_SYSTEM 直接烤進 RELAY_JS — 烤進去的話管理員改了站台預設，
  // 這裡的灰字還停在舊值，就會出現「灰字說一套、實際送另一套」。
  const defSys = await pgDefaultSystem(env);
  const body =
    '<div id="root"><div class="gate"><div class="spin"></div></div></div>\n' +
    "<script data-nonce>window.__pgDefSys=" +
    JSON.stringify(defSys).replace(/</g, "\\u003c") +
    ";</script>\n" +
    "<script data-nonce>" +
    MEMBER_JS +
    "</script>\n" +
    "<script data-nonce>" +
    RELAY_JS +
    "</script>";
  return html(
    pageShell({
      title: "API 中轉站",
      tkey: "page.relay",
      desc: "會員專用的 API 中轉站 — 用一把金鑰、一個網址接上各家 AI API。",
      noindex: true,
      chrome: chrome,
      activePath: "/relay",
      h1: '<a href="/" data-zh="API 中轉站" data-en="API relay">API 中轉站</a>',
      headExtra: "<style>" + MEMBER_CSS + PAGE_CSS + "</style>\n",
      body: body
    })
  );
}

const RELAY_JS = `
(function(){
  "use strict";
  var $=MU.$,el=MU.el,tx=MU.tx,esc=MU.esc,origin=MU.origin;
  var root=$("root"),me=null,channels=[];

  function api(path,opts){
    opts=opts||{};opts.headers=opts.headers||{};
    if(opts.json!==undefined){opts.method=opts.method||"POST";opts.headers["content-type"]="application/json";opts.body=JSON.stringify(opts.json);delete opts.json;}
    return fetch(path,opts).then(function(r){
      return r.json().catch(function(){return{};}).then(function(d){
        if(!r.ok)throw new Error(d.hint||d.error||("HTTP "+r.status));
        return d;
      });
    });
  }

  // 分服務批准：要有 relay 服務才能用這一頁
  function canUse(){return !!(me&&(me.services||[]).indexOf("relay")>=0);}
  // 依目前狀態畫面（切語言時直接重畫，不重打 API）
  function paint(){
    if(!me){MU.gateLogin(root,tx("API 中轉站","API relay"),tx("請先用 Google 登入","Please sign in with Google first."));return;}
    if(!canUse()){MU.gatePending(root,me);return;}
    render();
  }
  function start(){
    MU.me(true).then(function(u){
      me=u;
      if(canUse()){
        return fetch("/api/relay/channels",{cache:"no-store"}).then(function(r){return r.json();}).then(function(d){channels=d.rows||[];paint();});
      }
      paint();
    }).catch(function(e){root.innerHTML='<div class="gate"><p>'+tx("讀取失敗：","Failed: ")+esc(e.message||e)+'</p></div>';});
  }
  MU.onLang(paint);

  function render(){
    root.innerHTML="";
    root.appendChild(MU.acctCard(me));

    // 金鑰卡
    var kc=el("div","card");
    var h=el("h2",null,tx("你的中轉金鑰","Your relay key"));
    kc.appendChild(h);
    kc.appendChild(el("p","lead",tx("把 AI 工具的 API Key 換成這一把、Base URL 換成下面管道的網址即可。金鑰只在產生當下顯示一次。","Use this as your API key and the channel URL below as the base URL. The key is shown only once when generated.")));
    var kbox=el("div","kbox");
    var codeEl=el("div","code");
    codeEl.id="keyView";
    codeEl.textContent=me.has_key?(tx("目前金鑰：","Current: ")+me.key_hint):tx("尚未產生金鑰","No key yet");
    kbox.appendChild(codeEl);
    var gen=el("button","copy2",me.has_key?tx("重新產生","Regenerate"):tx("產生金鑰","Generate"));
    kbox.appendChild(gen);
    kc.appendChild(kbox);
    var note=el("div","muted");note.style.marginTop="8px";
    note.textContent=me.has_key&&me.key_at?tx("上次產生：","Last generated: ")+new Date(me.key_at).toLocaleString():"";
    kc.appendChild(note);
    // 今日用量（/api/me 的 usage 區塊；管理員無上限顯示 ∞）
    if(me.usage&&me.usage.relay_today!=null){
      var uq=el("div","muted");uq.style.marginTop="4px";
      uq.textContent=tx("今日用量：","Today: ")+me.usage.relay_today+" / "+
        (me.usage.relay_limit==null?"∞":me.usage.relay_limit)+
        tx("（UTC 午夜重置）"," (resets at UTC midnight)");
      kc.appendChild(uq);
    }
    root.appendChild(kc);

    gen.addEventListener("click",function(){
      if(me.has_key&&!confirm(tx("重新產生會讓舊金鑰立刻失效，確定？","Regenerating will immediately invalidate the old key. Continue?")))return;
      gen.disabled=true;gen.textContent=tx("產生中…","Working…");
      api("/api/account/key",{method:"POST"}).then(function(d){
        // 明文金鑰只回這一次：整顆顯示＋一鍵複製
        codeEl.textContent=d.key;
        var cp=el("button","copy2 ghosty",tx("複製","Copy"));
        MU.copyBtn(cp,d.key);
        // 換掉按鈕
        gen.replaceWith(cp);
        me.has_key=true;me.key_hint=d.key_hint;me.key_at=d.key_at;
        note.textContent=tx("已產生 — 請立刻複製保存，離開後只會看到提示。","Generated — copy it now; you won't see it again.");
        MU.flash(tx("金鑰已產生","Key generated"));
      }).catch(function(e){gen.disabled=false;gen.textContent=tx("重新產生","Regenerate");MU.flash(esc(e.message||e));});
    });

    // 管道卡
    var cc=el("div","card");
    cc.appendChild(el("h2",null,tx("可用管道","Channels")));
    if(!channels.length){
      cc.appendChild(el("p","muted",tx("管理員還沒設定任何上游管道。","No upstream channels configured yet.")));
    }else{
      var list=el("div","chlist");
      channels.forEach(function(c){
        var row=el("div","rowline");
        var g=el("div","g");
        var t1=el("div","t1");t1.appendChild(document.createTextNode(c.name+"  "));
        var tag=el("span","tag",c.kind);t1.appendChild(tag);
        g.appendChild(t1);
        var t2=el("div","t2");
        t2.innerHTML="<code>"+esc(origin)+"/relay/"+esc(c.slug)+"</code>";
        g.appendChild(t2);
        // 模型名稱：一顆一顆的複製鈕（點一下就複製，直接貼到 App 的 model 欄位）
        if(c.models&&c.models.length){
          var mr=el("div","mrow");
          c.models.forEach(function(m){
            var chip=el("button","mchip");
            chip.appendChild(el("span","mn",m));   /* 名稱獨立一格才好做「不換行＋截斷」 */
            chip.appendChild(el("span","cp","⧉"));
            /* 名稱太長被截斷時，title 仍看得到完整的 */
            chip.title=m+" — "+tx("點一下複製","click to copy");
            MU.copyBtn(chip,m);
            mr.appendChild(chip);
          });
          g.appendChild(mr);
        }
        row.appendChild(g);
        var cp=el("button","btn",tx("複製網址","Copy URL"));
        MU.copyBtn(cp,origin+"/relay/"+c.slug);
        row.appendChild(cp);
        list.appendChild(row);
      });
      cc.appendChild(list);
    }
    root.appendChild(cc);

    // 範例卡
    if(channels.length)root.appendChild(exampleCard());

    // 管理員：管道管理
    if(me.is_admin)root.appendChild(adminCard());
  }

  function exampleCard(){
    var c=channels[0];
    var base=origin+"/relay/"+c.slug;
    var key=me.key_hint||"uak-…";
    var mdl=(c.models&&c.models[0])||"gpt-4o-mini";
    var card=el("div","card");
    card.appendChild(el("h2",null,tx("怎麼接（範例）","How to connect")));
    var egs={
      openai:"curl "+base+"/v1/chat/completions \\\\\\n  -H \\"Authorization: Bearer "+key+"\\" \\\\\\n  -H \\"content-type: application/json\\" \\\\\\n  -d '{\\"model\\":\\""+mdl+"\\",\\"messages\\":[{\\"role\\":\\"user\\",\\"content\\":\\"hi\\"}]}'",
      python:"from openai import OpenAI\\nclient = OpenAI(\\n    base_url=\\""+base+"/v1\\",\\n    api_key=\\""+key+"\\",\\n)\\nr = client.chat.completions.create(\\n    model=\\""+mdl+"\\",\\n    messages=[{\\"role\\":\\"user\\",\\"content\\":\\"hi\\"}],\\n)",
      app:tx("在 App／外掛的設定裡：\\n  • API Base URL（或 Host）填： ","In your app/extension settings:\\n  • API Base URL: ")+base+tx("\\n  • API Key 填你上面那把 uak- 金鑰\\n（OpenAI 相容欄位通常會自動補 /v1）","\\n  • API Key: your uak- key above")
    };
    var tabs=el("div","egtabs");
    var pre=el("pre","code");
    var names={openai:"curl",python:"Python",app:tx("App 設定","App")};
    ["openai","python","app"].forEach(function(k,i){
      var b=el("button","egtab"+(i===0?" on":""),names[k]);
      b.addEventListener("click",function(){
        [].forEach.call(tabs.children,function(x){x.classList.remove("on");});
        b.classList.add("on");pre.textContent=egs[k];
      });
      tabs.appendChild(b);
    });
    pre.textContent=egs.openai;
    card.appendChild(tabs);card.appendChild(pre);
    var note=el("div","muted");note.style.marginTop="10px";
    note.textContent=tx("Claude 用管道會走 /v1/messages，Gemini 走 /v1beta/models/…；路徑照上游原本的填，中轉只換金鑰不改路徑。","Anthropic uses /v1/messages, Gemini /v1beta/…; keep the upstream path as-is.");
    card.appendChild(note);
    return card;
  }

  /* ===== 管理員：管道管理 ===== */
  function adminCard(){
    var card=el("div","card");
    var h=el("h2");h.appendChild(document.createTextNode(tx("管道管理（管理員）","Channels admin")));
    var add=el("button","btn pri",tx("＋ 新增","＋ Add"));
    h.appendChild(add);card.appendChild(h);
    var box=el("div","chadmin");card.appendChild(box);
    reloadAdmin(box);
    add.addEventListener("click",function(){editChannel(null,box);});
    return card;
  }
  function reloadAdmin(box){
    api("/api/admin/relay/channels").then(function(d){
      box.innerHTML="";
      var rows=d.rows||[];
      if(!rows.length){box.appendChild(el("p","muted",tx("還沒有管道，按「＋ 新增」建立第一個。","No channels yet.")));return;}
      rows.forEach(function(c,idx){
        var row=el("div","rowline");
        var g=el("div","g");
        var t1=el("div","t1");
        t1.appendChild(document.createTextNode((c.enabled?"":"（停用）")+c.name+"  "));
        t1.appendChild(el("span","tag",c.kind));
        g.appendChild(t1);
        var t2=el("div","t2");
        t2.textContent="/relay/"+c.slug+" → "+c.base_url+"  ·  "+(c.has_key?tx("金鑰：","key: ")+c.key_hint:tx("⚠ 未設金鑰","⚠ no key"));
        g.appendChild(t2);
        var t3=el("div","t2");
        t3.textContent=(c.models&&c.models.length)
          ?tx("模型：","models: ")+c.models.join(", ")
          :tx("⚠ 還沒設定模型名稱（編輯補上）","⚠ no models yet");
        g.appendChild(t3);row.appendChild(g);
        /* 排序：↑↓ 交換相鄰兩個管道的位置。
           決定 Playground 模型選單裡「管道之間」的先後；管道**之內**的模型順序
           照編輯視窗那份清單的行序（把想排前面的模型移到第一行即可）。 */
        var up=el("button","btn","\\u2191");
        up.title=tx("往上移（模型選單的順序）","Move up (order in the model menu)");
        up.disabled=idx===0;
        up.addEventListener("click",function(){moveChannel(rows,idx,-1,box);});
        var dn=el("button","btn","\\u2193");
        dn.title=tx("往下移","Move down");
        dn.disabled=idx===rows.length-1;
        dn.addEventListener("click",function(){moveChannel(rows,idx,1,box);});
        var tg=el("button","btn",c.enabled?tx("停用","Disable"):tx("啟用","Enable"));
        tg.addEventListener("click",function(){
          tg.disabled=true;
          var p=chPayload(c);p.enabled=!c.enabled;
          api("/api/admin/relay/channels/"+c.id,{method:"PUT",json:p})
            .then(function(){reloadAdmin(box);MU.flash(c.enabled?tx("已停用","Disabled"):tx("已啟用","Enabled"));})
            .catch(function(e){tg.disabled=false;MU.flash(esc(e.message||e));});
        });
        var ed=el("button","btn",tx("編輯","Edit"));ed.addEventListener("click",function(){editChannel(c,box);});
        var del=el("button","btn danger",tx("刪除","Delete"));
        del.addEventListener("click",function(){
          if(!confirm(tx("刪除管道「"+c.name+"」？","Delete channel?")))return;
          api("/api/admin/relay/channels/"+c.id,{method:"DELETE"}).then(function(){reloadAdmin(box);MU.flash(tx("已刪除","Deleted"));}).catch(function(e){MU.flash(esc(e.message||e));});
        });
        /* 按鈕包成一組。不包的話它們是 .rowline 的直接子元素，
           手機版把 .rowline 改成直向堆疊時，五顆鈕會各自佔一整行。 */
        var acts=el("div","acts");
        acts.appendChild(up);acts.appendChild(dn);
        acts.appendChild(tg);acts.appendChild(ed);acts.appendChild(del);
        row.appendChild(acts);
        box.appendChild(row);
      });
    }).catch(function(e){box.innerHTML='<p class="muted">'+esc(e.message||e)+'</p>';});
  }

  /* 管道的完整欄位包。
     ⚠ 任何 PUT 都一定要帶「完整」欄位：cleanChannel 對沒帶的選填欄位一律當成空字串寫回去
     （PUT＝整包覆蓋，不是 PATCH），少帶一欄就是把那欄的資料洗掉。
     2026-07-29 就踩過這個 bug —— 停用/啟用鈕原本只帶 6 欄，按一下停用再啟用，
     該管道的系統提示詞與額外請求參數就無聲消失，而管理員完全不會發現。
     抽成這個函式就是為了不要再有第二個地方漏帶；**以後新增管道欄位，改這裡一處就好**。 */
  function chPayload(c){
    return {name:c.name,slug:c.slug,kind:c.kind,base_url:c.base_url,models:c.models,
            system_prompt:c.system_prompt,extra_body:c.extra_body,vision_models:c.vision_models,
            sort_order:c.sort_order,enabled:!!c.enabled};
  }

  /* 上移／下移：交換位置後把**整份清單**重新編號送出。
     只 PUT 被交換的那兩個會有個坑 —— 初始狀態所有 sort_order 都是 0（照 id 排），
     交換 0 和 0 等於什麼都沒發生。整份重編號就不必處理這種特例，
     而管道數量本來就只有個位數，多幾個請求無所謂。 */
  function moveChannel(rows,idx,dir,box){
    var j=idx+dir;
    if(j<0||j>=rows.length)return;
    var arr=rows.slice();
    var t=arr[idx];arr[idx]=arr[j];arr[j]=t;
    Promise.all(arr.map(function(c,i){
      var p=chPayload(c);p.sort_order=(i+1)*10;   /* 留間隔，之後要插隊也不必全部重算 */
      return api("/api/admin/relay/channels/"+c.id,{method:"PUT",json:p});
    })).then(function(){
      reloadAdmin(box);
      MU.flash(tx("順序已更新","Order updated"));
    }).catch(function(e){MU.flash(esc(e.message||e));});
  }
  function editChannel(c,box){
    var isNew=!c;c=c||{kind:"openai",enabled:1};
    var ov=el("div","mu-ov");
    var dlg=el("div","card mu-dlg");dlg.style.maxWidth="420px";
    dlg.appendChild(el("h2",null,isNew?tx("新增管道","New channel"):tx("編輯管道","Edit channel")));
    function field(label,id,val,ph){
      var f=el("div","field");f.appendChild(el("label",null,label));
      var i=el("input");i.id=id;i.value=val||"";if(ph)i.placeholder=ph;i.autocomplete="off";f.appendChild(i);dlg.appendChild(f);return i;
    }
    var fName=field(tx("顯示名稱","Name"),"cName",c.name,"OpenAI");
    // 網址代稱（slug）2026-07-14 起不用填：伺服器從名稱自動產生（轉不出英數就隨機）；編輯時沿用舊代稱
    // kind（決定金鑰怎麼帶給上游）
    var kf=el("div","field");kf.appendChild(el("label",null,tx("類型（決定金鑰怎麼帶給上游）","Kind")));
    var sel=el("select");
    [["openai",tx("OpenAI（含相容服務／本地模型）","OpenAI (and compatible)")],
     ["anthropic",tx("Anthropic（Claude）","Anthropic (Claude)")],
     ["gemini",tx("Google Gemini","Google Gemini")],
     ["custom",tx("自訂（OpenAI 相容介面）","Custom (OpenAI-compatible)")]].forEach(function(p){
      var o=el("option",null,p[1]);o.value=p[0];if(c.kind===p[0])o.selected=true;sel.appendChild(o);
    });
    kf.appendChild(sel);dlg.appendChild(kf);
    // Base URL 只填「根網址」：/v1、/v1beta 這段版本路徑由程式依 kind 自己接
    //（playground 的 buildUpstream、/relay 轉發都是）。各家官方文件給的網址多半已含 /v1
    // （例 Venice 寫 https://api.venice.ai/api/v1），照貼會變成兩個 v1 → 上游回 404 且畫面查不出原因，
    // 所以標籤直接寫明。2026-07-20 實際踩過。
    var fBase=field(tx("上游 Base URL（不用加 /v1、/v1beta）","Base URL (no /v1 or /v1beta)"),"cBase",c.base_url,"https://api.openai.com");
    // 模型名稱（必填）：一行一個；會員頁與 Playground 都靠這份清單
    var mf=el("div","field");mf.appendChild(el("label",null,tx("模型名稱（一行一個，必填）","Models (one per line, required)")));
    var fModels=el("textarea");fModels.rows=3;fModels.placeholder="gpt-4o-mini\\ngpt-4o";
    fModels.value=(c.models||[]).join("\\n");
    mf.appendChild(fModels);dlg.appendChild(mf);
    // 視覺模型（選填，v2.3）：上面那份清單裡「看得懂圖片」的那幾個。
    // 為什麼要人工填而不是自動判斷：各家都沒有查詢模型能力的端點，名字也看不出來
    // （同一個系列常常有 vision 版與純文字版）。猜錯的代價不對稱 —— 以為能送圖但其實
    // 不能，會員送出後只會拿到一句上游打回來的錯誤；反過來只是附件鈕灰著。
    // 所以預設一律「不支援」，管理員明確填了才開放。
    var vf=el("div","field");
    vf.appendChild(el("label",null,tx("其中看得懂圖片的模型（一行一個，留空＝這個渠道不支援附圖）","Vision-capable models (one per line, blank = no image support)")));
    var fVis=el("textarea");fVis.rows=2;fVis.placeholder="gpt-4o";
    fVis.value=(c.vision_models||[]).join("\\n");
    vf.appendChild(fVis);dlg.appendChild(vf);
    // Playground 系統提示詞（選填）：只作用在 /playground；/relay API 中轉是透明代理，
    // 不會注入這段（會員送什麼就轉什麼）。標籤寫明，免得以為中轉那邊也會套用。
    var sf=el("div","field");
    sf.appendChild(el("label",null,tx("Playground 系統提示詞（留空＝套用灰字的站台預設，可在 /settings 改；不影響 API 中轉）","Playground system prompt (blank = the grey site default, editable in /settings; not applied to API relay)")));
    var fSys=el("textarea");fSys.rows=4;
    // 灰字＝這個渠道留空時伺服器實際會送出的那段。站台預設由伺服器每次請求現查後
    // 塞進 window.__pgDefSys（/settings 可改）；真的沒拿到才退回程式內建值。
    fSys.placeholder=window.__pgDefSys||${JSON.stringify(PG_DEFAULT_SYSTEM)};
    fSys.value=c.system_prompt||"";
    sf.appendChild(fSys);dlg.appendChild(sf);
    // 額外請求參數（選填）：合併進 playground 送給上游的請求本體，處理各家專屬參數。
    // 灰字放 Venice 那個實例 — 它會在我們的系統提示詞後面偷接自己的（含身分覆寫），要這個才關得掉。
    // 伺服器存檔時會驗 JSON 合法性；model/stream/messages/contents 擋著不給覆寫。
    //
    // ⚠ 標籤一定要寫明「留空＝不套用，灰字只是範例」：這格的灰字跟上面那格語意「相反」—
    // 系統提示詞的灰字是留空時真的會送出的預設值，這格的灰字只是範例、留空什麼都不加。
    // 兩格相鄰又都是灰字，不寫死的話會被當成同一種行為，然後以為 Venice 那段設定自動生效
    // 而其實沒有（管道會有身分洩漏卻看不出來）。2026-07-20 使用者實際問過這個問題。
    var ef=el("div","field");
    ef.appendChild(el("label",null,tx("額外請求參數 JSON（留空＝不套用，灰字只是範例；不影響 API 中轉）","Extra request params JSON (blank = none applied, grey text is only an example; not applied to API relay)")));
    var fExtra=el("textarea");fExtra.rows=3;
    fExtra.placeholder='{"venice_parameters":{"include_venice_system_prompt":false}}';
    fExtra.value=c.extra_body||"";
    ef.appendChild(fExtra);dlg.appendChild(ef);
    var fKey=field(tx("上游 API Key","Upstream key"),"cKey","",c.has_key?tx("（留空＝不變；目前 "+c.key_hint+"）","(blank = keep)"):tx("上游平台給你的金鑰","upstream key"));
    fKey.type="password";

    // 選類型時自動帶入官方 Base URL；用其他供應商（便宜渠道／自架）直接改掉就好。
    // 只在「欄位是空的」或「裡面還是某個官方預設值」時才覆蓋 — 管理員手打過的網址絕不動。
    var OFFICIAL={openai:"https://api.openai.com",anthropic:"https://api.anthropic.com",
                  gemini:"https://generativelanguage.googleapis.com",custom:""};
    function isOfficial(v){
      for(var k in OFFICIAL){if(OFFICIAL[k]&&OFFICIAL[k]===v)return true;}
      return false;
    }
    var hint=el("div","muted");hint.style.marginBottom="10px";
    function upKind(){
      var d=OFFICIAL[sel.value]||"";
      if(d&&(fBase.value===""||isOfficial(fBase.value)))fBase.value=d;
      fBase.placeholder=d||"https://api.某供應商.com";
      hint.textContent=d
        ?tx("已帶入官方預設網址 — 用其他供應商（便宜渠道、自架、本地模型）就直接改掉。","Official default filled in — replace it for other providers.")
        :tx("填該渠道的網址（OpenAI 相容介面即可，本地模型可用 http://…）。","Any OpenAI-compatible base URL (local models can use http://…).");
    }
    sel.addEventListener("change",upKind);upKind();
    dlg.appendChild(hint);
    var btns=el("div");btns.style.cssText="display:flex;gap:8px;justify-content:flex-end;margin-top:6px";
    var cancel=el("button","btn",tx("取消","Cancel"));
    var save=el("button","btn pri",tx("儲存","Save"));
    btns.appendChild(cancel);btns.appendChild(save);dlg.appendChild(btns);
    ov.appendChild(dlg);document.body.appendChild(ov);
    fName.focus();
    function close(){ov.remove();}
    cancel.addEventListener("click",close);
    ov.addEventListener("click",function(e){if(e.target===ov)close();});
    save.addEventListener("click",function(){
      var payload={name:fName.value.trim(),kind:sel.value,base_url:fBase.value.trim(),models:fModels.value,system_prompt:fSys.value,extra_body:fExtra.value,vision_models:fVis.value,enabled:isNew?1:!!c.enabled};
      if(fKey.value!=="")payload.api_key=fKey.value;      // 空＝不帶＝保留舊值（編輯）；新增時空＝空金鑰
      else if(isNew)payload.api_key="";
      save.disabled=true;save.textContent=tx("儲存中…","Saving…");
      var p=isNew?api("/api/admin/relay/channels",{json:payload})
                 :api("/api/admin/relay/channels/"+c.id,{method:"PUT",json:payload});
      p.then(function(){close();reloadAdmin(box);MU.flash(tx("已儲存","Saved"));}).catch(function(e){
        save.disabled=false;save.textContent=tx("儲存","Save");MU.flash(esc(e.message||e));
      });
    });
  }

  start();
})();
`;
