// ========= CONFIG =========
const WISHLIST_KEY = "7DG_WISHLIST_LOCAL";
const EMAIL_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbzVRgumxRdyeCgWhTqvo_tpM_x_hTMrCJQbrltrMr1hJ-LpnE5DLIXduDrrDlIVp2OT/exec";
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
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeGender(value) {
  const v = String(value || "").trim().toLowerCase();

  if (["him", "for him", "male", "man", "men", "groom"].includes(v)) return "him";
  if (["her", "for her", "female", "woman", "women", "bride", "wife", "fiancee", "fiancé", "fiance"].includes(v)) return "her";
  return "all";
}

function formatPrice(price) {
  const n = Number(price);
  if (!Number.isFinite(n) || n <= 0) return "";
  return `$${n}`;
}

function parseCSVLine(line) {
  const result = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const next = line[i + 1];

    if (char === '"' && inQuotes && next === '"') {
      current += '"';
      i++;
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

// ========= WISHLIST =========
function getWishlist() {
  return safeParse(localStorage.getItem(WISHLIST_KEY), []);
}

function setWishlist(list) {
  localStorage.setItem(WISHLIST_KEY, JSON.stringify(list));
}

function isSaved(productId) {
  return getWishlist().some((item) => item.id === productId);
}

function toggleWishlist(product) {
  const list = getWishlist();
  const index = list.findIndex((item) => item.id === product.id);

  if (index >= 0) {
    list.splice(index, 1);
  } else {
    list.push(product);
  }

  setWishlist(list);
}

// ========= PRODUCTS =========
async function loadProducts() {
  try {
    const response = await fetch(SHEET_URL);
    const csvText = await response.text();

    const lines = csvText
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0);

    if (!lines.length) return [];

    const headers = parseCSVLine(lines[0]);
    const rows = lines.slice(1).map(parseCSVLine);

    return rows
      .map((row, index) => {
        const obj = {};
        headers.forEach((header, i) => {
          obj[header.trim()] = row[i] ?? "";
        });

        const asin = String(obj.amazon_asin || "").trim();
        const id = String(obj.product_id || "").trim() || asin || `product-${index + 1}`;
        const image = String(obj.photo_url || "").trim();

        return {
          id,
          asin,
          title: String(obj.site_title || "Untitled product").trim(),
          price: Number(obj.price) || 0,
          image,
          url: asin ? `https://www.amazon.com/dp/${asin}?tag=7daygifts-20` : "#",
          category: String(obj.categories || "").trim(),
          gender: normalizeGender(obj.who_is_it_for),
          popularity: Number(obj.click_count) || 0,
          addedAt:
            String(obj.added_at || "").trim() ||
            String(obj.created_at || "").trim() ||
            String(obj.date_added || "").trim() ||
            `2026-01-${String((index % 28) + 1).padStart(2, "0")}`,
          status: String(obj.status || "").trim().toLowerCase(),
          hasImage: !!image
        };
      })
      .filter((product) => product.status === "active");
  } catch (error) {
    console.error("Error loading products:", error);
    return [];
  }
}

// ========= PRODUCT CARDS =========
function renderProductCard(product) {
  const title = escapeHtml(product.title);
  const url = escapeHtml(product.url);
  const id = escapeHtml(product.id);
  const price = formatPrice(product.price);
  const hasImage = Boolean(product.image && product.image.trim());

  return `
    <article class="product-card" data-url="${url}" data-id="${id}">
      <button
        type="button"
        class="heart ${isSaved(product.id) ? "active" : ""}"
        data-id="${id}"
        aria-label="Save ${title}"
      >♥</button>

      <div class="product-image-wrap ${hasImage ? "" : "image-missing"}">
        ${
          hasImage
            ? `<img
                class="product-image"
                src="${escapeHtml(product.image)}"
                alt="${title}"
                loading="lazy"
                onerror="this.style.display='none'; this.parentElement.classList.add('image-missing');"
              />`
            : ""
        }
        <div class="image-fallback">Image coming soon</div>
      </div>

      <div class="product-card-body">
        <h3 class="product-title">${title}</h3>
        <div class="product-price">${price}</div>
      </div>
    </article>
  `;
}
function wireCardButtons(container, sourceProducts) {
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
      const product = sourceProducts.find((p) => p.id === id);
      if (!product) return;

      toggleWishlist(product);
      refreshAllUI();
    });
  });
}

// ========= HOME =========
function renderHomeTrending(products) {
  const holder = $("home-trending");
  if (!holder) return;

  const top = [...products]
    .sort((a, b) => (b.popularity || 0) - (a.popularity || 0))
    .slice(0, 7);

  holder.innerHTML = top.map(renderProductCard).join("");
  wireCardButtons(holder, products);
}

// ========= WISHLIST PAGE =========
function renderWishlistPage(products) {
  const grid = $("wishlist-products");
  const subtitle = $("wishlistSubtitle");
  const emptyEl = $("wishlistEmpty");

  if (!grid) return;

  if (subtitle) {
    subtitle.textContent = "Saved on this device.";
  }

  const savedItems = getWishlist();

  if (!savedItems.length) {
    grid.innerHTML = "";
    emptyEl?.classList.remove("hidden");
    return;
  }

  const fullItems = savedItems.map((saved) => {
    return products.find((p) => p.id === saved.id) || saved;
  });

  emptyEl?.classList.add("hidden");
  grid.innerHTML = fullItems.map(renderProductCard).join("");
  wireCardButtons(grid, fullItems);
}

// ========= GALLERY =========
function getGalleryFilters() {
  const gender =
    document.querySelector('#genderPills [data-gender].active')?.dataset.gender || "all";

  const sort =
    document.querySelector(".sort-btn.active")?.dataset.sort || "popular";

  const category = $("categoryFilter")?.value || "all";

  return { gender, sort, category };
}

function renderGalleryPage(products) {
  const grid = $("gallery-products");
  if (!grid) return;

  const { gender, sort, category } = getGalleryFilters();

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

  if (!list.length) {
    grid.innerHTML = `<div class="callout"><p>No gifts match this filter yet.</p></div>`;
    return;
  }

  grid.innerHTML = list.map(renderProductCard).join("");
  wireCardButtons(grid, products);
}

function initGalleryUI(products) {
  const genderWrap = $("genderPills");
  const sortRow = document.querySelector(".sort-row");
  const categoryFilter = $("categoryFilter");

  genderWrap?.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-gender]");
    if (!btn) return;

    genderWrap.querySelectorAll("[data-gender]").forEach((b) => {
      b.classList.remove("active");
    });

    btn.classList.add("active");
    renderGalleryPage(products);
  });

  sortRow?.addEventListener("click", (event) => {
    const btn = event.target.closest(".sort-btn");
    if (!btn) return;

    sortRow.querySelectorAll(".sort-btn").forEach((b) => {
      b.classList.remove("active");
    });

    btn.classList.add("active");
    renderGalleryPage(products);
  });

  categoryFilter?.addEventListener("change", () => {
    renderGalleryPage(products);
  });
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

    try {
      const response = await fetch(EMAIL_SCRIPT_URL, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain;charset=utf-8"
        },
        body: JSON.stringify({
          email,
          wedding_date: weddingDate,
          source: "7daygifts_site",
          company
        })
      });

      if (!response.ok) {
        throw new Error("Request failed");
      }

      form.reset();
      success?.classList.remove("hidden");
    } catch (err) {
      console.error(err);
      error?.classList.remove("hidden");
    }
  });
}

// ========= GLOBAL REFRESH =========
function refreshAllUI() {
  const products = window.__products || [];
  renderHomeTrending(products);
  renderGalleryPage(products);
  renderWishlistPage(products);
}

// ========= INIT =========
document.addEventListener("DOMContentLoaded", async () => {
  initMenu();
  initEmailForm();

  const products = await loadProducts();
  window.__products = products;

  if ($("gallery-products")) {
    initGalleryUI(products);
  }

  refreshAllUI();
});
