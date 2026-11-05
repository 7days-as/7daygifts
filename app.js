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

// ========= MENU =========
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
    if (btn.classList.contains("heart-btn")) btn.textContent = saved ? "♥ Saved" : "♥ Save";
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

// ========= WISHLIST PAGE =========
function renderCard(p) {
  const title = escapeHtml(p.title || "Saved gift");
  const href = p.slug ? `/gifts/${encodeURIComponent(p.slug)}.html` : escapeHtml(p.url || "#");
  const img = p.image
    ? `<img class="product-image" src="${escapeHtml(p.image)}" alt="${title}" loading="lazy" onerror="this.style.display='none';this.parentElement.classList.add('image-missing');" />`
    : "";
  return `<article class="product-card" data-id="${escapeHtml(p.id)}">
    <button type="button" class="heart active" data-id="${escapeHtml(p.id)}" aria-label="Remove ${title} from your wish list">♥</button>
    <a class="product-link" href="${href}">
      <div class="product-image-wrap ${p.image ? "" : "image-missing"}">${img}<div class="image-fallback">Image coming soon</div></div>
      <h3 class="product-title">${title}</h3>
    </a>
    <div class="product-card-body">
      <a class="btn-pill btn-amazon amazon-link" href="${escapeHtml(p.url || "#")}" target="_blank" rel="sponsored nofollow noopener" data-id="${escapeHtml(p.id)}">${p.band ? escapeHtml(p.band) + " · " : ""}Check price on Amazon</a>
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
  const sortRow = document.querySelector(".sort-row");
  const categoryFilter = $("categoryFilter");
  const budgetFilter = $("budgetFilter");
  const empty = $("galleryEmpty");

  const params = new URLSearchParams(location.search);
  const startGender = params.get("for");
  if (startGender && genderWrap?.querySelector(`[data-gender="${CSS.escape(startGender)}"]`)) {
    genderWrap.querySelectorAll("[data-gender]").forEach((b) => b.classList.toggle("active", b.dataset.gender === startGender));
  }
  const startCat = params.get("category");
  const startBudget = params.get("budget");
  if (startBudget && budgetFilter && [...budgetFilter.options].some((o) => o.value === startBudget)) budgetFilter.value = startBudget;
  if (startCat && categoryFilter && [...categoryFilter.options].some((o) => o.value === startCat)) categoryFilter.value = startCat;

  function apply() {
    const gender = genderWrap?.querySelector("[data-gender].active")?.dataset.gender || "all";
    const sort = sortRow?.querySelector(".sort-btn.active")?.dataset.sort || "popular";
    const category = categoryFilter?.value || "all";
    const budget = budgetFilter?.value || "all";
    const sorted = [...cards].sort((a, b) =>
      sort === "recent"
        ? Number(b.dataset.order) - Number(a.dataset.order)
        : Number(b.dataset.pop) - Number(a.dataset.pop) || Number(a.dataset.order) - Number(b.dataset.order));
    let shown = 0;
    sorted.forEach((card) => {
      const okGender = gender === "all" || card.dataset.gender === gender || card.dataset.gender === "all";
      const okCat = category === "all" || card.dataset.category === category;
      const okBudget = budget === "all" || card.dataset.band === budget;
      card.hidden = !(okGender && okCat && okBudget);
      if (!card.hidden) shown++;
      grid.appendChild(card);
    });
    empty?.classList.toggle("hidden", shown > 0);
  }

  genderWrap?.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-gender]");
    if (!btn) return;
    genderWrap.querySelectorAll("[data-gender]").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    apply();
  });
  sortRow?.addEventListener("click", (event) => {
    const btn = event.target.closest(".sort-btn");
    if (!btn) return;
    sortRow.querySelectorAll(".sort-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    apply();
  });
  categoryFilter?.addEventListener("change", apply);
  budgetFilter?.addEventListener("change", apply);
  apply();
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
  syncHearts();
  renderWishlistPage([]);
  const products = await loadProducts();
  window.__products = products;
  renderWishlistPage(products);
  syncHearts();
});
