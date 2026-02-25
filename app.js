// ========= CONFIG =========
const AUTH_EMAIL_KEY = "userEmail";
const WISHLIST_KEY = "7DG_WISHLIST";
const API_BASE = ""; // future API (blank = use mock)


// ========= HELPERS =========
const $ = (id) => document.getElementById(id);

function safeParse(v, fallback){
  try { return JSON.parse(v) ?? fallback; }
  catch { return fallback; }
}

// ========= AUTH =========
function getUserEmail(){ return localStorage.getItem(AUTH_EMAIL_KEY) || ""; }
function isSignedIn(){ return !!getUserEmail(); }

function updateAuthUI(){
  const authButton = $("authButton");
  const mobileAuthButton = $("mobileAuthButton");

  if (isSignedIn()){
    if (authButton) authButton.textContent = getUserEmail(); // desktop shows email
    if (mobileAuthButton) mobileAuthButton.textContent = "Sign Out";
  } else {
    if (authButton) authButton.textContent = "Sign In";
    if (mobileAuthButton) mobileAuthButton.textContent = "Sign In";
  }
}

function openModal(){
  // supports BOTH modal styles you have used
  const b1 = $("authBackdrop");
  const b2 = $("authModalBackdrop");
  const m  = $("authModal");

  b1?.classList.remove("hidden");
  if (b2) b2.hidden = false;

  m?.classList.remove("hidden");
  if (m) m.hidden = false;
}

function closeModal(){
  const b1 = $("authBackdrop");
  const b2 = $("authModalBackdrop");
  const m  = $("authModal");

  b1?.classList.add("hidden");
  if (b2) b2.hidden = true;

  m?.classList.add("hidden");
  if (m) m.hidden = true;
}

function handleAuthClick(){
  if (isSignedIn()){
    localStorage.removeItem(AUTH_EMAIL_KEY);
    updateAuthUI();
    // optional redirect:
    // window.location.href = "index.html";
  } else {
    openModal();
  }
}

// ========= WISHLIST =========
function getWishlist(){ return safeParse(localStorage.getItem(WISHLIST_KEY), []); }
function setWishlist(list){ localStorage.setItem(WISHLIST_KEY, JSON.stringify(list)); }
function isSaved(id){ return getWishlist().some(x => x.id === id); }

function toggleWishlist(item){
  const list = getWishlist();
  const idx = list.findIndex(x => x.id === item.id);
  if (idx >= 0) list.splice(idx, 1);
  else list.push(item);
  setWishlist(list);
}

// ========= MENU =========
function initMenu(){
  // supports your newer mobile menu (menuToggle/mobileMenu)
  const btn = $("menuToggle");
  const menu = $("mobileMenu");
  if (btn && menu){
    btn.addEventListener("click", () => menu.classList.toggle("open"));
  }

  // supports your older nav toggle (navToggle/nav) if that page exists
  const navBtn = $("navToggle");
  const nav = $("nav");
  if (navBtn && nav){
    navBtn.addEventListener("click", () => {
      const isOpen = nav.classList.toggle("open");
      navBtn.setAttribute("aria-expanded", isOpen ? "true" : "false");
    });
  }
}

// ========= PRODUCTS =========
const SHEET_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vRIP3mbNKwA1vi20Aufe7uKOBp-9HYV1kIot6FNnbZyPG7IT9xazlOqA9jii5b9lLuJBO6ydMNiyzSi/pub?gid=0&single=true&output=csv";

async function loadProducts(){
  try {
    const response = await fetch(SHEET_URL);
    const csvText = await response.text();

    const rows = csvText.split("\n").map(r => r.split(","));
    const headers = rows[0];
    const dataRows = rows.slice(1);

    const products = dataRows.map(row => {
      const obj = {};
      headers.forEach((header, i) => {
        obj[header.trim()] = row[i];
      });

      return {
        id: obj.product_id || obj.amazon_asin,
        title: obj.site_title,
        price: Number(obj.price) || 0,
        image: obj.photo_url,
        url: `https://www.amazon.com/dp/${obj.amazon_asin}?tag=7daygifts-20`,
        category: obj.categories,
        gender: obj.who_is_it_for || "all",
        popularity: Number(obj.click_count) || 0,
        addedAt: Date.now(),
        status: obj.status
      };
    });

    return products.filter(p =>
      p.status && p.status.trim().toLowerCase() === "active"
    );

  } catch (err) {
    console.error("Error loading sheet:", err);
    return [];
  }
}
// ========= UI: Product Cards =========
function renderProductCard(p){
  return `
    <article class="product-card">
      <button class="heart ${isSaved(p.id) ? "active" : ""}" data-id="${p.id}" aria-label="Save">♥</button>
      <img src="${p.image}" alt="${p.title}">
      <h3>${p.title}</h3>
      <div class="product-price">${p.price ? `$${p.price}` : ""}</div>
      <a class="btn-pill btn-primary" href="${p.url}" target="_blank" rel="noopener">View</a>
    </article>
  `;
}

function wireHeartButtons(container, products){
  container.querySelectorAll(".heart").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      const item = products.find(p => p.id === id);
      if (!item) return;
      toggleWishlist(item);
      btn.classList.toggle("active", isSaved(id));
    });
  });
}

// ========= HOME TRENDING =========
function renderHomeTrending(products){
  const holder = $("home-trending");
  if (!holder) return;

  const top = [...products].sort((a,b) => (b.popularity||0) - (a.popularity||0)).slice(0,7);
  holder.innerHTML = top.map(renderProductCard).join("");
  wireHeartButtons(holder, products);
}

// ========= WISHLIST PAGE =========
function renderWishlistPage(){
  const grid = $("wishlist-products");
  const signedOut = $("wishlistSignedOut");
  const signedIn = $("wishlistSignedIn");
  const emailEl = $("signedInEmail");

  if (!grid || !signedOut || !signedIn) return;

  if (!isSignedIn()){
    signedOut.classList.remove("hidden");
    signedIn.classList.add("hidden");
    return;
  }

  signedOut.classList.add("hidden");
  signedIn.classList.remove("hidden");
  if (emailEl) emailEl.textContent = getUserEmail();

  const items = getWishlist();
  if (!items.length){
    grid.innerHTML = `<p>No saved gifts yet.</p>`;
    return;
  }

  grid.innerHTML = items.map(renderProductCard).join("");
  wireHeartButtons(grid, items);
}

// ========= GALLERY FILTERS / SORT =========
function buildCategoryFilters(products){
  const holder =
    $("categoryChips") ||
    $("categoryChecks");

  if (!holder) return;

  const categories = [...new Set(products.map(p => p.category).filter(Boolean))].sort();

  holder.innerHTML = categories.map(cat => `
    <label class="filter-chip">
      <input type="checkbox" value="${cat}">
      <span>${cat}</span>
    </label>
  `).join("");

  holder.querySelectorAll("input").forEach(cb => {
    cb.addEventListener("change", () => renderGalleryPage(window.__products));
  });
}

function getGalleryFilters(){
  const maxPrice = Number($("priceRange")?.value || 9999);

  const catRoot =
    document.getElementById("categoryChips") ||
    document.getElementById("categoryChecks");

  const categories = catRoot
    ? [...catRoot.querySelectorAll('input[type="checkbox"]:checked')].map(cb => cb.value)
    : [];

  const sort =
    document.querySelector(".sort-btn.active")?.dataset.sort ||
    document.getElementById("sortSelect")?.value ||
    "popular";

  const gender =
    document.querySelector('#genderPills [data-gender].active')?.dataset.gender ||
    document.querySelector('input[name="gender"]:checked')?.value ||
    "all";

  return { maxPrice, categories, sort, gender };
}

function renderGalleryPage(products){
  const grid =
    $("gallery-products") || // your current gallery id
    $("galleryGrid");        // older gallery id

  if (!grid) return;

  const { maxPrice, categories, sort, gender } = getGalleryFilters();

  let list = [...products];

  // gender
  if (gender !== "all"){
    list = list.filter(p => p.gender === gender || p.gender === "all");
  }

  // price
  list = list.filter(p => (p.price || 0) <= maxPrice);

  // categories
  if (categories.length){
    list = list.filter(p => categories.includes(p.category));
  }

  // sort
  if (sort === "popular")   list.sort((a,b) => (b.popularity||0) - (a.popularity||0));
  if (sort === "price-asc") list.sort((a,b) => (a.price||0) - (b.price||0));
  if (sort === "price-desc")list.sort((a,b) => (b.price||0) - (a.price||0));
  if (sort === "recent")    list.sort((a,b) => (b.addedAt||0) - (a.addedAt||0));

  grid.innerHTML = list.map(renderProductCard).join("");
  wireHeartButtons(grid, products);
}

function initGalleryUI(products){
  // slider label
  const range = $("priceRange");
  const value = $("priceValue");
  if (range && value){
    value.textContent = `$${range.value}`;
    range.addEventListener("input", () => {
      value.textContent = `$${range.value}`;
      renderGalleryPage(window.__products);
    });
  }

  // sort pills
  document.querySelector(".sort-row")?.addEventListener("click", (e) => {
    const btn = e.target.closest(".sort-btn");
    if (!btn) return;
    document.querySelectorAll(".sort-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    renderGalleryPage(window.__products);
  });

  // sort dropdown (older UI)
  document.getElementById("sortSelect")?.addEventListener("change", () => {
    renderGalleryPage(window.__products);
  });

  // gender pills
  const genderWrap = document.getElementById("genderPills");
  genderWrap?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-gender]");
    if (!btn) return;
    genderWrap.querySelectorAll("[data-gender]").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    renderGalleryPage(window.__products);
  });

  // gender radios (older UI)
  document.querySelectorAll('input[name="gender"]').forEach(r => {
    r.addEventListener("change", () => renderGalleryPage(window.__products));
  });

  buildCategoryFilters(products);
}

// ========= INIT =========
document.addEventListener("DOMContentLoaded", async () => {
  initMenu();
  updateAuthUI();

  $("authButton")?.addEventListener("click", handleAuthClick);
  $("mobileAuthButton")?.addEventListener("click", handleAuthClick);

  $("authModalClose")?.addEventListener("click", closeModal);
  $("authBackdrop")?.addEventListener("click", closeModal);
  $("authModalBackdrop")?.addEventListener("click", closeModal);

  $("authForm")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const email = $("authEmail")?.value?.trim();
    if (!email) return;
    localStorage.setItem(AUTH_EMAIL_KEY, email);
    closeModal();
    updateAuthUI();
  });

  const products = await loadProducts();
  window.__products = products;

  // Home
  renderHomeTrending(products);

  // Wishlist (only runs if wishlist DOM exists)
  renderWishlistPage();

  // Gallery (only runs if gallery DOM exists)
  if ($("gallery-products") || $("galleryGrid")){
    initGalleryUI(products);
    renderGalleryPage(products);
  }
});
