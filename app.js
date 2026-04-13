// ========= CONFIG =========
const AUTH_EMAIL_KEY = "userEmail";
const WISHLIST_KEY = "7DG_WISHLIST";
const SHEET_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vRIP3mbNKwA1vi20Aufe7uKOBp-9HYV1kIot6FNnbZyPG7IT9xazlOqA9jii5b9lLuJBO6ydMNiyzSi/pub?gid=0&single=true&output=csv";

// ========= HELPERS =========
const $ = (id) => document.getElementById(id);

function safeParse(value, fallback) {
  try {
    return JSON.parse(value) ?? fallback;
  } catch {
    return fallback;
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizeGender(value) {
  const v = String(value || "").trim().toLowerCase();

  if (["him", "for him", "male", "man", "men", "groom"].includes(v)) return "him";
  if (["her", "for her", "female", "woman", "women", "bride", "wife", "fiancee"].includes(v)) return "her";
  return "all";
}

function parseCSVLine(line) {
  const result = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];

    if (char === '"' && inQuotes && next === '"') {
      current += '"';
      i += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === "," && !inQuotes) {
      result.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  result.push(current);
  return result.map((item) => item.trim());
}

function formatPrice(price) {
  const n = Number(price);
  if (!Number.isFinite(n) || n <= 0) return "";
  return `$${n}`;
}

// ========= AUTH =========
function getUserEmail() {
  return localStorage.getItem(AUTH_EMAIL_KEY) || "";
}

function isSignedIn() {
  return !!getUserEmail();
}

function updateAuthUI() {
  const authButton = $("authButton");
  const mobileAuthButton = $("mobileAuthButton");
  const email = getUserEmail();

  if (email) {
    if (authButton) authButton.textContent = "Sign Out";
    if (mobileAuthButton) mobileAuthButton.textContent = "Sign Out";
  } else {
    if (authButton) authButton.textContent = "Sign In";
    if (mobileAuthButton) mobileAuthButton.textContent = "Sign In";
  }
}

function openModal() {
  $("authBackdrop")?.classList.remove("hidden");
  $("authModal")?.classList.remove("hidden");
}

function closeModal() {
  $("authBackdrop")?.classList.add("hidden");
  $("authModal")?.classList.add("hidden");
}

function closeMobileMenu() {
  $("mobileMenu")?.classList.remove("open");
}

function handleAuthClick() {
  if (isSignedIn()) {
    localStorage.removeItem(AUTH_EMAIL_KEY);
    updateAuthUI();
    renderWishlistPage(window.__products || []);
    renderHomeTrending(window.__products || []);
    renderGalleryPage(window.__products || []);
    closeMobileMenu();
    return;
  }

  openModal();
  closeMobileMenu();
}

// ========= WISHLIST =========
function getWishlistMap() {
  return safeParse(localStorage.getItem(WISHLIST_KEY), {});
}

function saveWishlistMap(map) {
  localStorage.setItem(WISHLIST_KEY, JSON.stringify(map));
}

function getWishlist() {
  const email = getUserEmail();
  if (!email) return [];

  const map = getWishlistMap();
  return Array.isArray(map[email]) ? map[email] : [];
}

function setWishlist(list) {
  const email = getUserEmail();
  if (!email) return;

  const map = getWishlistMap();
  map[email] = list;
  saveWishlistMap(map);
}

function isSaved(id) {
  return getWishlist().some((item) => item.id === id);
}

function toggleWishlist(item) {
  if (!isSignedIn()) {
    openModal();
    return false;
  }

  const list = getWishlist();
  const index = list.findIndex((x) => x.id === item.id);

  if (index >= 0) {
    list.splice(index, 1);
  } else {
    list.push(item);
  }

  setWishlist(list);
  return true;
}

// ========= MENU =========
function initMenu() {
  const btn = $("menuToggle");
  const menu = $("mobileMenu");

  if (!btn || !menu) return;

  btn.addEventListener("click", () => {
    menu.classList.toggle("open");
  });

  menu.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => {
      menu.classList.remove("open");
    });
  });
}

// ========= PRODUCTS =========
async function loadProducts() {
  try {
    const response = await fetch(SHEET_URL);
    const csvText = await response.text();

    const lines = csvText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (!lines.length) return [];

    const headers = parseCSVLine(lines[0]);
    const rows = lines.slice(1).map(parseCSVLine);

    const products = rows
      .map((row, index) => {
        const obj = {};
        headers.forEach((header, i) => {
          obj[String(header).trim()] = row[i] ?? "";
        });

        const asin = obj.amazon_asin?.trim();
        const id = obj.product_id?.trim() || asin || `product-${index + 1}`;

        return {
          id,
          asin,
          title: obj.site_title?.trim() || "Untitled product",
          price: Number(obj.price) || 0,
          image: obj.photo_url?.trim() || "",
          url: asin ? `https://www.amazon.com/dp/${asin}?tag=7daygifts-20` : "#",
          category: obj.categories?.trim() || "",
          gender: normalizeGender(obj.who_is_it_for),
          popularity: Number(obj.click_count) || 0,
          addedAt:
            obj.added_at?.trim() ||
            obj.created_at?.trim() ||
            obj.date_added?.trim() ||
            `2026-01-${String((index % 28) + 1).padStart(2, "0")}`,
          status: obj.status?.trim() || ""
        };
      })
      .filter((product) => product.status.toLowerCase() === "active");

    return products;
  } catch (error) {
    console.error("Error loading sheet:", error);
    return [];
  }
}

// ========= UI: PRODUCT CARDS =========
function renderProductCard(product) {
  const title = escapeHtml(product.title);
  const image = escapeHtml(product.image);
  const url = escapeHtml(product.url);
  const price = formatPrice(product.price);

  return `
    <article class="product-card" data-url="${url}" data-id="${escapeHtml(product.id)}">
      <button
        class="heart ${isSaved(product.id) ? "active" : ""}"
        data-id="${escapeHtml(product.id)}"
        aria-label="Save ${title} to wishlist"
        type="button"
      >♥</button>

      <div class="product-image-wrap">
        <img class="product-image" src="${image}" alt="${title}" loading="lazy" />
      </div>

      <div class="product-card-body">
        <h3 class="product-title">${title}</h3>
        <div class="product-price">${price}</div>
      </div>
    </article>
  `;
}

function wireHeartButtons(container, products) {
  if (!container) return;

  container.querySelectorAll(".product-card").forEach((card) => {
    card.addEventListener("click", (event) => {
      if (event.target.closest(".heart")) return;

      const url = card.dataset.url;
      if (url && url !== "#") {
        window.open(url, "_blank", "noopener");
      }
    });
  });

  container.querySelectorAll(".heart").forEach((btn) => {
    btn.addEventListener("click", (event) => {
      event.stopPropagation();

      const id = btn.dataset.id;
      const item = products.find((p) => p.id === id);
      if (!item) return;

      const didToggle = toggleWishlist(item);
      if (!didToggle) return;

      renderHomeTrending(window.__products || []);
      renderGalleryPage(window.__products || []);
      renderWishlistPage(window.__products || []);
    });
  });
}

// ========= HOME TRENDING =========
function renderHomeTrending(products) {
  const holder = $("home-trending");
  if (!holder) return;

  const top = [...products]
    .sort((a, b) => (b.popularity || 0) - (a.popularity || 0))
    .slice(0, 7);

  holder.innerHTML = top.map(renderProductCard).join("");
  wireHeartButtons(holder, products);
}

// ========= WISHLIST PAGE =========
function renderWishlistPage(products) {
  const grid = $("wishlist-products");
  const signedOut = $("wishlistSignedOut");
  const signedIn = $("wishlistSignedIn");
  const emailEl = $("signedInEmail");
  const emptyEl = $("wishlistEmpty");
  const subtitle = $("wishlistSubtitle");

  if (!grid || !signedOut || !signedIn) return;

  if (!isSignedIn()) {
    signedOut.classList.remove("hidden");
    signedIn.classList.add("hidden");

    if (subtitle) {
      subtitle.textContent = "Save your favorite gifts and keep your plan organized.";
    }
    return;
  }

  signedOut.classList.add("hidden");
  signedIn.classList.remove("hidden");

  if (emailEl) emailEl.textContent = getUserEmail();
  if (subtitle) subtitle.textContent = "Your saved gifts, all in one place.";

  const ids = getWishlist().map((item) => item.id);
  const items = ids
    .map((id) => products.find((p) => p.id === id) || getWishlist().find((p) => p.id === id))
    .filter(Boolean);

  if (!items.length) {
    grid.innerHTML = "";
    emptyEl?.classList.remove("hidden");
    return;
  }

  emptyEl?.classList.add("hidden");
  grid.innerHTML = items.map(renderProductCard).join("");
  wireHeartButtons(grid, products.length ? products : items);
}

// ========= GALLERY FILTERS / SORT =========
function getGalleryFilters() {
  const sort =
    document.querySelector(".sort-btn.active")?.dataset.sort || "popular";

  const gender =
    document.querySelector('#genderPills [data-gender].active')?.dataset.gender || "all";

  const category = $("categoryFilter")?.value || "all";

  return { sort, gender, category };
}

function renderGalleryPage(products) {
  const grid = $("gallery-products");
  if (!grid) return;

  const { sort, gender, category } = getGalleryFilters();

  let list = [...products];

  if (gender !== "all") {
    list = list.filter((p) => p.gender === gender || p.gender === "all");
  }

  if (category !== "all") {
    list = list.filter((p) => p.category === category);
  }

  if (sort === "popular") {
    list.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
  }

  if (sort === "recent") {
    list.sort((a, b) => {
      const aDate = new Date(a.addedAt || 0).getTime();
      const bDate = new Date(b.addedAt || 0).getTime();
      return bDate - aDate;
    });
  }

  grid.innerHTML = list.map(renderProductCard).join("");

  if (!list.length) {
    grid.innerHTML = `<div class="callout"><p>No gifts match this filter yet.</p></div>`;
    return;
  }

  wireHeartButtons(grid, products);
}

function initGalleryUI(products) {
  const sortRow = document.querySelector(".sort-row");
  const genderWrap = $("genderPills");
  const categorySelect = $("categoryFilter");

  sortRow?.addEventListener("click", (event) => {
    const btn = event.target.closest(".sort-btn");
    if (!btn) return;

    document.querySelectorAll(".sort-btn").forEach((b) => {
      b.classList.remove("active");
    });

    btn.classList.add("active");
    renderGalleryPage(products);
  });

  genderWrap?.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-gender]");
    if (!btn) return;

    genderWrap.querySelectorAll("[data-gender]").forEach((b) => {
      b.classList.remove("active");
    });

    btn.classList.add("active");
    renderGalleryPage(products);
  });

  categorySelect?.addEventListener("change", () => {
    renderGalleryPage(products);
  });
}

// ========= AUTH FORM =========
function initAuthForm() {
  $("authButton")?.addEventListener("click", handleAuthClick);
  $("mobileAuthButton")?.addEventListener("click", handleAuthClick);

  $("authModalClose")?.addEventListener("click", closeModal);
  $("authBackdrop")?.addEventListener("click", closeModal);

  $("authForm")?.addEventListener("submit", (event) => {
    event.preventDefault();

    const email = $("authEmail")?.value?.trim();
    const agree = $("authAgree")?.checked;

    if (!email || !agree) return;

    localStorage.setItem(AUTH_EMAIL_KEY, email);
    closeModal();
    updateAuthUI();
    renderWishlistPage(window.__products || []);
    renderHomeTrending(window.__products || []);
    renderGalleryPage(window.__products || []);
    closeMobileMenu();
  });
}

// ========= INIT =========
document.addEventListener("DOMContentLoaded", async () => {
  initMenu();
  initAuthForm();
  updateAuthUI();

  const products = await loadProducts();
  window.__products = products;

  renderHomeTrending(products);
  renderWishlistPage(products);

  if ($("gallery-products")) {
    initGalleryUI(products);
    renderGalleryPage(products);
  }
});
