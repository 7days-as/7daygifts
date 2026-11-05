// ========= CONFIG =========
const WISHLIST_KEY = "7DG_WISHLIST_LOCAL";
const EMAIL_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbzVRgumxRdyeCgWhTqvo_tpM_x_hTMrCJQbrltrMr1hJ-LpnE5DLIXduDrrDlIVp2OT/exec";
const CLICK_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbyDvT1LzVG8eccyXwU7-7HkuQuq0oKyff0o9UYyq_bnJsLfJwyKCqSJUNnK5uGuTCdz/exec";
// Product pages are pre-built from the Google Sheet by build.mjs; this file adds the
// wish list, click tracking, email sign-up and gallery filters on top of that HTML.
const PRODUCTS_URL = "/products.json";
// A preview copy of the site never posts clicks or emails to the real sheets.
const IS_PREVIEW = !!document.querySelector('meta[name="7dg-preview"]');

// ========= HELPERS =========
const $ = (id) => document.getElementById(id);

function safeParse(value, fallback) {
  try { return JSON.parse(value) ?? fallback; } catch { return fallback; }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function logProductClick(productId) {
  if (!productId || !CLICK_SCRIPT_URL || IS_PREVIEW) return;
  fetch(CLICK_SCRIPT_URL, {
    method: "POST",
    keepalive: true,
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ action: "logClick", product_id: productId })
  }).catch((error) => console.error("Error logging click:", error));
}

// ========= MENU (slide-in drawer: tap outside, ✕, Esc, swipe right or a link closes it) =========
function initMenu() {
  const btn = $("menuToggle");
  const menu = $("mobileMenu");
  if (!btn || !menu) return;
  let overlay = $("menuOverlay");
  if (!overlay) { overlay = document.createElement("div"); overlay.id = "menuOverlay"; overlay.className = "menu-overlay"; overlay.hidden = true; menu.before(overlay); }
  const closeBtn = $("menuClose");
  let hideTimer;
  function open() {
    clearTimeout(hideTimer);
    overlay.hidden = false;
    requestAnimationFrame(() => { overlay.classList.add("show"); menu.classList.add("open"); });
    menu.setAttribute("aria-hidden", "false");
    btn.setAttribute("aria-expanded", "true");
    document.documentElement.classList.add("menu-locked");
  }
  function close() {
    menu.classList.remove("open");
    overlay.classList.remove("show");
    menu.setAttribute("aria-hidden", "true");
    btn.setAttribute("aria-expanded", "false");
    document.documentElement.classList.remove("menu-locked");
    hideTimer = setTimeout(() => { overlay.hidden = true; }, 300);
  }
  btn.addEventListener("click", () => (menu.classList.contains("open") ? close() : open()));
  overlay.addEventListener("click", close);
  closeBtn?.addEventListener("click", close);
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && menu.classList.contains("open")) close(); });
  menu.querySelectorAll("a").forEach((link) => link.addEventListener("click", close));
  // swipe right to close
  let x0 = null;
  menu.addEventListener("touchstart", (e) => { x0 = e.touches[0].clientX; }, { passive: true });
  menu.addEventListener("touchend", (e) => { if (x0 !== null && e.changedTouches[0].clientX - x0 > 60) close(); x0 = null; }, { passive: true });
}

// ========= WISHLIST =========
function getWishlist() { return safeParse(localStorage.getItem(WISHLIST_KEY), []); }
function setWishlist(list) { localStorage.setItem(WISHLIST_KEY, JSON.stringify(list)); }
function isSaved(productId) { return getWishlist().some((item) => item.id === productId); }

function toggleWishlist(product) {
  const list = getWishlist();
  const index = list.findIndex((item) => item.id === product.id);
  if (index >= 0) list.splice(index, 1); else list.push(product);
  setWishlist(list);
}

function productFromCard(id) {
  // enough to show it on the wish list even if products.json is unavailable
  const card = document.querySelector(`.product-card[data-id="${CSS.escape(id)}"], .product-detail[data-id="${CSS.escape(id)}"]`);
  if (!card) return { id };
  const link = card.querySelector(".product-link")?.getAttribute("href") || location.pathname;
  return {
    id,
    title: card.querySelector(".product-title, .product-detail-title")?.textContent.trim() || "",
    image: card.querySelector(".product-image")?.getAttribute("src") || "",
    url: card.querySelector(".amazon-link")?.getAttribute("href") || "#",
    slug: (link.match(/\/gifts\/([^/]+)\.html/) || [])[1] || "",
    category: card.dataset.category || "",
    gender: card.dataset.gender || "all"
  };
}

function syncHearts() {
  document.querySelectorAll(".heart[data-id]").forEach((btn) => {
    const saved = isSaved(btn.dataset.id);
    btn.classList.toggle("active", saved);
    btn.setAttribute("aria-pressed", saved ? "true" : "false");
    const label = btn.getAttribute("aria-label") || "";
    btn.setAttribute("aria-label", saved ? label.replace(/^Save /, "Remove ").replace(/ to your wish list$/, " from your wish list") : label.replace(/^Remove /, "Save ").replace(/ from your wish list$/, " to your wish list"));
  });
}

// ========= CLICKS (one handler for the whole page) =========
function initClicks() {
  document.addEventListener("click", (event) => {
    const heart = event.target.closest(".heart[data-id]");
    if (heart) {
      event.preventDefault();
      event.stopPropagation();
      const id = heart.dataset.id;
      const product = (window.__products || []).find((p) => p.id === id) || productFromCard(id);
      toggleWishlist(product);
      syncHearts();
      if ($("wishlist-products")) renderWishlistPage(window.__products || []);
      return;
    }
    const amazon = event.target.closest(".amazon-link[data-id]");
    if (amazon) logProductClick(amazon.dataset.id);
  });
}

// ========= PRODUCT DATA =========
async function loadProducts() {
  try {
    const response = await fetch(PRODUCTS_URL, { cache: "no-cache" });
    if (!response.ok) throw new Error("products.json " + response.status);
    return await response.json();
  } catch (error) {
    console.error("Error loading products:", error);
    return [];
  }
}

// ========= CARDS (wish list page and gift finder) =========
const HEART_SVG = '<svg class="heart-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>';
function renderCard(p, { saved = true } = {}) {
  const title = escapeHtml(p.title || "Saved gift");
  const href = p.slug ? `/gifts/${encodeURIComponent(p.slug)}.html` : escapeHtml(p.url || "#");
  const src = p.thumb || p.image;
  const img = src
    ? `<img class="product-image" src="${escapeHtml(src)}" alt="${title}" loading="lazy" decoding="async" width="400" height="400" onerror="this.style.display='none';this.parentElement.classList.add('image-missing');" />`
    : "";
  return `<article class="product-card" data-id="${escapeHtml(p.id)}">
    <button type="button" class="heart${saved ? " active" : ""}" data-id="${escapeHtml(p.id)}" aria-label="${saved ? "Remove" : "Save"} ${title} ${saved ? "from" : "to"} your wish list">${HEART_SVG}</button>
    <a class="product-link" href="${href}">
      <div class="product-image-wrap ${src ? "" : "image-missing"}">${img}<div class="image-fallback">Image coming soon</div></div>
      <div class="product-text">
        <h3 class="product-title">${title}</h3>
        ${p.hook ? `<p class="product-hook">${escapeHtml(p.hook)}</p>` : ""}
      </div>
    </a>
    <div class="product-card-body">
      ${p.band ? `<span class="band">${escapeHtml(p.band)}</span>` : ""}
      <a class="btn-pill btn-amazon amazon-link" href="${escapeHtml(p.url || "#")}" target="_blank" rel="sponsored nofollow noopener" data-id="${escapeHtml(p.id)}">Check price on Amazon</a>
    </div>
  </article>`;
}

function renderWishlistPage(products) {
  const grid = $("wishlist-products");
  if (!grid) return;
  const emptyEl = $("wishlistEmpty");
  const saved = getWishlist();
  if (!saved.length) {
    grid.innerHTML = "";
    emptyEl?.classList.remove("hidden");
    return;
  }
  emptyEl?.classList.add("hidden");
  const items = saved.map((s) => products.find((p) => p.id === s.id) || s);
  grid.innerHTML = items.map(renderCard).join("");
}

// ========= GALLERY (filters the pre-built cards) =========
function initGallery() {
  const grid = $("gallery-products");
  if (!grid) return;
  const cards = [...grid.querySelectorAll(".product-card")];
  const genderWrap = $("genderPills");
  const budgetWrap = $("budgetPills");
  const sortRow = document.querySelector(".sort-row");
  const categoryFilter = $("categoryFilter");
  const empty = $("galleryEmpty");
  const count = $("galleryCount");

  const params = new URLSearchParams(location.search);
  const pick = (wrap, attr, value) => {
    if (value && wrap?.querySelector(`[data-${attr}="${CSS.escape(value)}"]`)) {
      wrap.querySelectorAll(`[data-${attr}]`).forEach((b) => b.classList.toggle("active", b.dataset[attr] === value));
    }
  };
  pick(genderWrap, "gender", params.get("for"));
  // ?budget= takes a band key (25-50) or the band text ($25–$50)
  let startBudget = params.get("budget");
  if (startBudget && budgetWrap) {
    const norm = (s) => s.toLowerCase().replace(/\s/g, "").replace(/[-—]/g, "–");
    const byText = [...budgetWrap.querySelectorAll("[data-budget]")].find((b) => norm(b.textContent) === norm(startBudget));
    if (byText) startBudget = byText.dataset.budget;
  }
  pick(budgetWrap, "budget", startBudget);
  const startCat = params.get("category");
  if (startCat && categoryFilter && [...categoryFilter.options].some((o) => o.value === startCat)) categoryFilter.value = startCat;

  function apply() {
    const gender = genderWrap?.querySelector("[data-gender].active")?.dataset.gender || "all";
    const budget = budgetWrap?.querySelector("[data-budget].active")?.dataset.budget || "all";
    const sort = sortRow?.querySelector(".sort-btn.active")?.dataset.sort || "popular";
    const category = categoryFilter?.value || "all";
    const sorted = [...cards].sort((a, b) =>
      sort === "recent"
        ? Number(b.dataset.order) - Number(a.dataset.order)
        : Number(b.dataset.pop) - Number(a.dataset.pop) || Number(a.dataset.order) - Number(b.dataset.order));
    let shown = 0;
    sorted.forEach((card) => {
      const okGender = gender === "all" || card.dataset.gender === gender || card.dataset.gender === "all";
      const okBudget = budget === "all" || card.dataset.band === budget;
      // anniversary cards and wrapping paper show only when their category is picked
      const okCat = category === "all" ? card.dataset.side !== "1" : card.dataset.category === category;
      card.hidden = !(okGender && okBudget && okCat);
      if (!card.hidden) shown++;
      grid.appendChild(card);
    });
    empty?.classList.toggle("hidden", shown > 0);
    if (count) count.textContent = `Showing ${shown} ${shown === 1 ? "gift" : "gifts"}`;
  }

  const pillGroup = (wrap, attr) => wrap?.addEventListener("click", (event) => {
    const btn = event.target.closest(`[data-${attr}]`);
    if (!btn) return;
    wrap.querySelectorAll(`[data-${attr}]`).forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    apply();
  });
  pillGroup(genderWrap, "gender");
  pillGroup(budgetWrap, "budget");
  sortRow?.addEventListener("click", (event) => {
    const btn = event.target.closest(".sort-btn");
    if (!btn) return;
    sortRow.querySelectorAll(".sort-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    apply();
  });
  categoryFilter?.addEventListener("change", apply);
  apply();
}

// ========= GIFT FINDER (3 taps, all in the browser) =========
function initFinder(products) {
  const root = $("finderResults");
  if (!root) return;
  const section = root.closest(".finder");
  const status = $("finderStatus");
  const actions = $("finderActions");
  const more = $("finderMore");
  const reset = $("finderReset");
  const state = { who: "", occasion: "", budget: "" };
  const order = ["u25", "25-50", "50-100", "100-200", "200p"];
  let limit = 12;
  const chanukahOn = !!(window.__chanukah && window.__chanukah.on);

  const isCard = (p) => /card/i.test(p.category || "");
  const isWrap = (p) => /wrap/i.test(p.category || "");
  function occasionOk(p, occ) {
    if (!occ) return true;
    if (isCard(p) && /anniversary/i.test(p.category || "")) return occ === "anniversary"; // anniversary cards: only for anniversaries
    const list = p.occasions || [];
    if (!list.length) return true; // untagged gifts work for any occasion
    return list.includes(occ);
  }
  function whoOk(p, who) {
    if (!who) return true;
    if (who === "both") return p.gender === "all";
    return p.gender === who || p.gender === "all";
  }
  function match(useBudget = true) {
    return products.filter((p) => !isWrap(p) && whoOk(p, state.who) && occasionOk(p, state.occasion) &&
      (!useBudget || !state.budget || state.budget === "any" || p.bandKey === state.budget));
  }
  function sortList(list) {
    return list.sort((a, b) => {
      // for "anniversary", put the gifts first and the cards after
      const ca = isCard(a) ? 1 : 0, cb = isCard(b) ? 1 : 0;
      if (state.occasion !== "anniversary" && ca !== cb) return ca - cb;
      const wa = state.who && state.who !== "both" && a.gender === state.who ? 0 : 1;
      const wb = state.who && state.who !== "both" && b.gender === state.who ? 0 : 1;
      return wa - wb || (b.popularity || 0) - (a.popularity || 0) || (a.order || 0) - (b.order || 0);
    });
  }
  function render() {
    section.querySelectorAll(".pill[data-who],.pill[data-occasion],.pill[data-budget]").forEach((b) => {
      const key = b.dataset.who ? "who" : b.dataset.occasion ? "occasion" : "budget";
      const on = state[key] === (b.dataset[key]);
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
    const picked = Object.values(state).filter(Boolean).length;
    if (!picked) { root.innerHTML = ""; status.textContent = "Tap one in each row — results show up right here."; actions.classList.add("hidden"); return; }
    let list = sortList(match());
    let note = "";
    if (!list.length && state.budget && state.budget !== "any") {
      // nothing in that exact budget: show the closest budgets instead
      const i = order.indexOf(state.budget);
      const near = sortList(match(false)).sort((a, b) => Math.abs(order.indexOf(a.bandKey) - i) - Math.abs(order.indexOf(b.bandKey) - i));
      list = near.filter((p) => p.bandKey);
      note = list.length ? " Nothing in that exact budget yet, so here are the closest picks." : "";
    }
    const shown = list.slice(0, limit);
    root.innerHTML = shown.map((p) => renderCard(p, { saved: false })).join("");
    syncHearts();
    const need = 3 - picked;
    status.textContent = list.length
      ? `${list.length} ${list.length === 1 ? "gift matches" : "gifts match"}.${note}${need > 0 ? ` Tap ${need} more to narrow it down.` : ""}`
      : "No matches yet. Try another budget or occasion.";
    if (state.occasion === "anniversary") root.insertAdjacentHTML("beforeend", `<a class="finder-card-note" href="/category/anniversary-cards.html"><strong>Don’t forget the card</strong><span>Sweet, funny and always clean anniversary cards →</span></a>`);
    actions.classList.toggle("hidden", !picked);
    more.classList.toggle("hidden", list.length <= limit);
  }
  section.addEventListener("click", (event) => {
    const b = event.target.closest(".pill[data-who],.pill[data-occasion],.pill[data-budget]");
    if (!b) return;
    const key = b.dataset.who ? "who" : b.dataset.occasion ? "occasion" : "budget";
    state[key] = state[key] === b.dataset[key] ? "" : b.dataset[key];
    limit = 12;
    render();
  });
  more?.addEventListener("click", () => { limit += 12; render(); });
  reset?.addEventListener("click", () => { state.who = state.occasion = state.budget = ""; limit = 12; render(); });
  if (!chanukahOn && state.occasion === "chanukah") state.occasion = "";
  render();
}

// ========= COLLECTION ROWS (arrow buttons on desktop; swipe on phones) =========
function initScrollers() {
  document.querySelectorAll("[data-scroller]").forEach((wrap) => {
    const rowEl = wrap.querySelector(".product-row");
    const prev = wrap.querySelector(".prev");
    const next = wrap.querySelector(".next");
    if (!rowEl) return;
    const step = () => Math.max(240, rowEl.clientWidth * 0.85);
    const update = () => {
      prev.disabled = rowEl.scrollLeft < 8;
      next.disabled = rowEl.scrollLeft + rowEl.clientWidth >= rowEl.scrollWidth - 8;
    };
    prev?.addEventListener("click", () => rowEl.scrollBy({ left: -step(), behavior: "smooth" }));
    next?.addEventListener("click", () => rowEl.scrollBy({ left: step(), behavior: "smooth" }));
    rowEl.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    update();
  });
}

// ========= CHANUKAH COUNTDOWN =========
function initCountdown() {
  const c = window.__chanukah;
  if (!c || !c.on || !c.start) return;
  const days = Math.round((Date.parse(c.start + "T12:00:00Z") - Date.parse(c.today + "T12:00:00Z")) / 86400000);
  const text = days > 1 ? `${days} days to go` : days === 1 ? "Starts tomorrow night" : days === 0 ? "Starts tonight" : `Night ${Math.min(8, 1 - days)} of 8`;
  document.querySelectorAll("[data-chanukah-countdown]").forEach((el) => { el.textContent = text; });
}

// ========= EMAIL CAPTURE =========
function initEmailForm() {
  const form = $("emailForm");
  const success = $("emailSuccess");
  const error = $("emailError");
  if (!form) return;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = $("emailInput")?.value?.trim();
    const weddingDate = $("weddingDate")?.value?.trim() || "";
    const company = $("companyField")?.value?.trim() || "";
    if (!email) return;
    success?.classList.add("hidden");
    error?.classList.add("hidden");
    if (IS_PREVIEW) { $("emailPreview")?.classList.remove("hidden"); return; }
    try {
      const response = await fetch(EMAIL_SCRIPT_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ email, wedding_date: weddingDate, source: "7daygifts_site", company })
      });
      if (!response.ok) throw new Error("Request failed");
      form.reset();
      success?.classList.remove("hidden");
    } catch (err) {
      console.error(err);
      error?.classList.remove("hidden");
    }
  });
}

// ========= INIT =========
document.addEventListener("DOMContentLoaded", async () => {
  initMenu();
  initEmailForm();
  initClicks();
  initGallery();
  initScrollers();
  initCountdown();
  syncHearts();
  renderWishlistPage([]);
  const products = await loadProducts();
  window.__products = products;
  renderWishlistPage(products);
  initFinder(products);
  syncHearts();
});
