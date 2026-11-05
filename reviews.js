/* 7 Day Gifts — ratings, "what's it for" votes and private comments.
   Talks to a Google Apps Script web app in Avrohom's Google account (Sheet "7daygifts Reviews & Votes").
   Everything loads after the page; if the script is down the site works exactly as before. */
(function () {
  "use strict";
  var ENDPOINT = ""; // optional: the web app's /exec address. Left empty, it is read from the published address Sheet below.
  var ADDRESS_CSV = "https://docs.google.com/spreadsheets/d/e/2PACX-1vT8bmnj0KRfb4knCetg9sozD_eUqYmuklbTIniwnR6ru62ntI9PTSBf4vO-MsIm9BDbyJcmHPeazvrY/pub?output=csv";
  var EP_RE = /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/;
  var OCC = [["wedding7", "7 days before the wedding"], ["birthday", "Birthday"], ["anniversary", "Anniversary"], ["justbecause", "Just because"], ["any", "Any occasion"]];
  var OCC_SAY = { birthday: "a birthday gift", anniversary: "an anniversary gift", wedding7: "for the 7 days before the wedding", justbecause: "a just-because gift", any: "great for any occasion" };
  var OCC_SHORT = { birthday: "Birthday", anniversary: "Anniversary", wedding7: "Wedding week", justbecause: "Just because", any: "Any occasion" };
  var MIN_VOTES = 3;
  var LS = window.localStorage;

  function get(k, d) { try { var v = LS.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } }
  function put(k, v) { try { LS.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function voter() {
    var v = get("rv_voter", "");
    if (!v) { var a = new Uint8Array(12); (window.crypto || {}).getRandomValues ? crypto.getRandomValues(a) : a.forEach(function (_, i) { a[i] = Math.random() * 256; }); v = Array.prototype.map.call(a, function (b) { return ("0" + b.toString(16)).slice(-2); }).join(""); put("rv_voter", v); }
    return v;
  }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  var epPromise = null;
  function endpoint() {
    if (ENDPOINT) return Promise.resolve(ENDPOINT);
    if (epPromise) return epPromise;
    var c = get("rv_ep", null);
    if (c && Date.now() - c.at < (c.u ? 21600000 : 600000)) return (epPromise = Promise.resolve(c.u));
    epPromise = fetch(ADDRESS_CSV).then(function (r) { return r.text(); }).then(function (t) {
      var m = t.match(/https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec/); var u = m && EP_RE.test(m[0]) ? m[0] : "";
      put("rv_ep", { u: u, at: Date.now() }); return u;
    }).catch(function () { return c ? c.u : ""; });
    return epPromise;
  }
  function api(params, body) {
    return endpoint().then(function (ep) { if (!ep) throw new Error("off"); return call(ep, params, body); });
  }
  function call(ENDPOINT, params, body) {
    var ctl = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 15000);
    var opts = body ? { method: "POST", body: JSON.stringify(body), signal: ctl && ctl.signal } : { signal: ctl && ctl.signal };
    var url = ENDPOINT + (params ? "?" + params : "");
    return fetch(url, opts).then(function (r) { clearTimeout(timer); return r.json(); });
  }
  function starsText(avg) { var s = ""; for (var i = 1; i <= 5; i++) s += avg >= i - 0.25 ? "★" : "☆"; return s; }

  /* ---------- styles (kept here so this stays one self-contained file) ---------- */
  var css = "" +
    ".rv{margin:22px 0 4px;padding:18px 16px 16px;border:1px solid var(--border-soft,#ECE5D5);border-radius:var(--radius-sm,14px);background:#fff;box-shadow:var(--shadow-soft)}" +
    ".rv-top{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;margin-bottom:6px}" +
    ".rv-sum{display:flex;align-items:center;gap:8px;font-size:15px;color:var(--text)}" +
    ".rv-sum .rv-st{color:var(--gold,#B48A4A);font-size:19px;letter-spacing:1px;line-height:1}" +
    ".rv-sum b{color:var(--primary);font-size:16px}.rv-sum span.rv-n{color:var(--muted)}" +
    ".rv-chip{display:inline-flex;align-items:center;gap:6px;padding:5px 12px;border-radius:999px;background:linear-gradient(180deg,#FBF3E1,#F3E6C6);border:1px solid var(--gold-soft,#E9D9B8);color:var(--gold-text,#8A6630);font-size:13.5px;font-weight:600}" +
    ".rv-chip.rv-ask{background:#F7F3EA;color:var(--muted);font-weight:500}" +
    ".rv-sec{border-top:1px solid var(--border-soft,#ECE5D5);margin-top:14px;padding-top:14px}" +
    ".rv-h{font-family:var(--serif);font-size:18px;color:var(--primary);font-weight:600;margin:0 0 2px}" +
    ".rv-sub{font-size:13.5px;color:var(--muted);margin:0 0 10px}" +
    ".rv-rate{display:flex;gap:4px}" +
    ".rv-rate button{appearance:none;border:0;background:none;padding:2px 4px;font-size:34px;line-height:1;color:#D9CDB3;cursor:pointer;transition:transform .12s,color .12s;min-width:44px;min-height:44px}" +
    ".rv-rate button.on{color:var(--gold,#B48A4A)}.rv-rate button:active{transform:scale(.9)}" +
    ".rv-opts{display:flex;flex-wrap:wrap;gap:8px}" +
    ".rv-opt{appearance:none;font:inherit;font-size:14.5px;padding:9px 14px;border-radius:999px;border:1.5px solid var(--border,#D8D2C2);background:#fff;color:var(--primary);cursor:pointer;min-height:42px;transition:background .15s,border-color .15s,color .15s}" +
    ".rv-opt[aria-pressed=true]{background:var(--primary,#1F3358);border-color:var(--primary,#1F3358);color:#fff}" +
    ".rv-opt[aria-pressed=true]::before{content:'\\2713  '}" +
    ".rv-act{display:flex;align-items:center;gap:12px;margin-top:12px;flex-wrap:wrap}" +
    ".rv-btn{appearance:none;font:inherit;font-weight:600;font-size:15px;padding:11px 22px;border-radius:999px;border:0;background:var(--primary,#1F3358);color:#fff;cursor:pointer;min-height:44px}" +
    ".rv-btn[disabled]{opacity:.45;cursor:default}" +
    ".rv-msg{font-size:14px;color:var(--gold-text,#8A6630)}.rv-msg.err{color:#A04030}" +
    ".rv-bars{margin-top:12px;display:grid;gap:7px}" +
    ".rv-bar{display:grid;grid-template-columns:minmax(0,1fr) 44px;gap:10px;align-items:center;font-size:13.5px;color:var(--text)}" +
    ".rv-bar i{display:block;height:8px;border-radius:8px;background:#F1EADB;margin-top:3px;overflow:hidden}" +
    ".rv-bar i b{display:block;height:100%;background:linear-gradient(90deg,#C9A15F,#AE853F);border-radius:8px}" +
    ".rv-bar em{font-style:normal;text-align:right;color:var(--muted)}" +
    ".rv-quotes{display:grid;gap:10px}" +
    ".rv-q{margin:0;padding:10px 14px;background:#FBF8F1;border-left:3px solid var(--gold-soft,#E9D9B8);border-radius:0 10px 10px 0;font-size:15px}" +
    ".rv-q cite{display:block;font-style:normal;font-size:13px;color:var(--muted);margin-top:4px}" +
    ".rv-cm summary{cursor:pointer;font-weight:600;color:var(--primary);font-size:15.5px;list-style:none;display:flex;align-items:center;gap:8px;min-height:40px}" +
    ".rv-cm summary::-webkit-details-marker{display:none}.rv-cm summary::after{content:'\\203A';font-size:22px;color:var(--gold);transition:transform .2s}.rv-cm[open] summary::after{transform:rotate(90deg)}" +
    ".rv-cm label{display:block;font-size:13.5px;color:var(--muted);margin:10px 0 4px}" +
    ".rv-cm input[type=text],.rv-cm textarea{width:100%;font:inherit;font-size:16px;padding:10px 12px;border:1.5px solid var(--border,#D8D2C2);border-radius:12px;background:#fff;color:var(--text)}" +
    ".rv-cm textarea{min-height:96px;resize:vertical}" +
    ".rv-note{font-size:13px;color:var(--muted);margin:8px 0 0}" +
    ".rv-preview{font-size:12.5px;color:var(--muted);margin:10px 0 0;font-style:italic}" +
    ".rv-mini{display:inline-flex;align-items:center;gap:3px;font-size:12.5px;font-weight:600;color:var(--gold-text,#8A6630)}" +
    ".rv-mini .rv-st{color:var(--gold,#B48A4A)}" +
    ".rv-mini-occ{display:inline-block;padding:3px 9px;border-radius:999px;background:#EEF1F6;color:var(--primary);font-size:12px;font-weight:600}";
  var style = el("style"); style.textContent = css; document.head.appendChild(style);

  /* ---------- product page ---------- */
  function mountProduct(detail) {
    var id = detail.getAttribute("data-id");
    var titleEl = detail.querySelector("h1");
    var title = titleEl ? titleEl.textContent.trim() : id;
    var box = el("section", "rv"); box.setAttribute("aria-label", "Ratings and what this gift is for");

    var top = el("div", "rv-top");
    var sum = el("div", "rv-sum"); var chip = el("span", "rv-chip rv-ask", "What's this gift for? Vote below");
    top.appendChild(sum); top.appendChild(chip); box.appendChild(top);

    // rate
    var secR = el("div", "rv-sec");
    secR.appendChild(el("p", "rv-h", "Rate it"));
    var subR = el("p", "rv-sub", "Tap a star. No sign-in needed.");
    secR.appendChild(subR);
    var rate = el("div", "rv-rate"); rate.setAttribute("role", "group"); rate.setAttribute("aria-label", "Your rating");
    var stars = [];
    for (var i = 1; i <= 5; i++) (function (n) {
      var b = el("button", "", "★"); b.type = "button"; b.setAttribute("aria-label", n + " star" + (n > 1 ? "s" : ""));
      b.addEventListener("click", function () { sendRating(n); });
      stars.push(b); rate.appendChild(b);
    })(i);
    var msgR = el("span", "rv-msg");
    secR.appendChild(rate); secR.appendChild(msgR); box.appendChild(secR);

    // vote
    var secV = el("div", "rv-sec");
    secV.appendChild(el("p", "rv-h", "What's this gift for?"));
    secV.appendChild(el("p", "rv-sub", "Pick as many as fit. We'll show what most people think."));
    var opts = el("div", "rv-opts"); var picked = get("rv_v_" + id, null); var sel = {};
    (picked || []).forEach(function (k) { sel[k] = 1; });
    var optBtns = {};
    OCC.forEach(function (o) {
      var b = el("button", "rv-opt", o[1]); b.type = "button"; b.setAttribute("aria-pressed", sel[o[0]] ? "true" : "false");
      b.addEventListener("click", function () {
        if (o[0] === "any") sel = sel.any ? {} : { any: 1 };
        else { delete sel.any; if (sel[o[0]]) delete sel[o[0]]; else sel[o[0]] = 1; }
        paintOpts(); saveBtn.disabled = !Object.keys(sel).length; msgV.textContent = ""; msgV.className = "rv-msg";
      });
      optBtns[o[0]] = b; opts.appendChild(b);
    });
    function paintOpts() { OCC.forEach(function (o) { optBtns[o[0]].setAttribute("aria-pressed", sel[o[0]] ? "true" : "false"); }); }
    var act = el("div", "rv-act"); var saveBtn = el("button", "rv-btn", picked ? "Update my vote" : "Vote"); saveBtn.type = "button"; saveBtn.disabled = !picked;
    var msgV = el("span", "rv-msg"); act.appendChild(saveBtn); act.appendChild(msgV);
    var bars = el("div", "rv-bars");
    secV.appendChild(opts); secV.appendChild(act); secV.appendChild(bars); box.appendChild(secV);
    saveBtn.addEventListener("click", sendVote);

    // approved comments
    var secQ = el("div", "rv-sec hidden"); secQ.appendChild(el("p", "rv-h", "What people say")); var quotes = el("div", "rv-quotes"); secQ.appendChild(quotes); box.appendChild(secQ);

    // private comment
    var secC = el("div", "rv-sec");
    var det = el("details", "rv-cm"); var summ = el("summary", "", "Send us a private comment"); det.appendChild(summ);
    var form = el("form"); form.noValidate = true;
    var l1 = el("label", "", "Your name (optional)"); var nameIn = el("input"); nameIn.type = "text"; nameIn.maxLength = 60; nameIn.autocomplete = "given-name"; nameIn.id = "rv-name-" + id; l1.htmlFor = nameIn.id;
    var l2 = el("label", "", "Comment"); var txt = el("textarea"); txt.maxLength = 2000; txt.id = "rv-text-" + id; l2.htmlFor = txt.id; txt.placeholder = "Did you give it? How did it go? Anything we should know?";
    var hp = el("input", "hp-field"); hp.type = "text"; hp.name = "website"; hp.tabIndex = -1; hp.autocomplete = "off"; hp.setAttribute("aria-hidden", "true");
    var actC = el("div", "rv-act"); var sendBtn = el("button", "rv-btn", "Send privately"); sendBtn.type = "submit"; var msgC = el("span", "rv-msg"); actC.appendChild(sendBtn); actC.appendChild(msgC);
    [l1, nameIn, l2, txt, hp, actC].forEach(function (n) { form.appendChild(n); });
    form.appendChild(el("p", "rv-note", "Comments come privately to 7daygifts and are read before anything is shown on the site."));
    det.appendChild(form); secC.appendChild(det); box.appendChild(secC);
    endpoint().then(function (ep) { if (!ep) box.appendChild(el("p", "rv-preview", "Preview: saving turns on once it's connected to the 7daygifts Google Sheet.")); });
    form.addEventListener("submit", function (e) { e.preventDefault(); sendComment(); });

    var anchor = detail.querySelector(".product-actions");
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(box, anchor.nextSibling); else detail.appendChild(box);

    var mine = get("rv_r_" + id, 0);
    paintStars(mine);
    if (mine) subR.textContent = "You rated it " + mine + "★. Tap to change.";
    render(null);
    api("action=summary&id=" + encodeURIComponent(id)).then(function (d) { if (d && d.ok) render(d); }).catch(function () {});

    function paintStars(n) { stars.forEach(function (b, i) { b.classList.toggle("on", i < n); }); }
    function render(d) {
      sum.textContent = "";
      if (d && d.count) {
        var st = el("span", "rv-st", starsText(d.avg)); st.setAttribute("aria-hidden", "true");
        sum.appendChild(st); sum.appendChild(el("b", "", String(d.avg))); sum.appendChild(el("span", "rv-n", "· " + d.count + (d.count === 1 ? " rating" : " ratings")));
        sum.setAttribute("aria-label", "Rated " + d.avg + " out of 5 by " + d.count + (d.count === 1 ? " person" : " people"));
      } else { sum.appendChild(el("span", "rv-st", "☆☆☆☆☆")); sum.appendChild(el("span", "rv-n", "No ratings yet")); }
      if (d && d.voters >= MIN_VOTES && d.top) { chip.className = "rv-chip"; chip.textContent = d.top === "any" ? "Most people say: great for any occasion" : "Most people say: " + OCC_SAY[d.top]; }
      else { chip.className = "rv-chip rv-ask"; chip.textContent = "What's this gift for? Vote below"; }
      bars.textContent = "";
      if (d && d.voters && (get("rv_v_" + id, null) || d.voters >= MIN_VOTES)) {
        OCC.forEach(function (o) {
          var n = d.votes[o[0]] || 0; if (!n) return;
          var pct = Math.round(n / d.voters * 100);
          var r = el("div", "rv-bar"); var left = el("div"); left.appendChild(document.createTextNode(o[1])); var tr = el("i"); var fill = el("b"); fill.style.width = pct + "%"; tr.appendChild(fill); left.appendChild(tr);
          r.appendChild(left); r.appendChild(el("em", "", pct + "%")); bars.appendChild(r);
        });
        bars.appendChild(el("p", "rv-sub", d.voters + (d.voters === 1 ? " vote" : " votes") + " so far"));
      }
      if (d && d.comments && d.comments.length) {
        quotes.textContent = ""; secQ.classList.remove("hidden");
        d.comments.forEach(function (c) { var q = el("blockquote", "rv-q", c.text); q.appendChild(el("cite", "", "— " + (c.name || "A 7daygifts reader") + (c.date ? ", " + c.date : ""))); quotes.appendChild(q); });
      }
    }
    function fail(m, e) { m.className = "rv-msg err"; m.textContent = e && e.message === "off" ? "Thanks! (Preview — saving isn't switched on yet.)" : (e && e.text) || "Couldn't save right now. Please try again later."; if (e && e.message === "off") m.className = "rv-msg"; }
    function sendRating(n) {
      paintStars(n); msgR.className = "rv-msg"; msgR.textContent = "Saving…";
      api("", { action: "rate", product_id: id, stars: n, voter: voter() }).then(function (d) {
        if (!d || !d.ok) return fail(msgR, { text: d && d.error });
        put("rv_r_" + id, n); msgR.textContent = ""; subR.textContent = "Thanks! You rated it " + n + "★. Tap to change."; render(d);
      }).catch(function (e) { fail(msgR, e); paintStars(get("rv_r_" + id, 0)); });
    }
    function sendVote() {
      var list = Object.keys(sel); if (!list.length) return;
      saveBtn.disabled = true; msgV.className = "rv-msg"; msgV.textContent = "Saving…";
      api("", { action: "vote", product_id: id, occasions: list, voter: voter() }).then(function (d) {
        saveBtn.disabled = false;
        if (!d || !d.ok) return fail(msgV, { text: d && d.error });
        put("rv_v_" + id, list); saveBtn.textContent = "Update my vote"; msgV.textContent = "Thanks, your vote is in."; render(d);
      }).catch(function (e) { saveBtn.disabled = false; fail(msgV, e); });
    }
    function sendComment() {
      var text = txt.value.trim(); if (text.length < 2) { msgC.className = "rv-msg err"; msgC.textContent = "Please write a comment first."; txt.focus(); return; }
      sendBtn.disabled = true; msgC.className = "rv-msg"; msgC.textContent = "Sending…";
      api("", { action: "comment", product_id: id, title: title, url: location.href.split("#")[0], name: nameIn.value.trim(), text: text, voter: voter(), website: hp.value }).then(function (d) {
        sendBtn.disabled = false;
        if (!d || !d.ok) return fail(msgC, { text: d && d.error });
        txt.value = ""; msgC.textContent = "Thank you! Your comment was sent privately.";
      }).catch(function (e) { sendBtn.disabled = false; fail(msgC, e); });
    }
  }

  /* ---------- compact stars + occasion on cards ---------- */
  function decorateCards(data) {
    var cards = document.querySelectorAll(".product-card[data-id]");
    Array.prototype.forEach.call(cards, function (card) {
      var s = data[card.getAttribute("data-id")]; if (!s || card.querySelector(".rv-mini, .rv-mini-occ")) return;
      var body = card.querySelector(".product-card-body"); if (!body) return;
      var chips = body.querySelector(".chips"); if (!chips) { chips = el("span", "chips"); body.insertBefore(chips, body.firstChild); }
      if (s.n) { var m = el("span", "rv-mini"); var st = el("span", "rv-st", "★"); st.setAttribute("aria-hidden", "true"); m.appendChild(st); m.appendChild(document.createTextNode(s.a + " (" + s.n + ")")); m.setAttribute("aria-label", "Rated " + s.a + " by " + s.n); chips.appendChild(m); }
      if (s.v >= MIN_VOTES && s.t) chips.appendChild(el("span", "rv-mini-occ", OCC_SHORT[s.t]));
    });
  }
  function loadAll() {
    if (!document.querySelector(".product-card[data-id]")) return;
    var cached = null; try { cached = JSON.parse(sessionStorage.getItem("rv_all") || "null"); } catch (e) {}
    if (cached && Date.now() - cached.at < 300000) { decorateCards(cached.p); watch(cached.p); return; }
    api("action=all").then(function (d) {
      if (!d || !d.ok) return;
      try { sessionStorage.setItem("rv_all", JSON.stringify({ at: Date.now(), p: d.products })); } catch (e) {}
      decorateCards(d.products); watch(d.products);
    }).catch(function () {});
  }
  function watch(p) { // gallery/finder re-render cards; decorate new ones as they appear
    if (!window.MutationObserver) return;
    var t; new MutationObserver(function () { clearTimeout(t); t = setTimeout(function () { decorateCards(p); }, 120); }).observe(document.body, { childList: true, subtree: true });
  }

  function start() {
    var d = document.querySelector(".product-detail[data-id]");
    if (d) mountProduct(d);
    loadAll();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
