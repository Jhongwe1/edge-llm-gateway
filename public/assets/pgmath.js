/* pgmath.js — 聊天訊息裡的數學式渲染（v2.3.3）。只有 /playground 載入。
   起因：問數學題時模型回的是 LaTeX（$$\lim_{x \to 5} \frac{1}{x-5}$$），
   不渲染就是一堆看不懂的原文。

   為什麼獨立成一支檔案而不是塞進 playgroundpage.ts 的 PG_JS：
   那裡整段是樣板字串，寫在裡面的反斜線會先被樣板字串吃掉一層 —— 而這支檔案幾乎
   全是反斜線（\\$、\\[、\\frac…）。放這裡就是普通 JS，寫什麼是什麼。

   ## 流程
   1. `protect()` 用一次掃描把數學區塊抽走換成佔位符（同時認得 code 區塊並跳過 ——
      程式碼裡的 $ 不是數學）。**這一步一定要在 markdown 之前**：
      \lim_{x} … \int_{5} 裡的兩個底線會被 marked 當成斜體語法，中間整段被包進 <em>，
      公式就毀了。
   2. markdown 渲染。
   3. `restore()` 把佔位符換成 <span class="pgm" data-tex="…">，內容先放原文。
   4. `render()` 對那些 span 逐一呼叫 katex.render()。

   ## 為什麼不用 KaTeX 的 auto-render
   第一版用了，結果「這件 $5 那件 $10」被它當成一段公式吃掉，畫面上變成「這件 5那件10」。
   auto-render 是對整個 DOM 重新掃描分隔符，它的 $…$ 判斷比這裡寬鬆，而我已經在
   步驟 1 精準抽出過一次了 —— 讓它再掃一次，等於把「什麼算公式」的決定權交給兩套規則。
   改成自己標記、自己渲染之後，範圍完全由下面那條 SCAN 決定，可測也可控。
   （順帶省掉 auto-render.min.js 那支相依。） */
(function () {
  "use strict";
  if (window.PGM) return;

  // 佔位符用控制字元 —— 正常文字打不出來，模型也不會吐。
  var PH_A = "M";
  var PH_B = "";

  // 一次掃完：group1＝code（原樣保留，不當數學）、group2＝數學區塊。
  // 順序重要：$$ 必須排在單個 $ 之前，否則 $$x$$ 會先被 $ 規則咬掉開頭。
  // 單個 $ 的規則刻意嚴格：左界後面不可是空白／$，右界前面不可是空白，右界後面不可是數字 ——
  // 不然「這件 $5 那件 $10」會被當成一段公式。
  var SCAN = new RegExp(
    "(```[\\s\\S]*?```|`[^`\\n]+`)" +
      "|(\\$\\$[\\s\\S]+?\\$\\$" +
      "|\\\\\\[[\\s\\S]+?\\\\\\]" +
      "|\\\\\\([\\s\\S]+?\\\\\\)" +
      "|\\$(?![\\s$])(?:[^\\n$]*[^\\s$])?\\$(?!\\d))",
    "g"
  );

  function has(text) {
    var s = String(text || "");
    if (s.indexOf("$") >= 0) return true;
    return s.indexOf("\\[") >= 0 || s.indexOf("\\(") >= 0;
  }

  // 分隔符 → { tex, display }。tex 是去掉分隔符之後真正要餵給 KaTeX 的內容。
  function split(m) {
    var two = m.slice(0, 2);
    if (two === "$$") return { tex: m.slice(2, -2), display: true };
    if (two === "\\[") return { tex: m.slice(2, -2), display: true };
    if (two === "\\(") return { tex: m.slice(2, -2), display: false };
    return { tex: m.slice(1, -1), display: false };
  }

  // 把數學區塊抽走換成佔位符；store 收 { tex, display, raw }，順序＝佔位符編號。
  function protect(text, store) {
    return String(text == null ? "" : text).replace(SCAN, function (m, code, math) {
      if (code) return code; // 程式碼原樣放行
      var d = split(math);
      store.push({ tex: d.tex, display: d.display, raw: math });
      return PH_A + (store.length - 1) + PH_B;
    });
  }

  function esc(s) {
    return String(s).replace(/[&<>]/g, function (c) {
      return c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;";
    });
  }
  function escAttr(s) {
    return esc(s).replace(/"/g, "&quot;");
  }

  /* markdown 渲染完的 HTML 裡，把佔位符換成待渲染的 span。
     內容先放**原文**：KaTeX 還沒載入完（或載入失敗）時，畫面上看到的是
     原始 LaTeX 而不是一片空白 —— 看得懂總比什麼都沒有好。 */
  function restore(html, store) {
    var s = String(html == null ? "" : html);
    for (var i = 0; i < store.length; i++) {
      var m = store[i];
      var span =
        '<span class="pgm" data-d="' +
        (m.display ? "1" : "0") +
        '" data-tex="' +
        escAttr(m.tex) +
        '">' +
        esc(m.raw) +
        "</span>";
      s = s.split(PH_A + i + PH_B).join(span);
    }
    return s;
  }

  var loadP = null;
  function load() {
    if (loadP) return loadP;
    var cfg = window.__KATEX || {
      js: "/assets/katex/katex.min.js",
      css: "/assets/katex/katex.min.css"
    };
    loadP = new Promise(function (res, rej) {
      var link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = cfg.css;
      document.head.appendChild(link);
      var s = document.createElement("script");
      s.src = cfg.js;
      s.onload = function () {
        res(window.katex || null);
      };
      s.onerror = function () {
        rej(new Error("KaTeX 載入失敗"));
      };
      document.head.appendChild(s);
    });
    return loadP;
  }

  /* 對一個 DOM 節點裡的 .pgm 逐一渲染。
     載入失敗或個別公式寫壞都不丟出去 —— 那一格維持原文，其他照常。
     整則回覆不該因為一條公式而消失。 */
  function render(node) {
    if (!node) return Promise.resolve(false);
    var els = node.querySelectorAll ? node.querySelectorAll(".pgm:not([data-done])") : [];
    if (!els.length) return Promise.resolve(false);
    return load()
      .then(function (katex) {
        if (!katex || !katex.render) return false;
        for (var i = 0; i < els.length; i++) {
          var el = els[i];
          try {
            katex.render(el.getAttribute("data-tex") || "", el, {
              displayMode: el.getAttribute("data-d") === "1",
              throwOnError: false, // 公式寫壞就顯示紅色原文，不要讓整段渲染中斷
              errorColor: "#e02e2a",
              trust: false, // 禁掉 \href、\url 這類會產生連結的命令（內容來自模型，不完全可信）
              strict: false // 遇到可疑寫法只警告不中斷（模型常吐非標準但看得懂的語法）
            });
            el.setAttribute("data-done", "1");
          } catch (e) {
            /* 保持原文 */
          }
        }
        return true;
      })
      .catch(function () {
        return false;
      });
  }

  window.PGM = { has: has, protect: protect, restore: restore, render: render };
})();
