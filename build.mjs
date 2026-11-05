#!/usr/bin/env node
// 7 Day Gifts static site builder.
// Reads the published Google Sheet (the only place products are added) and writes
// plain HTML pages, sitemap.xml and robots.txt. No dependencies; Node 18+.
//
//   node build.mjs                 -> writes the live site into this folder
//   node build.mjs --preview DIR   -> writes a noindex preview copy into DIR
//   node build.mjs --csv FILE      -> use a saved CSV instead of fetching
import { readFile, writeFile, mkdir, rm, copyFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SITE = "https://7daygifts.com";
const SHEET_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vRIP3mbNKwA1vi20Aufe7uKOBp-9HYV1kIot6FNnbZyPG7IT9xazlOqA9jii5b9lLuJBO6ydMNiyzSi/pub?gid=0&single=true&output=csv";
const AFFILIATE_TAG = "7daygifts-20";
const GA_ID = "G-LF9WFYVSB1";
const MIN_PRODUCTS = 10; // refuse to publish if the sheet suddenly looks empty

const args = process.argv.slice(2);
const PREVIEW = args.includes("--preview");
const OUT = PREVIEW ? path.resolve(args[args.indexOf("--preview") + 1] || "preview") : ROOT;
const CSV_FILE = args.includes("--csv") ? args[args.indexOf("--csv") + 1] : null;

// ---------- helpers ----------
const esc = (v) =>
  String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const slugify = (s) => {
  let v = String(s).toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (v.length > 60) { v = v.slice(0, 61); v = v.slice(0, v.lastIndexOf("-")); }
  return v.replace(/-+$/g, "");
};
const clip = (s, n) => { s = String(s).trim(); if (s.length <= n) return s; const c = s.slice(0, n - 1); return c.slice(0, c.lastIndexOf(" ")).replace(/[,.;:\s]+$/, "") + "…"; };

function parseCSV(text) {
  const rows = []; let row = []; let cur = ""; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cur); rows.push(row); row = []; cur = "";
    } else cur += c;
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  const headers = (rows.shift() || []).map((h) => h.trim());
  return rows.filter((r) => r.some((v) => v.trim())).map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? "").trim()])));
}

function normalizeGender(value) {
  const v = String(value || "").trim().toLowerCase();
  if (["him", "for him", "male", "man", "men", "groom", "chosson"].includes(v)) return "him";
  if (["her", "for her", "female", "woman", "women", "bride", "wife", "kallah", "fiancee", "fiancé", "fiance"].includes(v)) return "her";
  return "all";
}

// Photos that go through a third-party image proxy embed the real Amazon image URL.
function cleanImage(url) {
  url = String(url || "").trim();
  const i = url.indexOf("m.media-amazon.com/");
  if (i > 0 && !/^https?:\/\/m\.media-amazon\.com\//.test(url)) return "https://" + url.slice(i);
  return url;
}

// A short display name from a long Amazon-style title.
function shortName(title) {
  let t = String(title).replace(/\s+/g, " ").trim();
  t = t.replace(/\s*\([^)]*\)\s*$/, "");
  for (const sep of [" | ", " - ", " – ", ", "]) {
    const i = t.indexOf(sep);
    if (i >= 12) { t = t.slice(0, i); }
  }
  t = t.replace(/[\s,\-–|]+$/, "");
  return t.length > 70 ? clip(t, 70) : t;
}

// ---------- shops: products that are not on Amazon ----------
// A Sheet row with amazon_enabled = FALSE and a my_url that is not an Amazon link links straight to
// that shop: the button says "Shop at <domain>", and the product also appears under "Small Shops".
const SMALL_SHOPS = "Small Shops";
const AMAZON_HOST_RX = /(^|\.)(amazon\.[a-z.]+|amzn\.to|amzn\.com|amzn\.eu|a\.co)$/i;
const AFFILIATE_PARAM_RX = /[?&#](ref|tag|aff|affid|aff_id|aff_sub|affiliate|affiliate_id|aid|irclickid|irgwc|clickid|ranmid|raneaid|ransiteid|sscid|cjevent|awc|sharedid|rfsn|partner|partner_id|via|utm_medium=affiliate)(=|&|$)/i;
const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; } };
const isOff = (v) => /^(false|no|n|0|off)$/i.test(String(v ?? "").trim());
function linkFor(o, asin) {
  const raw = String(o.my_url || "").trim();
  const mine = /^https?:\/\//i.test(raw) ? raw : (/^[\w-]+(\.[\w-]+)+(\/|$)/.test(raw) ? "https://" + raw : "");
  const host = hostOf(mine);
  if (host && !AMAZON_HOST_RX.test(host) && (isOff(o.amazon_enabled) || !asin)) {
    const affiliate = AFFILIATE_PARAM_RX.test(mine);
    return { url: mine, shop: host, affiliate, rel: affiliate ? "sponsored nofollow noopener" : "nofollow noopener" };
  }
  if (asin) return { url: `https://www.amazon.com/dp/${asin}?tag=${AFFILIATE_TAG}`, shop: "", affiliate: true, rel: "sponsored nofollow noopener" };
  if (mine) return { url: mine, shop: "", affiliate: true, rel: "sponsored nofollow noopener" }; // amzn.to short links
  return null;
}
const buyLabel = (p) => (p.shop ? `Shop at ${p.shop}` : "Check price on Amazon");
const linkClass = (p) => (p.shop ? "amazon-link shop-link" : "amazon-link");

// ---------- gift guides: hand-picked + tagged in the Sheet ----------
// Each guide section in data/guides.json has a short "key" (day2-cozy, kallah-cozy, chanukah-wife…).
// Typing that key in a product's "guides" column in the Sheet adds the product to that section,
// after the hand-picked ones, most popular first, up to GUIDE_CAP gifts per section.
// Shortcuts: "day2" = day2-cozy; "chanukah" = chanukah-wife / -husband / -both by who it's for.
const GUIDE_CAP = 8;
const parseGuideTags = (v) => String(v || "").toLowerCase().split(/[,;\n]/)
  .map((s) => s.trim().replace(/[\s_]+/g, "-").replace(/^day-(\d)/, "day$1")).filter(Boolean);
const WEDDING_WORDS_RX = /\bmr\.?\s*(?:&|and)\s*mrs\b|\bbride\b|\bgroom\b|\bnewly ?weds?\b/i;
function fillGuides(guides, products) {
  const sections = guides.flatMap((g) => g.sections.filter((s) => s.key));
  const byKey = new Map(sections.map((s) => [s.key, s]));
  const unknown = new Set();
  const resolve = (tag, p) => {
    if (byKey.has(tag)) return byKey.get(tag);
    if (tag === "chanukah") return byKey.get(p.gender === "her" ? "chanukah-wife" : p.gender === "him" ? "chanukah-husband" : "chanukah-both");
    const hits = sections.filter((s) => s.key.split("-")[0] === tag);
    if (hits.length === 1) return hits[0];
    unknown.add(tag); return null;
  };
  const tagged = new Map();
  for (const p of [...products].sort(byPop)) for (const tag of p.guides || []) {
    const s = resolve(tag, p);
    if (!s) continue;
    if (!tagged.has(s)) tagged.set(s, []);
    if (!tagged.get(s).includes(p)) tagged.get(s).push(p);
  }
  const live = new Set(products.map((p) => p.id));
  let added = 0;
  for (const s of sections) {
    const room = Math.max(0, (s.cap || GUIDE_CAP) - s.products.filter((id) => live.has(id)).length);
    const cardsOk = /card|wrap/i.test(s.heading);
    const seasonal = /^chanukah/.test(s.key);
    const extra = (tagged.get(s) || []).filter((p) => !s.products.includes(p.id)
      && (cardsOk || !/card|wrap/i.test(p.category))
      && !(seasonal && (p.weddingOnly ?? WEDDING_WORDS_RX.test(p.title)))).slice(0, room);
    s.products = [...s.products, ...extra.map((p) => p.id)];
    added += extra.length;
  }
  return { added, unknown: [...unknown] };
}

const WHO = {
  him: { slug: "him", label: "For Him", h1: "Gifts for Him: the Chosson or Your Husband", title: "Gifts for Him: Chosson & Husband Gift Ideas", blurb: "Gift ideas for a chosson in the week before the wedding, or for your husband on an anniversary or Yom Tov.", phrase: "him" },
  her: { slug: "her", label: "For Her", h1: "Gifts for Her: the Kallah or Your Wife", title: "Gifts for Her: Kallah & Wife Gift Ideas", blurb: "Gift ideas for a kallah in the week before the wedding, or for your wife on an anniversary or Yom Tov.", phrase: "her" },
  all: { slug: "couples", label: "For Both", h1: "Gifts for Either of You", title: "Gifts for Couples & Either Spouse", blurb: "Gifts that work for a chosson or a kallah, a husband or a wife, or the two of you together.", phrase: "either of you" },
};

// ---------- data ----------
async function readJSON(rel, fallback) {
  try { return JSON.parse(await readFile(path.join(ROOT, rel), "utf8")); } catch { return fallback; }
}

async function loadSheet() {
  if (CSV_FILE) return readFile(CSV_FILE, "utf8");
  let last;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(SHEET_URL, { redirect: "follow" });
      if (!r.ok) throw new Error(`sheet answered HTTP ${r.status}`);
      return await r.text();
    } catch (e) { last = e; await new Promise((res) => setTimeout(res, 2000 * attempt)); }
  }
  throw last;
}

async function loadProducts() {
  const rows = parseCSV(await loadSheet());
  const descriptions = await readJSON("data/descriptions.json", {});
  const slugLock = await readJSON("data/slugs.json", {});
  const names = await readJSON("data/names.json", {}); // optional short display names, keyed by product_id
  const used = new Set(Object.values(slugLock));
  const products = [];
  rows.forEach((o, index) => {
    if (String(o.status || "").toLowerCase() !== "active") return;
    const asin = String(o.amazon_asin || "").replace(/[^A-Za-z0-9]/g, "");
    const id = String(o.product_id || "").trim() || asin || `product-${index + 1}`;
    const title = String(o.site_title || "").trim();
    if (!title) return;
    const link = linkFor(o, asin);
    if (!link) return;
    const { url, shop, rel } = link;
    const name = String(names[id] || "").trim() || shortName(title);
    let slug = slugLock[id];
    if (!slug) {
      const base = slugify(name) || slugify(id);
      slug = base; let n = 2;
      while (used.has(slug)) slug = `${base}-${n++}`;
      used.add(slug); slugLock[id] = slug;
    }
    const category = String(o.categories ?? o["categories "] ?? "").trim();
    products.push({
      id, asin, title, name, slug, url, shop, rel,
      guides: parseGuideTags(o.guides),
      image: cleanImage(o.photo_url),
      category,
      gender: normalizeGender(o.who_is_it_for),
      popularity: Number(o.click_count) || 0,
      order: index,
      description: String(o.site_description || "").trim() || descriptions[id] ||
        `${name} — a ${category ? category.toLowerCase() + " " : ""}gift idea ${WHO[normalizeGender(o.who_is_it_for)].phrase === "either of you" ? "for either of you" : "for " + WHO[normalizeGender(o.who_is_it_for)].phrase}, hand-picked by 7 Day Gifts.`,
      band: normalizeBand(o.price),
      occasions: String(o.occasions || "").split(/[,;]/).map((s) => s.trim().toLowerCase()).filter(Boolean),
      hasOwnDescription: Boolean(String(o.site_description || "").trim() || descriptions[id]),
    });
  });
  return { products, slugLock };
}

// ---------- budget bands ----------
// The band text typed in the Sheet's "price" column is shown as-is (never an exact Amazon price).
const BAND_ORDER = ["Under $25", "$25–$50", "$50–$100", "$100–$200", "$200+"];
function normalizeBand(raw) {
  let s = String(raw ?? "").trim().replace(/\s*[-–—]\s*/g, "–").replace(/\s+/g, " ");
  if (!s) return "";
  const hit = BAND_ORDER.find((b) => b.toLowerCase().replace(/\s/g, "") === s.toLowerCase().replace(/\s/g, ""));
  return hit || s;
}
const bandRank = (b) => { const i = BAND_ORDER.indexOf(b); return i < 0 ? 99 : i; };
const priceLabel = (p) => (p.band ? `${esc(p.band)} · ` : "") + esc(buyLabel(p));

// ---------- page pieces ----------
const nav = [
  ["/index.html", "Home"], ["/gift-gallery.html", "Gift Gallery"], ["/guides/", "Gift Guides"], ["/wishlist.html", "Wish List"],
];

function head({ title, description, canonical, image, type = "website", noindex = false, jsonld = [] }) {
  const robots = PREVIEW || noindex ? `<meta name="robots" content="noindex${PREVIEW ? ", nofollow" : ", follow"}" />` : "";
  const img = image || `${SITE}/hero.jpg`;
  const ga = PREVIEW ? "" : `
  <script async src="https://www.googletagmanager.com/gtag/js?id=${GA_ID}"></script>
  <script>
    window.dataLayer = window.dataLayer || [];
    function gtag(){dataLayer.push(arguments);}
    gtag('js', new Date());
    gtag('config', '${GA_ID}');
  </script>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>${esc(title)}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="description" content="${esc(description)}" />
  ${robots}${PREVIEW ? '\n  <meta name="7dg-preview" content="1" />' : ""}
  <link rel="canonical" href="${esc(canonical)}" />
  <meta property="og:site_name" content="7 Day Gifts" />
  <meta property="og:type" content="${type}" />
  <meta property="og:title" content="${esc(title)}" />
  <meta property="og:description" content="${esc(description)}" />
  <meta property="og:url" content="${esc(canonical)}" />
  <meta property="og:image" content="${esc(img)}" />
  <meta name="twitter:card" content="summary_large_image" />
  <link rel="stylesheet" href="/style.css?v=12" />
  <link rel="icon" href="/favicon.ico" sizes="any" />
  <link rel="apple-touch-icon" href="/logo.png" />${jsonld.map((j) => `\n  <script type="application/ld+json">${JSON.stringify(j).replace(/</g, "\\u003c")}</script>`).join("")}${ga}
</head>`;
}

function header(active) {
  const links = nav.map(([href, label]) => `<a href="${href}" class="nav-link${label === active ? " active" : ""}">${label}</a>`).join("\n          ");
  const mlinks = nav.map(([href, label]) => `<a href="${href}" class="mobile-link${label === active ? " active" : ""}"${label === active ? ' aria-current="page"' : ""}><span>${label}</span><span class="mobile-link-chev" aria-hidden="true">›</span></a>`).join("\n      ");
  return `
<body>
  <div class="page">
    <header class="site-header">
      <div class="header-inner">
        <a href="/index.html" class="logo-wrap" aria-label="7 Day Gifts home">
          <img src="/logo.png" class="logo-img" alt="7 Day Gifts logo" width="72" height="72" />
          <span class="logo-text">7 Day Gifts</span>
        </a>
        <nav class="main-nav" aria-label="Primary">
          ${links}
        </nav>
        <div class="header-actions">
          <button id="menuToggle" class="menu-toggle mobile-only" aria-label="Open menu" aria-controls="mobileMenu">☰</button>
        </div>
      </div>
    </header>
    <div class="affiliate-topbar">
      As an Amazon Associate and affiliate partner, we may earn from qualifying purchases.
    </div>
    <div id="menuOverlay" class="menu-overlay" hidden></div>
    <aside id="mobileMenu" class="mobile-menu" aria-label="Mobile menu" aria-hidden="true">
      <button type="button" id="menuClose" class="menu-close" aria-label="Close menu">✕</button>
      ${mlinks}
    </aside>
    <main class="main-content">`;
}

function footer(ctx) {
  const year = new Date().getFullYear();
  const cats = ctx.categories.filter((c) => c.indexable).map((c) => `<a href="/category/${c.slug}.html">${esc(c.name)}</a>`).join("");
  const guides = ctx.guides.map((g) => `<a href="/guides/${g.slug}.html">${esc(shortGuide(g.title))}</a>`).join("");
  return `
    </main>
    <footer class="site-footer">
      <div class="footer-links">
        <div><div class="footer-heading">Gift guides</div>${guides}</div>
        <div><div class="footer-heading">Who it's for</div><a href="/for/her.html">Gifts for her</a><a href="/for/him.html">Gifts for him</a><a href="/for/couples.html">Gifts for either of you</a></div>
        <div><div class="footer-heading">Categories</div><div class="footer-cats">${cats}</div></div>
      </div>
      <div class="footer-inner">
        <span>© ${year} 7DayGifts.com</span>
        <span>Phone: <a href="tel:14753294438">475-329-4438</a></span>
        <span>Email: <a href="mailto:info@7daygifts.com">info@7daygifts.com</a></span>
      </div>
      <div class="footer-disclosure">
        When you buy through our links, we may earn a small commission. Prices and availability are set by Amazon (or by the shop, for Small Shops gifts) and can change, so check the current price before you buy.
      </div>
    </footer>
  </div>
  <script src="/app.js?v=9"></script>
</body>
</html>
`;
}
const shortGuide = (t) => t.split(":")[0];
function guideCard(ctx, g) {
  const ids = [...new Set(g.sections.flatMap((s) => s.products))];
  const pics = ids.map((id) => ctx.products.find((p) => p.id === id)).filter((p) => p && p.image).slice(0, 4);
  const strip = pics.length ? `<span class="guide-card-photos">${pics.map((p) => `<img src="${esc(p.image)}" alt="" loading="lazy" width="160" height="160" onerror="this.style.visibility='hidden'" />`).join("")}</span>` : "";
  return `<a class="guide-card" href="/guides/${g.slug}.html">${strip}<span class="guide-card-title">${esc(g.title)}</span><span class="guide-card-text">${esc(g.description)}</span></a>`;
}

function card(p, { headingTag = "h3" } = {}) {
  const img = p.image
    ? `<img class="product-image" src="${esc(p.image)}" alt="${esc(p.name)}" loading="lazy" width="500" height="500" onerror="this.style.display='none';this.parentElement.classList.add('image-missing');" />`
    : "";
  return `<article class="product-card" data-id="${esc(p.id)}" data-gender="${p.gender}" data-category="${esc(p.category)}" data-pop="${p.popularity}" data-order="${p.order}" data-band="${esc(p.band)}" data-shop="${p.shop ? 1 : 0}">
  <button type="button" class="heart" data-id="${esc(p.id)}" aria-label="Save ${esc(p.name)} to your wish list"><svg class="heart-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg></button>
  <a class="product-link" href="/gifts/${p.slug}.html">
    <div class="product-image-wrap${p.image ? "" : " image-missing"}">${img}<div class="image-fallback">Image coming soon</div></div>
    <${headingTag} class="product-title">${esc(p.name)}</${headingTag}>
  </a>
  <div class="product-card-body">
    <a class="btn-pill btn-amazon ${linkClass(p)}" href="${esc(p.url)}" target="_blank" rel="${p.rel}" data-id="${esc(p.id)}">${priceLabel(p)}</a>
  </div>
</article>`;
}
const grid = (list, id = "") => `<div class="product-grid"${id ? ` id="${id}"` : ""}>\n${list.map((p) => card(p)).join("\n")}\n</div>`;
const byPop = (a, b) => b.popularity - a.popularity || a.order - b.order;

function crumbs(items) {
  const html = `<nav class="breadcrumbs" aria-label="Breadcrumb">${items.map(([href, label], i) =>
    i === items.length - 1 ? `<span aria-current="page">${esc(label)}</span>` : `<a href="${href}">${esc(label)}</a><span class="sep" aria-hidden="true">›</span>`).join("")}</nav>`;
  const ld = { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: items.map(([href, label], i) => ({ "@type": "ListItem", position: i + 1, name: label, item: SITE + href })) };
  return { html, ld };
}

function sectionHeader(h, sub, tag = "h2") {
  return `<div class="section-header"><div><${tag} class="section-title">${h}</${tag}>${sub ? `<p class="section-subtitle">${sub}</p>` : ""}</div></div>`;
}

const emailBlock = `
      <section class="section">
        <div class="email-capture-card">
          <h2 class="email-capture-title">Join Our List for Future Gift Ideas</h2>
          <p class="email-capture-text">
            Get Chanukah gift ideas, Jewish holiday gift catalogs, anniversary reminders,
            and thoughtful inspiration for the moments when you do not want to feel stuck choosing a gift.
          </p>
          <form id="emailForm" class="email-form">
            <label class="email-label" for="emailInput">Email address</label>
            <input type="email" id="emailInput" name="email" class="email-input" placeholder="Enter your email" required />
            <label class="email-label" for="weddingDate">When is your wedding? (optional)</label>
            <input type="date" id="weddingDate" name="weddingDate" class="email-input" />
            <button type="submit" class="btn-pill btn-primary email-submit">Join Our List</button>
          </form>
          <p id="emailSuccess" class="email-message hidden">You're in — we saved your info.</p>
          <p id="emailError" class="email-message email-error hidden">Something went wrong. Please try again.</p>
          <p id="emailPreview" class="email-message hidden">This is a preview copy of the site, so sign-up is switched off here.</p>
        </div>
      </section>`;

// ---------- pages ----------
function pageHome(ctx) {
  const { products } = ctx;
  const top = [...products].sort(byPop).slice(0, 7);
  const ld = [{ "@context": "https://schema.org", "@type": "WebSite", name: "7 Day Gifts", url: SITE + "/" },
    { "@context": "https://schema.org", "@type": "Organization", name: "7 Day Gifts", url: SITE + "/", logo: SITE + "/logo.png", email: "info@7daygifts.com", telephone: "+1-475-329-4438" }];
  return head({ title: "7 Day Gifts · Gift Ideas for the 7 Days Before the Wedding", description: "Thoughtful gift ideas for the seven days before a Jewish wedding, for the chosson and the kallah, plus anniversary and Chanukah gifts for your spouse.", canonical: SITE + "/", jsonld: ld }) + header("Home") + `
      <section class="section hero">
        <div class="hero-card">
          <h1 class="hero-title">Thoughtful 7-day wedding gift ideas for the meaningful days leading up to a wedding — and beyond.</h1>
          <p class="hero-subtitle">Feeling overwhelmed trying to plan seven meaningful gifts? Browse curated ideas for the week before the wedding, anniversaries, and special occasions so choosing something thoughtful feels easier.</p>
          <div class="hero-actions">
            <a class="btn-pill btn-primary" href="/gift-gallery.html">Full Gallery</a>
            <a class="btn-pill btn-ghost" href="/guides/7-day-gift-ideas-before-the-wedding.html">Ideas for each day</a>
          </div>
        </div>
      </section>

      <section class="section">
        ${sectionHeader("Trending: 7 Most Popular", "Gifts chosen most often for the week before the wedding.")}
        ${grid(top, "home-trending")}
      </section>

      <section class="section">
        ${sectionHeader("Shop by who it's for")}
        <div class="tile-row">
          <a class="tile" href="/for/her.html"><span class="tile-title">For the Kallah</span><span class="tile-sub">or your wife</span></a>
          <a class="tile" href="/for/him.html"><span class="tile-title">For the Chosson</span><span class="tile-sub">or your husband</span></a>
          <a class="tile" href="/for/couples.html"><span class="tile-title">For Either of You</span><span class="tile-sub">or the two of you together</span></a>
        </div>
      </section>

      <section class="section">
        ${sectionHeader("Gift guides", "Short, practical guides to help you plan.")}
        <div class="guide-list">
          ${ctx.guides.map((g) => guideCard(ctx, g)).join("\n          ")}
        </div>
      </section>

      <section class="section">
        ${sectionHeader("Browse by category")}
        <div class="chip-row">${ctx.categories.map((c) => `<a class="chip" href="/category/${c.slug}.html">${esc(c.name)} <span class="chip-count">${c.products.length}</span></a>`).join("")}</div>
      </section>

      <section class="section">
        <div class="callout">
          <h2 class="callout-title">Our Mission</h2>
          <p>7 Day Gifts exists to make the seven days before your wedding feel intentional, meaningful, and joyful. Our gift ideas help couples add thoughtfulness and connection during one of the most special weeks of their lives.</p>
        </div>
      </section>
${emailBlock}` + footer(ctx);
}

function pageGallery(ctx) {
  const list = [...ctx.products].sort(byPop);
  const bands = [...new Set(ctx.products.map((p) => p.band).filter(Boolean))].sort((a, b) => bandRank(a) - bandRank(b) || a.localeCompare(b));
  const bandOpts = bands.map((b) => `<option value="${esc(b)}">${esc(b)}</option>`).join("\n              ");
  const opts = ctx.categories.map((c) => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join("\n              ");
  const ld = { "@context": "https://schema.org", "@type": "CollectionPage", name: "Gift Gallery", url: SITE + "/gift-gallery.html",
    mainEntity: { "@type": "ItemList", numberOfItems: list.length, itemListElement: list.map((p, i) => ({ "@type": "ListItem", position: i + 1, url: `${SITE}/gifts/${p.slug}.html`, name: p.name })) } };
  return head({ title: "Gift Gallery: All 7 Day Wedding Gift Ideas · 7 Day Gifts", description: `Browse all ${list.length} gift ideas for the chosson, the kallah and your spouse. Filter by who it's for and by category.`, canonical: SITE + "/gift-gallery.html", jsonld: [ld] }) + header("Gift Gallery") + `
      <section class="section">
        ${sectionHeader("Gift Gallery", "Filter by who it’s for, category and budget — then sort.", "h1")}
        <div class="filters">
          <div class="filter-group">
            <div class="filter-label">Who is it for?</div>
            <div class="pill-row" id="genderPills" aria-label="Who is it for">
              <button type="button" class="pill active" data-gender="all">All</button>
              <button type="button" class="pill" data-gender="him">For Him</button>
              <button type="button" class="pill" data-gender="her">For Her</button>
            </div>
          </div>
          <div class="filter-group">
            <div class="filter-label">Sort</div>
            <div class="sort-row" aria-label="Sort">
              <button type="button" class="sort-btn active" data-sort="popular">Most Popular</button>
              <button type="button" class="sort-btn" data-sort="recent">Most Recent</button>
            </div>
          </div>
          <div class="filter-group">
            <div class="filter-label">Category</div>
            <select id="categoryFilter" class="sort-select" aria-label="Category filter">
              <option value="all">All Categories</option>
              ${opts}
            </select>
          </div>
          ${bands.length ? `<div class="filter-group">
            <div class="filter-label">Budget</div>
            <select id="budgetFilter" class="sort-select" aria-label="Budget filter">
              <option value="all">Any budget</option>
              ${bandOpts}
            </select>
          </div>` : ""}
        </div>
        ${grid(list, "gallery-products")}
        <div id="galleryEmpty" class="callout hidden"><p>No gifts match this filter yet.</p></div>
      </section>` + footer(ctx);
}

function pageWishlist(ctx) {
  return head({ title: "Your Wish List · 7 Day Gifts", description: "The gifts you saved on 7 Day Gifts, kept on this device.", canonical: SITE + "/wishlist.html", noindex: true }) + header("Wish List") + `
      <section class="section">
        ${sectionHeader("Your Wish List", '<span id="wishlistSubtitle">Saved on this device.</span>', "h1")}
        <div id="wishlistEmpty" class="callout hidden">
          <p>Your wish list is empty. Tap the heart on any gift to save it here.</p>
          <p><a class="btn-pill btn-primary" href="/gift-gallery.html">Browse the gallery</a></p>
        </div>
        <div class="product-grid" id="wishlist-products"></div>
      </section>` + footer(ctx);
}

function pageProduct(ctx, p) {
  const who = WHO[p.gender];
  const cat = ctx.categories.find((c) => c.name === p.category);
  const related = [
    ...ctx.products.filter((q) => q.id !== p.id && q.category === p.category).sort(byPop),
    ...ctx.products.filter((q) => q.id !== p.id && q.category !== p.category && (q.gender === p.gender || p.gender === "all")).sort(byPop),
  ].slice(0, 4);
  const guides = ctx.guides.filter((g) => g.sections.some((s) => s.products.includes(p.id)));
  const items = [["/index.html", "Home"]];
  if (cat) items.push([`/category/${cat.slug}.html`, cat.name === "Home" ? "For the Home" : cat.name]); else items.push(["/gift-gallery.html", "Gift Gallery"]);
  items.push([`/gifts/${p.slug}.html`, p.name]);
  const bc = crumbs(items);
  const productLd = { "@context": "https://schema.org", "@type": "Product", name: p.title, description: p.description, sku: p.id, url: `${SITE}/gifts/${p.slug}.html` };
  if (p.image) productLd.image = [p.image];
  if (p.category) productLd.category = p.category;
  const whoLine = p.gender === "all" ? "Either of you" : p.gender === "him" ? "Him (the chosson or your husband)" : "Her (the kallah or your wife)";
  const title = `${clip(p.name, 48)} · Gift Idea ${p.gender === "all" ? "for Couples" : "for " + (p.gender === "him" ? "Him" : "Her")} | 7 Day Gifts`;
  return head({ title, description: clip(p.description, 158), canonical: `${SITE}/gifts/${p.slug}.html`, image: p.image, type: "product", jsonld: [productLd, bc.ld] }) + header("") + `
      <section class="section">
        ${bc.html}
        <article class="product-detail" data-id="${esc(p.id)}">
          <div class="product-detail-media">
            <div class="product-image-wrap${p.image ? "" : " image-missing"}">${p.image ? `<img class="product-image" src="${esc(p.image)}" alt="${esc(p.name)}" width="600" height="600" onerror="this.style.display='none';this.parentElement.classList.add('image-missing');" />` : ""}<div class="image-fallback">Image coming soon</div></div>
          </div>
          <div class="product-detail-body">
            <h1 class="product-detail-title">${esc(p.name)}</h1>
            <p class="product-detail-desc">${esc(p.description)}</p>
            <dl class="product-facts">
              <div><dt>Who it's for</dt><dd><a href="/for/${who.slug}.html">${esc(whoLine)}</a></dd></div>
              ${p.band ? `<div><dt>Budget</dt><dd>${esc(p.band)} <span class="band-note">(approx.; check ${p.shop ? "the shop" : "Amazon"} for today's price)</span></dd></div>` : ""}
              ${cat ? `<div><dt>Category</dt><dd><a href="/category/${cat.slug}.html">${esc(cat.name)}</a></dd></div>` : ""}
            </dl>
            <div class="product-actions">
              <a class="btn-pill btn-primary btn-big ${linkClass(p)}" href="${esc(p.url)}" target="_blank" rel="${p.rel}" data-id="${esc(p.id)}">${priceLabel(p)}</a>
              <button type="button" class="heart heart-btn" data-id="${esc(p.id)}" aria-label="Save ${esc(p.name)} to your wish list"><svg class="heart-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg></button>
            </div>
            ${p.title !== p.name && !p.shop ? `<p class="product-note">Amazon listing: ${esc(p.title)}</p>` : ""}
            ${p.shop ? `<p class="product-note">Sold by ${esc(p.shop)}. Price, shipping and returns are set by the shop.${p.rel.includes("sponsored") ? " We may earn a commission if you buy through this link." : ""}</p>` : `<p class="product-note">Price and delivery are shown on Amazon and can change. As an Amazon Associate we may earn from qualifying purchases.</p>`}
            ${guides.length ? `<p class="product-guides">Featured in: ${guides.map((g) => `<a href="/guides/${g.slug}.html">${esc(shortGuide(g.title))}</a>`).join(" · ")}</p>` : ""}
          </div>
        </article>
      </section>
      ${related.length ? `<section class="section">${sectionHeader("You might also like")}${grid(related)}</section>` : ""}` + footer(ctx);
}

function pageList(ctx, { h1, title, description, canonical, intro, list, crumbItems, extra = "", noindex = false }) {
  const bc = crumbs(crumbItems);
  const ld = { "@context": "https://schema.org", "@type": "CollectionPage", name: h1, url: canonical,
    mainEntity: { "@type": "ItemList", numberOfItems: list.length, itemListElement: list.map((p, i) => ({ "@type": "ListItem", position: i + 1, url: `${SITE}/gifts/${p.slug}.html`, name: p.name })) } };
  return head({ title, description, canonical, noindex, jsonld: [ld, bc.ld] }) + header("") + `
      <section class="section">
        ${bc.html}
        ${sectionHeader(esc(h1), esc(intro), "h1")}
        ${grid(list)}
        ${extra}
      </section>` + footer(ctx);
}

function pageCategory(ctx, c) {
  const list = [...c.products].sort(byPop);
  const intro = ctx.catIntros[c.name] || `Hand-picked ${c.name.toLowerCase()} gift ideas for the chosson, the kallah and your spouse.`;
  const others = ctx.categories.filter((o) => o.name !== c.name).map((o) => `<a class="chip" href="/category/${o.slug}.html">${esc(o.name)}</a>`).join("");
  return pageList(ctx, {
    h1: `${c.name} Gift Ideas`, title: `${c.name} Gift Ideas for the Chosson, Kallah & Spouse | 7 Day Gifts`,
    description: clip(`${intro} ${list.length} hand-picked ${list.length === 1 ? "idea" : "ideas"}.`, 158),
    canonical: `${SITE}/category/${c.slug}.html`, intro, list, noindex: !c.indexable,
    crumbItems: [["/index.html", "Home"], ["/gift-gallery.html", "Gift Gallery"], [`/category/${c.slug}.html`, c.name === "Home" ? "For the Home" : c.name]],
    extra: `<div class="more-block"><h2 class="more-title">More categories</h2><div class="chip-row">${others}</div></div>`,
  });
}

function pageWho(ctx, key) {
  const w = WHO[key];
  const list = ctx.products.filter((p) => (key === "all" ? p.gender === "all" : p.gender === key || p.gender === "all")).sort((a, b) => (a.gender === key ? 0 : 1) - (b.gender === key ? 0 : 1) || byPop(a, b));
  const guideLinks = key === "her" ? ["gifts-for-the-kallah", "chanukah-gifts-for-wife-or-husband"] : key === "him" ? ["gifts-for-the-chosson", "chanukah-gifts-for-wife-or-husband"] : ["7-day-gift-ideas-before-the-wedding", "chanukah-gifts-for-wife-or-husband"];
  const gl = ctx.guides.filter((g) => guideLinks.includes(g.slug)).map((g) => `<a class="chip" href="/guides/${g.slug}.html">${esc(shortGuide(g.title))}</a>`).join("");
  return pageList(ctx, {
    h1: w.h1, title: `${w.title} | 7 Day Gifts`, description: clip(`${w.blurb} ${list.length} hand-picked ideas.`, 158),
    canonical: `${SITE}/for/${w.slug}.html`, intro: w.blurb, list,
    crumbItems: [["/index.html", "Home"], ["/gift-gallery.html", "Gift Gallery"], [`/for/${w.slug}.html`, w.label]],
    extra: `<div class="more-block"><h2 class="more-title">Related gift guides</h2><div class="chip-row">${gl}</div></div>`,
  });
}

function pageGuide(ctx, g) {
  const map = new Map(ctx.products.map((p) => [p.id, p]));
  const bc = crumbs([["/index.html", "Home"], ["/guides/", "Gift Guides"], [`/guides/${g.slug}.html`, shortGuide(g.title)]]);
  const sections = g.sections.map((s) => {
    const list = s.products.map((id) => map.get(id)).filter(Boolean);
    if (!list.length) return "";
    return `<section class="guide-section"><h2>${esc(s.heading)}</h2><p>${esc(s.text)}</p>${grid(list)}</section>`;
  }).join("\n");
  const all = g.sections.flatMap((s) => s.products).map((id) => map.get(id)).filter(Boolean);
  const ld = { "@context": "https://schema.org", "@type": "Article", headline: g.title, description: g.description, url: `${SITE}/guides/${g.slug}.html`,
    image: all[0]?.image ? [all[0].image] : undefined, publisher: { "@type": "Organization", name: "7 Day Gifts", logo: { "@type": "ImageObject", url: SITE + "/logo.png" } }, author: { "@type": "Organization", name: "7 Day Gifts" } };
  const others = ctx.guides.filter((o) => o.slug !== g.slug).map((o) => `<a class="chip" href="/guides/${o.slug}.html">${esc(shortGuide(o.title))}</a>`).join("");
  return head({ title: `${g.metaTitle || g.title} | 7 Day Gifts`, description: g.description, canonical: `${SITE}/guides/${g.slug}.html`, type: "article", jsonld: [ld, bc.ld] }) + header("Gift Guides") + `
      <section class="section guide">
        ${bc.html}
        <h1 class="guide-title">${esc(g.title)}</h1>
        <div class="guide-intro">${g.intro.map((t) => `<p>${esc(t)}</p>`).join("")}</div>
        ${sections}
        ${g.tips?.length ? `<section class="guide-section callout"><h2>Tips</h2><ul>${g.tips.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></section>` : ""}
        <p class="guide-more">Want to see everything? <a href="/gift-gallery.html">Browse the full gift gallery</a>, or shop <a href="/for/her.html">gifts for her</a> and <a href="/for/him.html">gifts for him</a>.</p>
        <div class="more-block"><h2 class="more-title">More gift guides</h2><div class="chip-row">${others}</div></div>
      </section>` + footer(ctx);
}

function pageGuides(ctx) {
  const bc = crumbs([["/index.html", "Home"], ["/guides/", "Gift Guides"]]);
  return head({ title: "Gift Guides for Jewish Weddings, Anniversaries & Chanukah | 7 Day Gifts", description: "Practical gift guides for the seven days before the wedding, gifts for the chosson and the kallah, and Chanukah gifts for your spouse.", canonical: SITE + "/guides/", jsonld: [bc.ld] }) + header("Gift Guides") + `
      <section class="section">
        ${bc.html}
        ${sectionHeader("Gift Guides", "Short, practical guides to help you choose.", "h1")}
        <div class="guide-list">
          ${ctx.guides.map((g) => guideCard(ctx, g)).join("\n          ")}
        </div>
      </section>` + footer(ctx);
}

function page404(ctx) {
  return head({ title: "Page not found · 7 Day Gifts", description: "This page could not be found on 7 Day Gifts. Browse popular gift ideas instead.", canonical: SITE + "/404.html", noindex: true }) + header("") + `
      <section class="section">
        ${sectionHeader("We couldn't find that page", "The gift may have been removed. Here are some popular ideas instead.", "h1")}
        ${grid([...ctx.products].sort(byPop).slice(0, 6))}
      </section>` + footer(ctx);
}

// ---------- build ----------
async function writeOut(rel, content) {
  const file = path.join(OUT, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

async function main() {
  const { products, slugLock } = await loadProducts();
  if (products.length < MIN_PRODUCTS) throw new Error(`only ${products.length} active products found in the sheet; refusing to publish (expected at least ${MIN_PRODUCTS})`);
  const catIntros = await readJSON("data/categories.json", {});
  const guides = await readJSON("data/guides.json", []);
  const catMap = new Map();
  for (const p of products) if (p.category) { if (!catMap.has(p.category)) catMap.set(p.category, []); catMap.get(p.category).push(p); }
  // every product linking to its own shop also shows under "Small Shops" (the page is skipped while empty)
  for (const p of products) if (p.shop && p.category !== SMALL_SHOPS) { if (!catMap.has(SMALL_SHOPS)) catMap.set(SMALL_SHOPS, []); catMap.get(SMALL_SHOPS).push(p); }
  const guideFill = fillGuides(guides, products);
  const categories = [...catMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, list]) => ({ name, slug: slugify(name), products: list, indexable: list.length >= 2 || (name === SMALL_SHOPS && list.length >= 1) }));
  const ctx = { products, categories, guides, catIntros };

  // generated folders are rebuilt from scratch so removed products disappear
  for (const dir of ["gifts", "category", "for", "guides"]) await rm(path.join(OUT, dir), { recursive: true, force: true });

  const urls = [];
  const add = (rel, html, index = true) => { if (index) urls.push(rel); return writeOut(rel, html); };
  await add("index.html", pageHome(ctx)); urls[urls.length - 1] = "";
  await add("gift-gallery.html", pageGallery(ctx));
  await add("wishlist.html", pageWishlist(ctx), false);
  await add("404.html", page404(ctx), false);
  await add("guides/index.html", pageGuides(ctx)); urls[urls.length - 1] = "guides/";
  for (const g of guides) await add(`guides/${g.slug}.html`, pageGuide(ctx, g));
  for (const k of ["her", "him", "all"]) await add(`for/${WHO[k].slug}.html`, pageWho(ctx, k));
  for (const c of categories) await add(`category/${c.slug}.html`, pageCategory(ctx, c), c.indexable);
  for (const p of products) await add(`gifts/${p.slug}.html`, pageProduct(ctx, p));

  // product data for the wish list and gallery scripts (same shape the old app.js used)
  await writeOut("products.json", JSON.stringify(products.map((p) => ({ id: p.id, asin: p.asin, title: p.name, image: p.image, url: p.url, shop: p.shop, rel: p.rel, slug: p.slug, category: p.category, gender: p.gender, popularity: p.popularity, order: p.order, band: p.band, occasions: p.occasions }))));
  await writeOut("sitemap.xml", `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${SITE}/${u}</loc></url>`).join("\n")}\n</urlset>\n`);
  await writeOut("robots.txt", PREVIEW ? "User-agent: *\nAllow: /\n" : `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`);

  if (PREVIEW) {
    for (const f of ["style.css", "app.js", "logo.png", "favicon.ico", "hero.jpg"]) if (existsSync(path.join(ROOT, f))) await copyFile(path.join(ROOT, f), path.join(OUT, f));
  } else {
    // keep product URLs stable even if a title changes in the sheet later
    const sorted = Object.fromEntries(Object.entries(slugLock).sort(([a], [b]) => a.localeCompare(b)));
    await writeFile(path.join(ROOT, "data/slugs.json"), JSON.stringify(sorted, null, 2) + "\n");
  }
  console.log(`Gift guides: ${guideFill.added} gifts added from the Sheet's "guides" column.`);
  if (guideFill.unknown.length) console.log(`Unknown guide keys in the Sheet (ignored): ${guideFill.unknown.join(", ")}`);
  const shops = products.filter((p) => p.shop);
  if (shops.length) console.log(`Small Shops products: ${shops.map((p) => `${p.id} (${p.shop})`).join(", ")}`);
  const missing = products.filter((p) => !p.hasOwnDescription).map((p) => p.id);
  console.log(`Built ${products.length} product pages, ${categories.length} category pages, 3 who-it's-for pages, ${guides.length} guides, ${urls.length} URLs in sitemap -> ${OUT}`);
  if (missing.length) console.log(`Products using the automatic fallback description (add one in the sheet's site_description or data/descriptions.json): ${missing.join(", ")}`);
}

main().catch((e) => { console.error("Build failed:", e.message); process.exit(1); });
