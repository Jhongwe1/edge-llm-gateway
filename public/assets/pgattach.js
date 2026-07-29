/* pgattach.js — Playground 附件處理（v2.3.0）。只有 /playground 載入。
   職責：把使用者丟進來的檔案變成「可以送給模型的東西」，UI 由 playgroundpage.ts 的 PG_JS 負責。

   兩條完全不同的路：

   1. 圖片 → 壓縮 → base64 → 上傳成一筆 pg_files，訊息只帶編號。
      壓縮在**瀏覽器**做（使用者的 CPU 免費），Worker 那邊 10ms 的預算一點都不能花在這上面。

   2. 文件（txt/md/csv/json/程式碼／docx/xlsx/pptx）→ **在瀏覽器抽成純文字**，直接接在
      訊息內容後面送出。完全不進儲存層、不佔容量、也不需要模型支援 vision ——
      連純文字模型都能「讀」Word 檔。這是整個附件功能裡 CP 值最高的一段。

   Office 檔案為什麼不引 JSZip：docx/xlsx/pptx 本質都是 ZIP + XML，而瀏覽器原生就有
   DecompressionStream('deflate-raw') 和 DOMParser。自己解只要百來行，省掉 100KB 的
   相依套件、也省掉一個要跟著更新的第三方版本。代價是格式會被扁平化（表格變 Tab 分隔、
   標題層級消失）—— 對「餵給模型讀」這個用途來說，文字在就夠了。 */
(function () {
  "use strict";
  if (window.PGA) return;

  // 長邊上限。1568 是各家 vision 的甜蜜點（Anthropic 明講超過會自己縮，OpenAI 的 tile
  // 切法在這個尺寸附近效率最好）—— 傳更大只是多花 token 與頻寬，模型看到的細節不會變多。
  var MAX_EDGE = 1568;
  var IMG_MIME = { "image/jpeg": 1, "image/png": 1, "image/webp": 1, "image/gif": 1 };
  // 抽出來的文字上限（單檔）。超過就截斷並在結尾標明 —— 悄悄砍掉會讓模型讀到半截資料
  // 卻以為自己讀完了，那比明講更糟。
  var MAX_TEXT = 40000;

  // 副檔名 → 當成純文字讀。清單刻意保守：認得出來的才收，其餘一律當不支援，
  // 免得有人丟一個 .bin 進來然後看到一堆亂碼被送去問模型。
  var TEXT_EXT =
    "txt,md,markdown,csv,tsv,json,jsonl,xml,yaml,yml,ini,conf,cfg,log,sql,html,htm,css,js,mjs,cjs,ts,tsx,jsx," +
    "py,rb,go,rs,java,kt,swift,c,h,cpp,hpp,cs,php,sh,bash,zsh,ps1,bat,toml,env,gitignore,dockerfile,makefile";
  var TEXT_SET = {};
  TEXT_EXT.split(",").forEach(function (e) {
    TEXT_SET[e] = 1;
  });
  var OFFICE = { docx: 1, xlsx: 1, pptx: 1 };

  function ext(name) {
    var s = String(name || "");
    var i = s.lastIndexOf(".");
    return i < 0 ? "" : s.slice(i + 1).toLowerCase();
  }
  function fmtBytes(n) {
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(0) + " KB";
    return (n / 1048576).toFixed(1) + " MB";
  }

  /* ================= ZIP（Office 檔案用）================= */
  // 只實作讀取所需的最小集合：EOCD → Central Directory → Local Header → 解壓。
  // 不支援 ZIP64（Office 文件要 4GB 以上才會用到）與加密（本來就讀不了）。
  function u16(d, p) {
    return d.getUint16(p, true);
  }
  function u32(d, p) {
    return d.getUint32(p, true);
  }

  async function inflateRaw(bytes) {
    var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // 回 { 檔名: Uint8Array }，只解出 wanted(name) 回 true 的項目（Office 檔案裡
  // 圖片、字型、佈景那些佔了絕大部分體積，全解等於白燒 CPU 與記憶體）。
  async function unzip(buf, wanted) {
    var bytes = new Uint8Array(buf);
    var d = new DataView(buf);
    // EOCD 在檔尾，簽章 0x06054b50；註解最長 65535，所以往前找這個範圍就夠
    var eocd = -1;
    var from = Math.max(0, bytes.length - 65557);
    for (var i = bytes.length - 22; i >= from; i--) {
      if (u32(d, i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error("不是有效的 ZIP／Office 檔案");
    var count = u16(d, eocd + 10);
    var cdOff = u32(d, eocd + 16);
    var out = {};
    var p = cdOff;
    var dec = new TextDecoder();
    for (var n = 0; n < count; n++) {
      if (u32(d, p) !== 0x02014b50) break;
      var method = u16(d, p + 10);
      var csize = u32(d, p + 20);
      var nameLen = u16(d, p + 28);
      var extraLen = u16(d, p + 30);
      var cmtLen = u16(d, p + 32);
      var lho = u32(d, p + 42);
      var name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extraLen + cmtLen;
      if (!wanted(name)) continue;
      // Local header 的檔名／extra 長度跟 central directory 的可能不同，要各讀各的
      if (u32(d, lho) !== 0x04034b50) continue;
      var lNameLen = u16(d, lho + 26);
      var lExtraLen = u16(d, lho + 28);
      var start = lho + 30 + lNameLen + lExtraLen;
      var raw = bytes.subarray(start, start + csize);
      out[name] = method === 0 ? raw : await inflateRaw(raw);
    }
    return out;
  }

  function xmlDoc(bytes) {
    return new DOMParser().parseFromString(new TextDecoder().decode(bytes), "application/xml");
  }
  // 命名空間無關的取標籤（docx 是 w:t、pptx 是 a:t、xlsx 是 t，前綴不保證固定）
  function tags(node, local) {
    return node.getElementsByTagNameNS("*", local);
  }

  /* ---- docx：word/document.xml 的 <w:p> 段落 → 一行 ---- */
  function docxText(files) {
    var f = files["word/document.xml"];
    if (!f) return "";
    var doc = xmlDoc(f);
    var ps = tags(doc, "p");
    var lines = [];
    for (var i = 0; i < ps.length; i++) {
      var ts = tags(ps[i], "t");
      var s = "";
      for (var j = 0; j < ts.length; j++) s += ts[j].textContent || "";
      lines.push(s);
    }
    // 連續空行壓成一個 —— Word 文件常有大量空段落，原樣保留只是浪費模型的上下文
    return lines.join("\n").replace(/\n{3,}/g, "\n\n");
  }

  /* ---- xlsx：sharedStrings + 每張工作表，一列一行、儲存格用 Tab 分隔 ---- */
  function xlsxText(files) {
    var shared = [];
    if (files["xl/sharedStrings.xml"]) {
      var sdoc = xmlDoc(files["xl/sharedStrings.xml"]);
      var sis = tags(sdoc, "si");
      for (var i = 0; i < sis.length; i++) {
        var ts = tags(sis[i], "t");
        var s = "";
        for (var j = 0; j < ts.length; j++) s += ts[j].textContent || "";
        shared.push(s);
      }
    }
    var names = Object.keys(files)
      .filter(function (k) {
        return /^xl\/worksheets\/sheet\d+\.xml$/.test(k);
      })
      .sort(function (a, b) {
        return (parseInt(a.replace(/\D+/g, ""), 10) || 0) - (parseInt(b.replace(/\D+/g, ""), 10) || 0);
      });
    var out = [];
    names.forEach(function (key) {
      var doc = xmlDoc(files[key]);
      var rows = tags(doc, "row");
      var lines = [];
      for (var r = 0; r < rows.length; r++) {
        var cs = tags(rows[r], "c");
        var cells = [];
        for (var c = 0; c < cs.length; c++) {
          var cell = cs[c];
          var type = cell.getAttribute("t") || "";
          var v = tags(cell, "v")[0];
          var val = "";
          if (type === "s") {
            // 共用字串表的索引
            var idx = parseInt((v && v.textContent) || "", 10);
            val = shared[idx] != null ? shared[idx] : "";
          } else if (type === "inlineStr") {
            var its = tags(cell, "t");
            for (var k = 0; k < its.length; k++) val += its[k].textContent || "";
          } else {
            val = (v && v.textContent) || "";
          }
          cells.push(val);
        }
        // 整列都空就跳過（試算表常有大片空白列）
        if (
          cells.some(function (x) {
            return x !== "";
          })
        )
          lines.push(cells.join("\t"));
      }
      if (lines.length) {
        out.push((names.length > 1 ? "# " + key.replace(/^xl\/worksheets\//, "") + "\n" : "") + lines.join("\n"));
      }
    });
    return out.join("\n\n");
  }

  /* ---- pptx：每張投影片的 <a:t>，投影片之間標編號 ---- */
  function pptxText(files) {
    var names = Object.keys(files)
      .filter(function (k) {
        return /^ppt\/slides\/slide\d+\.xml$/.test(k);
      })
      .sort(function (a, b) {
        return (parseInt(a.replace(/\D+/g, ""), 10) || 0) - (parseInt(b.replace(/\D+/g, ""), 10) || 0);
      });
    var out = [];
    names.forEach(function (key, i) {
      var doc = xmlDoc(files[key]);
      var ts = tags(doc, "t");
      var lines = [];
      for (var j = 0; j < ts.length; j++) {
        var s = (ts[j].textContent || "").trim();
        if (s) lines.push(s);
      }
      if (lines.length) out.push("--- 投影片 " + (i + 1) + " ---\n" + lines.join("\n"));
    });
    return out.join("\n\n");
  }

  async function officeText(file) {
    var kind = ext(file.name);
    var buf = await file.arrayBuffer();
    var want =
      kind === "docx"
        ? function (n) {
            return n === "word/document.xml";
          }
        : kind === "xlsx"
          ? function (n) {
              return n === "xl/sharedStrings.xml" || /^xl\/worksheets\/sheet\d+\.xml$/.test(n);
            }
          : function (n) {
              return /^ppt\/slides\/slide\d+\.xml$/.test(n);
            };
    var files = await unzip(buf, want);
    var text = kind === "docx" ? docxText(files) : kind === "xlsx" ? xlsxText(files) : pptxText(files);
    if (!text.trim()) {
      throw new Error(
        kind === "pptx"
          ? "這份簡報裡沒有可抽取的文字（可能整份都是圖片）"
          : "這份文件裡沒有可抽取的文字"
      );
    }
    return text;
  }

  /* ================= 純文字檔 ================= */
  async function plainText(file) {
    var buf = await file.arrayBuffer();
    // 先照 UTF-8 解，出現替代字元（U+FFFD）就改用 Big5 再試一次 ——
    // 台灣的舊 .txt／.csv 很多是 Big5，直接當 UTF-8 讀會整篇變亂碼。
    var s = new TextDecoder("utf-8").decode(buf);
    if (s.indexOf("�") >= 0) {
      try {
        var alt = new TextDecoder("big5").decode(buf);
        if (alt.indexOf("�") < 0) s = alt;
      } catch (e) {
        /* 瀏覽器不支援 big5 就維持 UTF-8 的結果 */
      }
    }
    return s;
  }

  /* ================= 圖片：壓縮 → base64 ================= */
  function blobB64(blob) {
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () {
        var s = String(fr.result || "");
        var i = s.indexOf(",");
        res(i < 0 ? "" : s.slice(i + 1));
      };
      fr.onerror = function () {
        rej(new Error("讀取檔案失敗"));
      };
      fr.readAsDataURL(blob);
    });
  }

  function canvasBlob(cv, type, q) {
    return new Promise(function (res) {
      cv.toBlob(
        function (b) {
          res(b);
        },
        type,
        q
      );
    });
  }

  // 回 { b64, mime, w, h, name, bytes, url }（url＝本地預覽用的 data URL，不必回讀伺服器）
  async function toImage(file, maxBytes) {
    if (!IMG_MIME[file.type]) throw new Error("只支援 JPEG / PNG / WebP / GIF 圖片");
    var bmp;
    try {
      bmp = await createImageBitmap(file);
    } catch (e) {
      // iPhone 的 HEIC 走到這裡最常見 —— 瀏覽器解不開，講清楚比丟一句「失敗」有用
      throw new Error("這個圖片格式瀏覽器打不開（iPhone 的 HEIC 請先在相簿轉成 JPEG）");
    }
    var w = bmp.width;
    var h = bmp.height;
    var scale = Math.min(1, MAX_EDGE / Math.max(w, h));

    // 動畫 GIF 一進 canvas 就只剩第一幀。夠小就原樣送，保住動畫；
    // 太大才不得不轉成靜態（並在 UI 標明）—— 反正模型本來也只看得到單幀。
    if (file.type === "image/gif" && file.size <= maxBytes) {
      bmp.close && bmp.close();
      var raw = await blobB64(file);
      return { b64: raw, mime: "image/gif", w: w, h: h, name: file.name, bytes: file.size };
    }

    var cw = Math.max(1, Math.round(w * scale));
    var chh = Math.max(1, Math.round(h * scale));
    var cv = document.createElement("canvas");
    cv.width = cw;
    cv.height = chh;
    cv.getContext("2d").drawImage(bmp, 0, 0, cw, chh);
    bmp.close && bmp.close();

    // WebP 品質／體積最好，三家 vision 都吃。Safari 較舊版不支援編碼 → 回頭用 JPEG。
    var out = await canvasBlob(cv, "image/webp", 0.85);
    var mime = "image/webp";
    if (!out || out.type !== "image/webp") {
      out = await canvasBlob(cv, "image/jpeg", 0.85);
      mime = "image/jpeg";
    }
    // 還是太大就降品質再壓一輪（很少發生：1568px 的 webp 幾乎都在 400KB 以內）
    var q = 0.7;
    while (out && out.size > maxBytes && q >= 0.4) {
      out = await canvasBlob(cv, mime, q);
      q -= 0.15;
    }
    if (!out) throw new Error("圖片壓縮失敗");
    if (out.size > maxBytes) {
      throw new Error("這張圖太大了（壓縮後仍有 " + fmtBytes(out.size) + "）");
    }
    return { b64: await blobB64(out), mime: mime, w: cw, h: chh, name: file.name, bytes: out.size };
  }

  /* ================= 上傳 ================= */
  // 本體就是 raw base64（不包 JSON）—— 伺服器 request.text() 直接拿到字串原封存下，
  // 全程不編不解。中繼資料走 query string。
  async function upload(img) {
    var qs =
      "?mime=" +
      encodeURIComponent(img.mime) +
      "&name=" +
      encodeURIComponent(img.name || "") +
      "&w=" +
      (img.w || "") +
      "&h=" +
      (img.h || "");
    var r = await fetch("/api/playground/files" + qs, {
      method: "POST",
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: img.b64,
      cache: "no-store"
    });
    var d = {};
    try {
      d = await r.json();
    } catch (e) {}
    if (!r.ok) throw new Error(d.hint || d.error || "HTTP " + r.status);
    return d;
  }

  window.PGA = {
    MAX_EDGE: MAX_EDGE,
    IMG_MIME: IMG_MIME,
    ext: ext,
    fmtBytes: fmtBytes,
    isImage: function (file) {
      return !!IMG_MIME[file.type];
    },
    isDoc: function (file) {
      var e = ext(file.name);
      return !!(TEXT_SET[e] || OFFICE[e]);
    },
    isOffice: function (file) {
      return !!OFFICE[ext(file.name)];
    },
    // 給 <input accept> 用
    acceptImage: "image/jpeg,image/png,image/webp,image/gif",
    acceptDoc:
      ".docx,.xlsx,.pptx," +
      TEXT_EXT.split(",")
        .map(function (e) {
          return "." + e;
        })
        .join(","),
    toImage: toImage,
    upload: upload,
    // 文件 → 純文字（含截斷標記）
    toText: async function (file) {
      var text = OFFICE[ext(file.name)] ? await officeText(file) : await plainText(file);
      var cut = false;
      if (text.length > MAX_TEXT) {
        text = text.slice(0, MAX_TEXT);
        cut = true;
      }
      return { name: file.name, text: text, truncated: cut, bytes: file.size };
    }
  };
})();
