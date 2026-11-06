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


// ---------- budget bands (typed by hand in the sheet's `price` column) ----------
// The band text is the source of truth; an exact price is never shown (Amazon's rules).
const BANDS = [
  { key: "u25", label: "Under $25", max: 25, slug: "under-25" },
  { key: "25-50", label: "$25–$50", max: 50, slug: "25-to-50" },
  { key: "50-100", label: "$50–$100", max: 100, slug: "50-to-100" },
  { key: "100-200", label: "$100–$200", max: 200, slug: "100-to-200" },
  { key: "200p", label: "$200+", max: Infinity, slug: "200-plus" },
];
function normalizeBand(value) {
  const v = String(value || "").trim().toLowerCase().replace(/\s+/g, "").replace(/[–—−]/g, "-").replace(/to/g, "-");
  if (!v) return null;
  const direct = { "under$25": "u25", "under25": "u25", "<$25": "u25", "$0-$25": "u25", "$25-$50": "25-50", "25-50": "25-50", "$50-$100": "50-100", "50-100": "50-100",
    "$100-$200": "100-200", "100-200": "100-200", "$200+": "200p", "200+": "200p", "$200plus": "200p", "over$200": "200p" };
  if (direct[v]) return BANDS.find((b) => b.key === direct[v]);
  const num = v.match(/^\$?(\d+(?:\.\d+)?)$/); // a bare number becomes its band, never shown as a price
  if (num) { const n = Number(num[1]); return BANDS.find((b) => n < b.max) || BANDS[BANDS.length - 1]; }
  // any other text he typed is shown as written (it has no budget filter bucket)
  const typed = String(value).trim().replace(/\s*[-–—]\s*/g, "–").replace(/\s+/g, " ");
  return /\d+\.\d\d/.test(typed) ? null : { key: "", label: typed };
}

// ---------- wedding-specific items never show as Chanukah gifts (Avrohom, Nov 4: "Chanukah is not a wedding") ----------
const WEDDING_ONLY_RX = /\bmr\.?\s*(?:&|and)\s*mrs\b|\bmr\b.*\bmrs\b|\bbride\b|\bgroom\b|\bnewly ?weds?\b|\bkallah\b|\bchosson\b|\bwedding (?:card|day|gift)\b/i;
function weddingSpecific(title, desc, category, cardLabel = "") {
  if (/^(anniversary cards|wedding cards)$/i.test(String(category || "").trim()) || /^(anniversary|wedding)$/i.test(cardLabel)) return true;
  return WEDDING_ONLY_RX.test(`${title || ""} ${desc || ""}`);
}
// ---------- occasions (comma list in the sheet's `occasions` column) ----------
const OCCASIONS = [
  { key: "wedding", label: "7 days before the wedding", short: "Before the wedding" },
  { key: "anniversary", label: "Anniversary", short: "Anniversary" },
  { key: "chanukah", label: "Chanukah", short: "Chanukah", seasonal: true },
  { key: "birthday", label: "Birthday", short: "Birthday" },
  { key: "just-because", label: "Just because", short: "Just because" },
];
function parseOccasions(value) {
  const out = new Set();
  for (const raw of String(value || "").toLowerCase().split(/[,;/|]+/)) {
    const v = raw.trim();
    if (!v) continue;
    if (/wedding|sheva|7 ?day|seven|chosson|kallah/.test(v)) out.add("wedding");
    else if (/anniv/.test(v)) out.add("anniversary");
    else if (/chanuk|hanuk|chanuc|hanuc/.test(v)) out.add("chanukah");
    else if (/birth/.test(v)) out.add("birthday");
    else if (/just|because|any/.test(v)) out.add("just-because");
  }
  return [...out];
}

// Cards and wrapping paper live in their own sections, not in the main gift mix.
const SIDE_CATEGORIES = ["cards", "gift wrap", "anniversary cards", "wrapping paper"];
const isCardOrWrap = (p) => /card|wrap/i.test(p.category);

// Amazon image URLs carry a size code; ask for a small copy for cards (faster on phones).
function sizedImage(url, px) {
  if (!/^https:\/\/m\.media-amazon\.com\/images\/I\//.test(url)) return url;
  if (/\._[^/]*_\.(jpe?g|png)$/i.test(url)) return url.replace(/\._[^/]*_\.(jpe?g|png)$/i, `._AC_SL${px}_.$1`);
  return url.replace(/\.(jpe?g|png)$/i, `._AC_SL${px}_.$1`);
}
// One short line for a card, from the start of the description.
function hookLine(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  const first = (t.match(/^.*?[.!?](\s|$)/) || [t])[0].trim();
  return clip(first, 90);
}

// ---------- Chanukah season ----------
// First night (evening) of Chanukah. The seasonal parts of the site show from 6 weeks
// before the first night through the 8th day, then hide again. Same table in the page script.
const CHANUKAH_STARTS = ["2026-12-04", "2027-12-24", "2028-12-12", "2029-12-01", "2030-12-20"];
const SEASON_DAYS_BEFORE = 42, SEASON_DAYS_AFTER = 8;
const ymdNY = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const addDays = (ymd, n) => { const d = new Date(ymd + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
function chanukahSeason(today = (args.includes("--date") ? args[args.indexOf("--date") + 1] : ymdNY())) {
  const start = CHANUKAH_STARTS.find((s) => today <= addDays(s, SEASON_DAYS_AFTER)) || CHANUKAH_STARTS[CHANUKAH_STARTS.length - 1];
  const on = today >= addDays(start, -SEASON_DAYS_BEFORE) && today <= addDays(start, SEASON_DAYS_AFTER);
  if (today > addDays(CHANUKAH_STARTS[CHANUKAH_STARTS.length - 1], -60)) console.log("Note: add more Chanukah dates to CHANUKAH_STARTS in build.mjs");
  const d = new Date(start + "T12:00:00Z");
  const pretty = d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
  return { on, start, year: start.slice(0, 4), pretty };
}
const SEASON_SCRIPT = `(function(){var D=${JSON.stringify(CHANUKAH_STARTS)},B=${SEASON_DAYS_BEFORE},A=${SEASON_DAYS_AFTER};function add(s,n){var d=new Date(s+"T12:00:00Z");d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10)}var t;try{t=new Intl.DateTimeFormat("en-CA",{timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date())}catch(e){t=new Date().toISOString().slice(0,10)}var q=location.search.match(/[?&]chanukah=(on|off)/);var s=null,on=false;for(var i=0;i<D.length;i++){if(t<=add(D[i],A)){s=D[i];break}}if(s)on=t>=add(s,-B);if(q)on=q[1]=="on";var h=document.documentElement;h.classList.toggle("is-chanukah",on);window.__chanukah={on:on,start:s,today:t};var m=document.querySelector('meta[name="robots"][data-seasonal]');if(m)m.setAttribute("content",on?"index, follow":"noindex, follow")})();`;

// ---------- categories (9 main ones; older names in the Sheet still map to them) ----------
const CATEGORY_MAP = {
  "anniversary cards": "Cards", "wedding cards": "Cards", "funny cards": "Cards", "nice cards": "Cards", "just because cards": "Cards", "card": "Cards",
  "wrapping paper": "Gift Wrap", "wrap": "Gift Wrap", "gift wrap & tags": "Gift Wrap",
  "writing": "Accessories",
  "home": "Home & Kitchen", "kitchen": "Home & Kitchen", "food": "Home & Kitchen", "home and kitchen": "Home & Kitchen",
  "guitar": "Hobbies & Games", "pickleball": "Hobbies & Games", "games": "Hobbies & Games", "funny": "Hobbies & Games",
  "travel": "Travel & Outdoors", "outdoors": "Travel & Outdoors",
  "cosmetics": "Beauty & Fragrance", "cologne & perfume": "Beauty & Fragrance", "fragrance": "Beauty & Fragrance", "beauty": "Beauty & Fragrance",
};
const LABEL_FROM_OLD = { "anniversary cards": "Anniversary", "wedding cards": "Wedding", "funny cards": "Funny", "nice cards": "Sweet", "just because cards": "Just Because" };
const CARD_LABELS = ["Funny", "Sweet", "Anniversary", "Wedding", "Just Because"];
const normalizeCategory = (raw) => { const k = String(raw || "").trim().replace(/\s+/g, " "); return CATEGORY_MAP[k.toLowerCase()] || k; };
function normalizeCardLabel(raw, oldCategory) {
  const s = String(raw || "").trim().replace(/\s+/g, " ");
  return CARD_LABELS.find((l) => l.toLowerCase() === s.toLowerCase()) || s || LABEL_FROM_OLD[String(oldCategory || "").trim().toLowerCase()] || "";
}
// old category pages and where they live now (301s in vercel.json; the build also leaves a small redirect page)
const OLD_CATEGORY_SLUGS = {
  "anniversary-cards": "cards", "wedding-cards": "cards", "funny-cards": "cards", "nice-cards": "cards", "just-because-cards": "cards",
  "wrapping-paper": "gift-wrap", "writing": "accessories", "home": "home-and-kitchen", "kitchen": "home-and-kitchen", "food": "home-and-kitchen",
  "guitar": "hobbies-and-games", "pickleball": "hobbies-and-games", "games": "hobbies-and-games", "funny": "hobbies-and-games",
  "travel": "travel-and-outdoors", "outdoors": "travel-and-outdoors", "cosmetics": "beauty-and-fragrance", "cologne-and-perfume": "beauty-and-fragrance",
};
const redirectPage = (to) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>This page moved · 7 Day Gifts</title><meta name="robots" content="noindex, follow"><link rel="canonical" href="${SITE}${to}"><meta http-equiv="refresh" content="0; url=${to}"><script>location.replace(${JSON.stringify(to)})</script></head><body><p>This page moved: <a href="${to}">${to}</a></p></body></html>\n`;
async function writeCategoryRedirects(categories) {
  const live = new Set(categories.map((c) => c.slug));
  let n = 0;
  for (const [from, to] of Object.entries(OLD_CATEGORY_SLUGS)) {
    if (live.has(from) || !live.has(to)) continue;
    await writeOut(`category/${from}.html`, redirectPage(`/category/${to}.html`)); n++;
  }
  return n;
}
const cardLabelBadge = (p) => (p.cardLabel ? `<span class="card-label">${esc(p.cardLabel)}</span>` : "");

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
    const rawCategory = String(o.categories ?? o["categories "] ?? "").trim();
    const category = normalizeCategory(rawCategory);
    const cardLabel = /card/i.test(category) ? normalizeCardLabel(o.card_label, rawCategory) : "";
    const image = cleanImage(o.photo_url);
    const band = normalizeBand(o.price);
    products.push({
      id, asin, title, name, slug, url, shop, rel, cardLabel,
      guides: parseGuideTags(o.guides),
      image, thumb: sizedImage(image, 400), big: sizedImage(image, 800),
      band: band ? band.label : "", bandKey: band ? band.key : "",
      occasions: weddingSpecific(title, o.site_description, category, cardLabel) ? parseOccasions(o.occasions).filter((k) => k !== "chanukah") : parseOccasions(o.occasions),
      weddingOnly: weddingSpecific(title, o.site_description, category, cardLabel),
      side: SIDE_CATEGORIES.includes(category.toLowerCase()),
      category,
      gender: normalizeGender(o.who_is_it_for),
      popularity: Number(o.click_count) || 0,
      order: index,
      description: String(o.site_description || "").trim() || descriptions[id] ||
        `${name} — a ${category ? category.toLowerCase() + " " : ""}gift idea ${WHO[normalizeGender(o.who_is_it_for)].phrase === "either of you" ? "for either of you" : "for " + WHO[normalizeGender(o.who_is_it_for)].phrase}, hand-picked by 7 Day Gifts.`,
      hasOwnDescription: Boolean(String(o.site_description || "").trim() || descriptions[id]),
    });
    const last = products[products.length - 1];
    last.hook = last.hasOwnDescription ? hookLine(last.description) : "";
  });
  return { products, slugLock };
}

// ---------- page pieces ----------
const nav = [
  ["/index.html", "Home"], ["/gift-gallery.html", "All Gifts"], ["/gift-finder.html", "Gift Finder"], ["/guides/", "Gift Guides"],
  ["/wishlist.html", "Wish List"], ["/contact.html", "Contact"],
];

const ICON = {
  menorah: `<svg class="menorah" viewBox="0 0 120 64" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M60 22v34M44 60h32"/><path d="M60 40c-30 0-36-8-36-18M60 40c30 0 36-8 36-18M60 36c-20 0-26-6-26-14M60 36c20 0 26-6 26-14M60 32c-12 0-16-4-16-10M60 32c12 0 16-4 16-10M60 28c-5 0-6-2-6-6M60 28c5 0 6-2 6-6"/></g><g fill="currentColor">${[24,34,44,54,66,76,86,96].map((x) => `<rect x="${x - 1.6}" y="15" width="3.2" height="7" rx="1"/>`).join("")}<rect x="58.2" y="10" width="3.6" height="12" rx="1"/></g><g class="flames">${[24,34,44,54,66,76,86,96].map((x) => `<path d="M${x} 7c2.2 2.6 2.4 4.6 0 6.6c-2.4-2-2.2-4 0-6.6z"/>`).join("")}<path d="M60 1.5c2.4 2.8 2.6 5 0 7.2c-2.6-2.2-2.4-4.4 0-7.2z"/></g></svg>`,
  dreidel: `<svg class="dreidel" viewBox="0 0 24 32" aria-hidden="true" focusable="false"><path d="M11 1h2v6h-2z M5 7h14v12l-7 12l-7-12z" fill="currentColor"/><path d="M9.2 12.5h4.6v5.2" fill="none" stroke="#1d3768" stroke-width="1.6"/></svg>`,
  star: `<svg class="star6" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 2l3 5.2h6l-3 5l3 5h-6L12 22l-3-4.8H3l3-5l-3-5h6z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`,
  heart: `<svg class="heart-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>`,
  arrow: `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M5 12h13M13 6l6 6l-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
};

function head({ title, description, canonical, image, type = "website", noindex = false, seasonal = false, jsonld = [], ctx }) {
  let robots = "";
  if (PREVIEW) robots = `<meta name="robots" content="noindex, nofollow" />`;
  else if (seasonal) robots = `<meta name="robots" content="noindex, follow" />`; // Chanukah pages: direct link only (Avrohom, Nov 4)
  else if (noindex) robots = `<meta name="robots" content="noindex, follow" />`;
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
<html lang="en" class="${ctx?.season?.on ? "is-chanukah" : ""}">
<head>
  <meta charset="UTF-8" />
  <title>${esc(title)}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="description" content="${esc(description)}" />
  <meta name="theme-color" content="#1F3358" />
  ${robots}${PREVIEW ? '\n  <meta name="7dg-preview" content="1" />' : ""}
  <script>${seasonal ? SEASON_SCRIPT : "window.__chanukah={on:false};"}</script>
  <link rel="canonical" href="${esc(canonical)}" />
  <meta property="og:site_name" content="7 Day Gifts" />
  <meta property="og:type" content="${type}" />
  <meta property="og:title" content="${esc(title)}" />
  <meta property="og:description" content="${esc(description)}" />
  <meta property="og:url" content="${esc(canonical)}" />
  <meta property="og:image" content="${esc(img)}" />
  <meta name="twitter:card" content="summary_large_image" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Playfair+Display:ital,wght@0,500;0,600;0,700;1,500&display=swap" />
  <link rel="stylesheet" href="/style.css?v=${ASSET_V}" />
  <link rel="icon" href="/favicon.ico" sizes="48x48" />
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />
  <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png" />
  <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
  <link rel="manifest" href="/site.webmanifest" />
  <meta name="theme-color" content="#ffffff" />${jsonld.map((j) => `\n  <script type="application/ld+json">${JSON.stringify(j).replace(/</g, "\\u003c")}</script>`).join("")}${ga}
</head>`;
}
const ASSET_V = "17";

function chanukahBand(ctx) {
  return ""; // Chanukah is not promoted on the site (Avrohom, Nov 4); the pages stay reachable by direct link

  const s = ctx.season;
  const pattern = [ICON.dreidel, ICON.star, ICON.dreidel, ICON.star].join("");
  return `<a class="chanukah-band seasonal" href="/chanukah/" aria-label="Chanukah gifts">
      <span class="cb-deco cb-left" aria-hidden="true">${pattern}</span>
      <span class="cb-center">${ICON.menorah}<span class="cb-text"><span class="cb-strong">Happy Chanukah</span><span class="cb-sub"> · Gifts for all 8 nights</span></span></span>
      <span class="cb-deco cb-right" aria-hidden="true">${pattern}</span>
    </a>`;
}

function header(active, ctx) {
  const links = nav.map(([href, label, cls = ""]) => `<a href="${href}" class="nav-link${label === active ? " active" : ""}${cls ? " " + cls : ""}">${label}</a>`).join("\n          ");
  const mlinks = nav.map(([href, label, cls = ""]) => `<a href="${href}" class="mobile-link${label === active ? " active" : ""}${cls ? " " + cls : ""}"${label === active ? ' aria-current="page"' : ""}><span>${label}</span><span class="mobile-link-chev" aria-hidden="true">›</span></a>`).join("\n        ");
  return `
<body>
  <a class="skip-link" href="#main">Skip to content</a>
  <div class="page">
    ${chanukahBand(ctx)}
    <header class="site-header">
      <div class="header-inner">
        <a href="/index.html" class="logo-wrap" aria-label="7 Day Gifts home">
          <img src="/logo-sm.png" class="logo-img" alt="" width="44" height="44" />
          <span class="logo-text">7 Day Gifts</span>
        </a>
        <nav class="main-nav" aria-label="Primary">
          ${links}
        </nav>
        <div class="header-actions">
          <a class="header-heart" href="/wishlist.html" aria-label="Your wish list">${ICON.heart}</a>
          <button id="menuToggle" class="menu-toggle" type="button" aria-label="Open menu" aria-controls="mobileMenu" aria-expanded="false"><span></span><span></span><span></span></button>
        </div>
      </div>
    </header>
    <div id="menuOverlay" class="menu-overlay" hidden></div>
    <aside id="mobileMenu" class="mobile-menu" aria-label="Menu" aria-hidden="true">
      <div class="mobile-menu-head">
        <span class="mobile-menu-title">Menu</span>
        <button id="menuClose" class="menu-close" type="button" aria-label="Close menu">×</button>
      </div>
      <nav class="mobile-menu-links">
        ${mlinks}
      </nav>
    </aside>
    <p class="disclosure">As an Amazon Associate we earn from qualifying purchases.</p>
    <main class="main-content" id="main">`;
}

function footer(ctx) {
  const year = new Date().getFullYear();
  const cats = ctx.categories.filter((c) => c.indexable).map((c) => `<a href="/category/${c.slug}.html">${esc(c.name)}</a>`).join("");
  const guides = ctx.guides.map((g) => `<a href="/guides/${g.slug}.html">${esc(shortGuide(g.title))}</a>`).join("");
  return `
    </main>
    <footer class="site-footer">
      <div class="footer-top">
        <div class="footer-brand">
          <a href="/index.html" class="logo-wrap footer-logo"><img src="/logo-sm.png" alt="" width="40" height="40" loading="lazy" /><span class="logo-text">7 Day Gifts</span></a>
          <p>Thoughtful gift ideas for the seven days before the wedding, and every anniversary after.</p>
          <p class="footer-contact"><a href="mailto:info@7daygifts.com">info@7daygifts.com</a><br /><a href="tel:14753294438">475-329-4438</a></p>
        </div>
        <div class="footer-col"><div class="footer-heading">Shop</div><a href="/gift-gallery.html">All gifts</a><a href="/gift-finder.html">Gift finder</a><a href="/for/her.html">Gifts for her</a><a href="/for/him.html">Gifts for him</a><a href="/for/couples.html">For either of you</a><a href="/budget/under-50.html">Under $50</a><a href="/contact.html">Contact us</a></div>
        <div class="footer-col"><div class="footer-heading">Gift guides</div>${guides}</div>
        <div class="footer-col footer-col-cats"><div class="footer-heading">Categories</div><div class="footer-cats">${cats}</div></div>
      </div>
      <div class="footer-bottom">
        <span>© ${year} 7DayGifts.com</span>
        <span>As an Amazon Associate we earn from qualifying purchases. Prices and availability are set by Amazon (or by the shop, for Small Shops gifts) and can change.</span>
      </div>
    </footer>
  </div>
  <script src="/app.js?v=${ASSET_V}"></script>
  <script src="/reviews.js?v=${ASSET_V}" defer></script>
</body>
</html>
`;
}
const shortGuide = (t) => t.split(":")[0];
function guideCard(ctx, g) {
  const ids = [...new Set(g.sections.flatMap((s) => s.products))];
  const pics = ids.map((id) => ctx.products.find((p) => p.id === id)).filter((p) => p && p.image).slice(0, 4);
  const strip = pics.length ? `<span class="guide-card-photos">${pics.map((p) => `<img src="${esc(sizedImage(p.image, 200))}" alt="" loading="lazy" decoding="async" width="160" height="160" onerror="this.style.visibility='hidden'" />`).join("")}</span>` : "";
  return `<a class="guide-card" href="/guides/${g.slug}.html">${strip}<span class="guide-card-title">${esc(g.title)}</span><span class="guide-card-text">${esc(g.description)}</span><span class="guide-card-link">Read the guide${ICON.arrow}</span></a>`;
}

function card(p, { headingTag = "h3", eager = false } = {}) {
  const img = p.image
    ? `<img class="product-image" src="${esc(p.thumb || p.image)}" alt="${esc(p.name)}" ${eager ? "" : 'loading="lazy" '}decoding="async" width="400" height="400" onerror="this.style.display='none';this.parentElement.classList.add('image-missing');" />`
    : "";
  return `<article class="product-card" data-id="${esc(p.id)}" data-gender="${p.gender}" data-category="${esc(p.category)}" data-pop="${p.popularity}" data-order="${p.order}" data-band="${p.bandKey}" data-side="${p.side ? 1 : 0}" data-shop="${p.shop ? 1 : 0}">
  <button type="button" class="heart" data-id="${esc(p.id)}" aria-label="Save ${esc(p.name)} to your wish list">${ICON.heart}</button>
  <a class="product-link" href="/gifts/${p.slug}.html">
    <div class="product-image-wrap${p.image ? "" : " image-missing"}">${img}<div class="image-fallback">Image coming soon</div></div>
    <div class="product-text">
      <${headingTag} class="product-title">${esc(p.name)}</${headingTag}>
      ${p.hook ? `<p class="product-hook">${esc(p.hook)}</p>` : ""}
    </div>
  </a>
  <div class="product-card-body">
    ${p.band || p.cardLabel ? `<span class="chips">${p.band ? `<span class="band">${esc(p.band)}</span>` : ""}${cardLabelBadge(p)}</span>` : ""}
    <a class="btn-pill btn-amazon ${linkClass(p)}" href="${esc(p.url)}" target="_blank" rel="${p.rel}" data-id="${esc(p.id)}">${esc(buyLabel(p))}</a>
  </div>
</article>`;
}
const grid = (list, id = "") => `<div class="product-grid"${id ? ` id="${id}"` : ""}>\n${list.map((p) => card(p)).join("\n")}\n</div>`;
const row = (list, id = "") => `<div class="scroller" data-scroller><button type="button" class="scroll-btn prev" aria-label="Scroll back">‹</button><div class="product-row"${id ? ` id="${id}"` : ""}>\n${list.map((p) => card(p)).join("\n")}\n</div><button type="button" class="scroll-btn next" aria-label="Scroll forward">›</button></div>`;
const isCWName = (n) => /card|wrap/i.test(n);
const byPop = (a, b) => b.popularity - a.popularity || a.order - b.order;
// Wallet tracker cards sit right after the wallets they go in (category pages, and first in "You might also like" on wallet pages).
const isWalletTracker = (p) => /wallet tracker|tracker card/i.test(`${p.name} ${p.title}`);
const isWallet = (p) => /\bwallets?\b/i.test(p.name) && !isWalletTracker(p);
function keepWithWallets(list) {
  const trackers = list.filter(isWalletTracker);
  if (!trackers.length) return list;
  const rest = list.filter((p) => !isWalletTracker(p));
  let last = -1;
  rest.forEach((p, i) => { if (isWallet(p)) last = i; });
  if (last < 0) return list;
  rest.splice(last + 1, 0, ...trackers);
  return rest;
}

function crumbs(items) {
  const html = `<nav class="breadcrumbs" aria-label="Breadcrumb">${items.map(([href, label], i) =>
    i === items.length - 1 ? `<span aria-current="page">${esc(label)}</span>` : `<a href="${href}">${esc(label)}</a><span class="sep" aria-hidden="true">›</span>`).join("")}</nav>`;
  const ld = { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: items.map(([href, label], i) => ({ "@type": "ListItem", position: i + 1, name: label, item: SITE + href })) };
  return { html, ld };
}

function sectionHeader(h, sub, tag = "h2", { link, eyebrow } = {}) {
  return `<div class="section-header"><div>${eyebrow ? `<p class="eyebrow">${eyebrow}</p>` : ""}<${tag} class="section-title">${h}</${tag}>${sub ? `<p class="section-subtitle">${sub}</p>` : ""}</div>${link ? `<a class="see-all" href="${link[0]}">${link[1]}${ICON.arrow}</a>` : ""}</div>`;
}

const emailBlock = `
      <section class="section">
        <div class="email-capture-card">
          <div class="email-copy">
            <p class="eyebrow">The 7 Day Gifts list</p>
            <h2 class="email-capture-title">Never get stuck on a gift again</h2>
            <p class="email-capture-text">New finds every week, ideas for the week before the wedding, and a friendly nudge before the big dates. No spam, ever.</p>
          </div>
          <form id="emailForm" class="email-form">
            <label class="email-label" for="emailInput">Email address</label>
            <input type="email" id="emailInput" name="email" class="email-input" placeholder="you@example.com" autocomplete="email" required />
            <label class="email-label" for="weddingDate">When is your wedding? (optional)</label>
            <input type="date" id="weddingDate" name="weddingDate" class="email-input" />
            <input type="text" id="companyField" name="company" class="hp-field" tabindex="-1" autocomplete="off" aria-hidden="true" />
            <button type="submit" class="btn-pill btn-gold email-submit">Join the list</button>
          </form>
          <p id="emailSuccess" class="email-message hidden">You're in — we saved your info.</p>
          <p id="emailError" class="email-message email-error hidden">Something went wrong. Please try again.</p>
          <p id="emailPreview" class="email-message hidden">This is a preview copy of the site, so sign-up is switched off here.</p>
        </div>
      </section>`;

function finderBlock(ctx, { tag = "h2", id = "finder" } = {}) {
  const pills = (name, items) => items.map(([v, label, cls = ""]) => `<button type="button" class="pill${cls ? " " + cls : ""}" data-${name}="${v}" aria-pressed="false">${label}</button>`).join("");
  return `<section class="section finder" id="${id}">
        <div class="finder-card">
          ${sectionHeader("Find the perfect gift in 3 taps", "Tell us who it’s for, the occasion and your budget. We’ll do the rest.", tag, { eyebrow: "Gift finder" })}
          <div class="finder-steps">
            <div class="finder-step"><div class="step-label"><span class="step-num">1</span>Who’s it for?</div><div class="pill-row" data-step="who">${pills("who", [["her", "Her"], ["him", "Him"], ["both", "Both of us"]])}</div></div>
            <div class="finder-step"><div class="step-label"><span class="step-num">2</span>What’s the occasion?</div><div class="pill-row" data-step="occasion">${pills("occasion", OCCASIONS.filter((o) => o.key !== "chanukah").map((o) => [o.key, o.label, o.seasonal ? "seasonal" : ""]))}</div></div>
            <div class="finder-step"><div class="step-label"><span class="step-num">3</span>Your budget</div><div class="pill-row" data-step="budget">${pills("budget", [...BANDS.map((b) => [b.key, b.label]), ["any", "Any budget"]])}</div></div>
          </div>
          <div class="finder-status" id="finderStatus" aria-live="polite">Tap one in each row — results show up right here.</div>
          <div class="product-grid finder-results" id="finderResults"></div>
          <div class="finder-actions hidden" id="finderActions"><button type="button" class="btn-pill btn-ghost" id="finderMore">Show more</button><button type="button" class="btn-link" id="finderReset">Start over</button></div>
        </div>
      </section>`;
}

const DAY_LINES = {
  1: "Open the week with a keepsake that says it all.",
  2: "Slippers, loungewear, the comfy stuff they’ll live in.",
  3: "A little thing they’ll use daily, and think of you.",
  4: "Pieces for the home you’re about to build together.",
  5: "For sheva brachos, the honeymoon and every trip after.",
  6: "Lighten the countdown with something that makes them smile.",
  7: "Save the showstopper for the last day.",
};
function daysBlock(ctx) {
  const g = ctx.guides.find((x) => x.slug === "7-day-gift-ideas-before-the-wedding");
  if (!g) return "";
  const map = new Map(ctx.products.map((p) => [p.id, p]));
  const cards = g.sections.map((s) => {
    const m = s.heading.match(/^Day\s*(\d)\s*[:\-–]\s*(.*)$/i);
    if (!m) return "";
    const list = s.products.map((id) => map.get(id)).filter(Boolean).slice(0, 3);
    return `<a class="day-card" href="/guides/${g.slug}.html#day-${m[1]}">
          <span class="day-num"><span>Day</span>${m[1]}</span>
          <span class="day-title">${esc(m[2])}</span>
          <span class="day-text">${esc(DAY_LINES[m[1]] || s.text)}</span>
          <span class="day-thumbs">${list.map((p) => `<img src="${esc(sizedImage(p.image, 200))}" alt="" loading="lazy" decoding="async" width="64" height="64" />`).join("")}</span>
          <span class="day-link">See the gifts${ICON.arrow}</span>
        </a>`;
  }).join("\n        ");
  return `<section class="section days">
        ${sectionHeader("Day 1 to Day 7", "One idea for each day of the week before the wedding, so every morning has a little surprise.", "h2", { eyebrow: "The week before the wedding", link: [`/guides/${g.slug}.html`, "The full plan"] })}
        <div class="day-grid">
        ${cards}
        </div>
      </section>`;
}

function chanukahBanner(ctx) {
  return "";

  const s = ctx.season;
  return `<section class="section seasonal">
        <a class="chanukah-banner" href="/chanukah/">
          <span class="chb-glow" aria-hidden="true"></span>
          <span class="chb-art" aria-hidden="true">${ICON.menorah}</span>
          <span class="chb-copy">
            <span class="eyebrow eyebrow-light">Chanukah ${s.year} · begins ${esc(s.pretty)} at sundown</span>
            <span class="chb-title">Eight nights. Eight little surprises.</span>
            <span class="chb-text">Our favorite Chanukah gifts for your wife, your husband and the whole family, sorted by budget.</span>
            <span class="chb-cta"><span class="btn-pill btn-gold">Shop Chanukah gifts${ICON.arrow}</span><span class="chb-count" data-chanukah-countdown></span></span>
          </span>
        </a>
      </section>`;
}

function categoryTiles(ctx) {
  const cats = [...ctx.categories].sort((a, b) => (isCWName(a.name) - isCWName(b.name)) || b.products.length - a.products.length || a.name.localeCompare(b.name));
  return `<div class="tile-grid">
          ${cats.map((c) => {
            const top = [...c.products].sort(byPop).find((p) => p.image);
            return `<a class="cat-tile" href="/category/${c.slug}.html"><span class="cat-img">${top ? `<img src="${esc(sizedImage(top.image, 200))}" alt="" loading="lazy" decoding="async" width="72" height="72" />` : ""}</span><span class="cat-name">${esc(c.name === "Home" ? "For the Home" : c.name)}</span><span class="cat-count">${c.products.length} ${c.products.length === 1 ? "gift" : "gifts"}</span></a>`;
          }).join("\n          ")}
        </div>`;
}

// ---------- homepage first screen: real gifts, moving gently ----------
function reelCard(p, { isNew = false, eager = false } = {}) {
  return `<a class="reel-card" href="/gifts/${p.slug}.html">
            <span class="reel-img"><img src="${esc(sizedImage(p.image, 400))}" alt="" ${eager ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async" width="300" height="300" onerror="this.closest('.reel-card').remove()" />${isNew ? '<span class="reel-new">New</span>' : ""}${p.band ? `<span class="reel-band">${esc(p.band)}</span>` : ""}</span>
            <span class="reel-name">${esc(p.name)}</span>
          </a>`;
}
// Photo cards framing the headline: left/top group and right/bottom group.
function collageCard(p, i, { isNew = false } = {}) {
  return `<a class="hc hc-${i}" href="/gifts/${p.slug}.html" aria-label="${esc(p.name)}"><img src="${esc(sizedImage(p.image, 400))}" alt="" ${i < 4 ? 'fetchpriority="high"' : ""} decoding="async" width="200" height="200" onerror="this.closest('.hc').remove()" />${isNew ? '<span class="hc-new">New</span>' : ""}</a>`;
}
function heroBlock(ctx, n) {
  const pool = ctx.mainGifts.filter((p) => p.image && !isCardOrWrap(p) && !p.side);
  const loved = [...pool].sort(byPop).slice(0, 6);
  const newest = [...pool].filter((p) => !loved.includes(p)).sort((a, b) => b.order - a.order).slice(0, 4);
  // interleave so each side gets loved + new gifts
  const picks = [loved[0], newest[0], loved[1], loved[2], newest[1], loved[3], newest[2], loved[4], loved[5], newest[3]].filter(Boolean);
  const isNewPick = (p) => newest.includes(p);
  const sideA = picks.slice(0, 5), sideB = picks.slice(5, 10);
  const used = new Set(picks);
  const rest = pool.filter((p) => !used.has(p));
  const top = [...rest].sort(byPop).slice(0, 8);
  const fresh = [...rest].filter((p) => !top.includes(p)).sort((a, b) => b.order - a.order).slice(0, 8);
  return `      <section class="hero hero-gifts hero-collage">
        <span class="hero-glow hero-glow-1" aria-hidden="true"></span><span class="hero-glow hero-glow-2" aria-hidden="true"></span>
        <div class="hero-stage">
          <div class="hc-group hc-a" aria-label="Most-loved gifts">
            ${sideA.map((p, i) => collageCard(p, i + 1, { isNew: isNewPick(p) })).join("\n            ")}
          </div>
          <div class="hero-inner hero-center">
            <div class="hero-chips">
              <a class="hchip hchip-new" href="/gift-gallery.html?sort=recent"><span class="hchip-dot" aria-hidden="true"></span>New this week</a>
            </div>
            <h1 class="hero-title">Seven days.<br /><em>Seven thoughtful gifts.</em></h1>
            <p class="hero-subtitle">Hand-picked gifts for the chosson, the kallah, and every anniversary after.</p>
            <div class="hero-actions">
              <a class="btn-pill btn-primary btn-big" href="/gift-gallery.html">Browse all ${n} gifts${ICON.arrow}</a>
              <a class="btn-pill btn-light btn-big" href="#finder">Find a gift in 3 taps</a>
            </div>
          </div>
          <div class="hc-group hc-b" aria-label="More gift ideas">
            ${sideB.map((p, i) => collageCard(p, i + 1, { isNew: isNewPick(p) })).join("\n            ")}
          </div>
        </div>
        <div class="gift-reel" data-reel data-speed="0.32" aria-label="Most-loved gifts">
          <div class="reel-track">
          ${top.map((p) => reelCard(p)).join("\n          ")}
          </div>
        </div>
        ${fresh.length >= 4 ? `<div class="gift-reel gift-reel-sm" data-reel data-speed="0.24" data-dir="-1" aria-label="New gifts">
          <div class="reel-track">
          ${fresh.map((p) => reelCard(p, { isNew: true })).join("\n          ")}
          </div>
        </div>` : ""}
      </section>
`;
}

// ---------- pages ----------
function pageHome(ctx) {
  const { products, mainGifts } = ctx;
  const top = [...mainGifts].filter((p) => !isCardOrWrap(p)).sort(byPop).slice(0, 7);
  const forHer = mainGifts.filter((p) => p.gender === "her" && !isCardOrWrap(p)).sort(byPop).slice(0, 12);
  const forHim = mainGifts.filter((p) => p.gender === "him" && !isCardOrWrap(p)).sort(byPop).slice(0, 12);
  const under50 = mainGifts.filter((p) => (p.bandKey === "u25" || p.bandKey === "25-50") && !isCardOrWrap(p)).sort(byPop).slice(0, 12);
  const annCat = ctx.categories.find((c) => c.name.toLowerCase() === "cards");
  const cards = annCat ? [...annCat.products].sort(byPop) : [];
  const n = mainGifts.length;
  const ld = [{ "@context": "https://schema.org", "@type": "WebSite", name: "7 Day Gifts", url: SITE + "/" },
    { "@context": "https://schema.org", "@type": "Organization", name: "7 Day Gifts", url: SITE + "/", logo: SITE + "/logo.png", email: "info@7daygifts.com", telephone: "+1-475-329-4438" }];
  const rowSection = (title, sub, list, link, extraClass = "") => list.length ? `
      <section class="section collection ${extraClass}">
        ${sectionHeader(title, sub, "h2", { link })}
        ${row(list)}
      </section>` : "";
  return head({ ctx, title: "7 Day Gifts · Gift Ideas for the 7 Days Before the Wedding & Every Anniversary", description: `${n} hand-picked gift ideas for the seven days before a Jewish wedding, for the chosson and the kallah, plus anniversary gifts for your spouse.`, canonical: SITE + "/", jsonld: ld }) + header("Home", ctx) + `
${heroBlock(ctx, n)}
      <ul class="trust-strip" aria-label="Why 7 Day Gifts">
        <li><span class="trust-ico" aria-hidden="true">✓</span>Hand-picked</li>
        <li><span class="trust-ico" aria-hidden="true">★</span>Top-rated picks</li>
        <li><span class="trust-ico" aria-hidden="true">✦</span>New gifts weekly</li>
      </ul>
      <section class="section catalog">
        <div class="catalog-head">
          <div>
            <p class="eyebrow">The full collection</p>
            <h2 class="section-title">${n} gifts, ${ctx.categories.length} categories</h2>
            <p class="section-subtitle">Everything we love, in one place. Filter by who it’s for, budget and category.</p>
          </div>
          <a class="btn-pill btn-primary btn-big browse-all" href="/gift-gallery.html">Browse all ${n} gifts${ICON.arrow}</a>
        </div>
        ${categoryTiles(ctx)}
      </section>
${rowSection(`<span class="badge-trending">Trending</span> The 7 most-loved gifts`, "What couples are choosing most this week.", top, ["/gift-gallery.html", `See all ${n}`], "trending")}
${finderBlock(ctx)}
${daysBlock(ctx)}
${rowSection("For Her", "For the kallah, or your wife.", forHer, ["/for/her.html", "See all"])}
${rowSection("For Him", "For the chosson, or your husband.", forHim, ["/for/him.html", "See all"])}
${rowSection("Under $50", "Thoughtful doesn’t have to mean expensive.", under50, ["/budget/under-50.html", "See all"])}
${annCat ? rowSection("Cards", "Funny, sweet, anniversary and just-because cards. Always clean, to go with the gift.", cards, [`/category/${annCat.slug}.html`, "See all"]) : ""}
      <section class="section">
        ${sectionHeader("Gift guides", "Short, practical guides to help you plan.", "h2", { link: ["/guides/", "All guides"] })}
        <div class="guide-list">
          ${ctx.guides.map((g) => guideCard(ctx, g)).join("\n          ")}
        </div>
      </section>

      <section class="section">
        <div class="mission">
          <p class="eyebrow">Why we started</p>
          <p class="mission-text">The week before a wedding goes by in a blur. We built 7 Day Gifts so every one of those days can carry a small, meaningful “thinking of you,” without the stress of figuring out what to buy.</p>
        </div>
      </section>
${emailBlock}` + footer(ctx);
}

function galleryFilters(ctx) {
  const opts = ctx.categories.map((c) => `<option value="${esc(c.name)}">${esc(c.name)} (${c.products.length})</option>`).join("\n              ");
  return `<div class="filters">
          <div class="filter-group">
            <div class="filter-label">Who is it for?</div>
            <div class="pill-row" id="genderPills" aria-label="Who is it for">
              <button type="button" class="pill active" data-gender="all">Everyone</button>
              <button type="button" class="pill" data-gender="her">For Her</button>
              <button type="button" class="pill" data-gender="him">For Him</button>
            </div>
          </div>
          <div class="filter-group">
            <div class="filter-label">Budget</div>
            <div class="pill-row" id="budgetPills" aria-label="Budget">
              <button type="button" class="pill active" data-budget="all">Any</button>
              ${BANDS.map((b) => `<button type="button" class="pill" data-budget="${b.key}">${b.label}</button>`).join("\n              ")}
            </div>
          </div>
          <div class="filter-row">
            <div class="filter-group">
              <label class="filter-label" for="categoryFilter">Category</label>
              <select id="categoryFilter" class="sort-select" aria-label="Category filter">
                <option value="all">All categories</option>
                ${opts}
              </select>
            </div>
            <div class="filter-group">
              <div class="filter-label">Sort</div>
              <div class="sort-row" aria-label="Sort">
                <button type="button" class="sort-btn active" data-sort="popular">Most popular</button>
                <button type="button" class="sort-btn" data-sort="recent">Newest</button>
              </div>
            </div>
          </div>
        </div>`;
}

function pageGallery(ctx) {
  const list = [...ctx.products].sort(byPop);
  const n = ctx.mainGifts.length;
  const ld = { "@context": "https://schema.org", "@type": "CollectionPage", name: "All Gifts", url: SITE + "/gift-gallery.html",
    mainEntity: { "@type": "ItemList", numberOfItems: list.length, itemListElement: list.map((p, i) => ({ "@type": "ListItem", position: i + 1, url: `${SITE}/gifts/${p.slug}.html`, name: p.name })) } };
  const side = ctx.categories.filter((c) => SIDE_CATEGORIES.includes(c.name.toLowerCase()));
  return head({ ctx, title: "All Gift Ideas: Chosson, Kallah & Anniversary Gifts · 7 Day Gifts", description: `Browse all ${n} gift ideas for the chosson, the kallah and your spouse. Filter by who it's for, budget and category.`, canonical: SITE + "/gift-gallery.html", jsonld: [ld] }) + header("All Gifts", ctx) + `
      <section class="section">
        ${sectionHeader(`All ${n} gifts`, "Filter by who it’s for, budget and category.", "h1", { eyebrow: "The full collection" })}
        <p class="finder-nudge">Not sure where to start? <a href="/gift-finder.html">Try the 3-tap gift finder</a>.</p>
        ${galleryFilters(ctx)}
        <p class="result-count" id="galleryCount" aria-live="polite"></p>
        ${grid(list, "gallery-products")}
        <div id="galleryEmpty" class="callout hidden"><p>No gifts match these filters yet. Try another budget or category.</p></div>
        ${side.length ? `<p class="side-note">Looking for ${side.map((c) => `<a href="/category/${c.slug}.html">${esc(c.name.toLowerCase())}</a>`).join(" or ")}? They have their own sections.</p>` : ""}
      </section>` + footer(ctx);
}

function pageFinder(ctx) {
  return head({ ctx, title: "Gift Finder: The Right Gift in 3 Taps · 7 Day Gifts", description: "Pick who it's for, the occasion and your budget, and see matching gift ideas for the chosson, the kallah, your wife or your husband.", canonical: SITE + "/gift-finder.html" }) + header("Gift Finder", ctx) +
    finderBlock(ctx, { tag: "h1" }) + `
      <section class="section"><p class="side-note">Prefer to browse? <a href="/gift-gallery.html">See all ${ctx.mainGifts.length} gifts</a>.</p></section>` + footer(ctx);
}

function pageWishlist(ctx) {
  return head({ ctx, title: "Your Wish List · 7 Day Gifts", description: "The gifts you saved on 7 Day Gifts, kept on this device.", canonical: SITE + "/wishlist.html", noindex: true }) + header("Wish List", ctx) + `
      <section class="section">
        ${sectionHeader("Your Wish List", '<span id="wishlistSubtitle">Saved on this device.</span>', "h1")}
        <div id="wishlistEmpty" class="callout hidden">
          <p>Your wish list is empty. Tap the heart on any gift to save it here.</p>
          <p><a class="btn-pill btn-primary" href="/gift-gallery.html">Browse all gifts</a></p>
        </div>
        <div class="product-grid" id="wishlist-products"></div>
      </section>` + footer(ctx);
}

function pageProduct(ctx, p) {
  const who = WHO[p.gender];
  const cat = ctx.categories.find((c) => c.name === p.category);
  const related = [
    ...(isWallet(p) ? ctx.products.filter((q) => q.id !== p.id && isWalletTracker(q)) : []),
    ...ctx.products.filter((q) => q.id !== p.id && q.category === p.category && !(isWallet(p) && isWalletTracker(q))).sort(byPop),
    ...ctx.products.filter((q) => q.id !== p.id && q.category !== p.category && !q.side && (q.gender === p.gender || p.gender === "all")).sort(byPop),
  ].slice(0, 8);
  const guides = ctx.guides.filter((g) => g.sections.some((s) => s.products.includes(p.id)));
  const items = [["/index.html", "Home"]];
  if (cat) items.push([`/category/${cat.slug}.html`, cat.name === "Home" ? "For the Home" : cat.name]); else items.push(["/gift-gallery.html", "All Gifts"]);
  items.push([`/gifts/${p.slug}.html`, p.name]);
  const bc = crumbs(items);
  const productLd = { "@context": "https://schema.org", "@type": "Product", name: p.title, description: p.description, sku: p.id, url: `${SITE}/gifts/${p.slug}.html` };
  if (p.image) productLd.image = [p.image];
  if (p.category) productLd.category = p.category;
  const whoLine = p.gender === "all" ? "Either of you" : p.gender === "him" ? "Him (the chosson or your husband)" : "Her (the kallah or your wife)";
  const occ = p.occasions.map((k) => OCCASIONS.find((o) => o.key === k)).filter(Boolean);
  const title = `${clip(p.name, 48)} · Gift Idea ${p.gender === "all" ? "for Couples" : "for " + (p.gender === "him" ? "Him" : "Her")} | 7 Day Gifts`;
  return head({ ctx, title, description: clip(p.description, 158), canonical: `${SITE}/gifts/${p.slug}.html`, image: p.image, type: "product", jsonld: [productLd, bc.ld] }) + header("", ctx) + `
      <section class="section">
        ${bc.html}
        <article class="product-detail" data-id="${esc(p.id)}" data-category="${esc(p.category)}" data-gender="${p.gender}">
          <div class="product-detail-media">
            <div class="product-image-wrap${p.image ? "" : " image-missing"}">${p.image ? `<img class="product-image" src="${esc(p.big || p.image)}" alt="${esc(p.name)}" width="600" height="600" onerror="this.style.display='none';this.parentElement.classList.add('image-missing');" />` : ""}<div class="image-fallback">Image coming soon</div></div>
          </div>
          <div class="product-detail-body">
            ${cat ? `<a class="eyebrow eyebrow-link" href="/category/${cat.slug}.html">${esc(cat.name === "Home" ? "For the Home" : cat.name)}</a>` : ""}
            <h1 class="product-detail-title">${esc(p.name)}</h1>
            ${p.band ? `<p class="price-line"><span class="band band-lg">${esc(p.band)}</span> · ${p.shop ? `Price set by ${esc(p.shop)}` : "Check price on Amazon"}</p>` : ""}
            <p class="product-detail-desc">${esc(p.description)}</p>
            <dl class="product-facts">
              <div><dt>Who it's for</dt><dd><a href="/for/${who.slug}.html">${esc(whoLine)}</a></dd></div>
              ${p.cardLabel ? `<div><dt>Card type</dt><dd>${esc(p.cardLabel)}</dd></div>` : ""}
              ${p.band ? `<div><dt>Budget</dt><dd>${esc(p.band)} <span class="band-note">(approx.; check ${p.shop ? "the shop" : "Amazon"} for today's price)</span></dd></div>` : ""}
              ${cat ? `<div><dt>Category</dt><dd><a href="/category/${cat.slug}.html">${esc(cat.name)}</a></dd></div>` : ""}
              ${occ.filter((o) => o.key !== "chanukah").length ? `<div><dt>Great for</dt><dd>${occ.filter((o) => o.key !== "chanukah").map((o) => esc(o.short)).join(", ")}</dd></div>` : ""}
            </dl>
            <div class="product-actions">
              <a class="btn-pill btn-primary btn-big ${linkClass(p)}" href="${esc(p.url)}" target="_blank" rel="${p.rel}" data-id="${esc(p.id)}">${esc(buyLabel(p))}</a>
              <button type="button" class="heart heart-btn" data-id="${esc(p.id)}" aria-label="Save ${esc(p.name)} to your wish list">${ICON.heart}</button>
            </div>
            ${p.title !== p.name && !p.shop ? `<p class="product-note">Amazon listing: ${esc(p.title)}</p>` : ""}
            ${p.shop ? `<p class="product-note">Sold by ${esc(p.shop)}. Price, shipping and returns are set by the shop.${p.rel.includes("sponsored") ? " We may earn a commission if you buy through this link." : ""}</p>` : `<p class="product-note">Price and delivery are shown on Amazon and can change. As an Amazon Associate we may earn from qualifying purchases.</p>`}
            ${guides.length ? `<p class="product-guides">Featured in: ${guides.map((g) => `<a href="/guides/${g.slug}.html">${esc(shortGuide(g.title))}</a>`).join(" · ")}</p>` : ""}
          </div>
        </article>
      </section>
      ${related.length ? `<section class="section collection">${sectionHeader("You might also like")}${row(related)}</section>` : ""}` + footer(ctx);
}

function pageList(ctx, { h1, title, description, canonical, intro, list, crumbItems, extra = "", noindex = false, seasonal = false, eyebrow = "", sections = null, active = "", festive = false }) {
  const bc = crumbs(crumbItems);
  const all = sections ? sections.flatMap((s) => s.list) : list;
  const ld = { "@context": "https://schema.org", "@type": "CollectionPage", name: h1, url: canonical,
    mainEntity: { "@type": "ItemList", numberOfItems: all.length, itemListElement: all.map((p, i) => ({ "@type": "ListItem", position: i + 1, url: `${SITE}/gifts/${p.slug}.html`, name: p.name })) } };
  const body = sections
    ? sections.filter((s) => s.list.length).map((s) => `<section class="list-section"${s.id ? ` id="${s.id}"` : ""}><h2 class="list-section-title">${esc(s.title)}</h2>${s.text ? `<p class="section-subtitle">${esc(s.text)}</p>` : ""}${grid(s.cap ? s.list.slice(0, s.cap) : s.list)}${s.cap && s.list.length > s.cap && s.more ? `<p class="list-more"><a class="see-all" href="${s.more}">See all ${s.list.length} ${esc(s.title)} gifts${ICON.arrow}</a></p>` : ""}</section>`).join("\n")
    : grid(list);
  return head({ ctx, title, description, canonical, noindex, seasonal, jsonld: [ld, bc.ld] }) + header(active, ctx) + `
      <section class="section">
        ${bc.html}
        ${festive ? `<div class="festive-head"><span class="fh-art" aria-hidden="true">${ICON.menorah}</span><div><p class="eyebrow eyebrow-light">${eyebrow}</p><h1 class="section-title">${esc(h1)}</h1><p class="section-subtitle">${esc(intro)}</p></div></div>` : sectionHeader(esc(h1), esc(intro), "h1", { eyebrow })}
        ${body}
        ${extra}
      </section>` + footer(ctx);
}

const CARD_SECTION_TEXT = { Sweet: "Kind words for no special reason.", "Just Because": "To say you were thinking of them.", Funny: "Clean and actually funny.", Anniversary: "For every anniversary.", Wedding: "For the wedding itself." };
function cardSections(list) {
  const order = ["Sweet", "Just Because", "Funny", "Anniversary", "Wedding"];
  const labels = [...new Set(list.map((p) => p.cardLabel || "More cards"))].sort((x, y) => (order.indexOf(x) + 1 || 99) - (order.indexOf(y) + 1 || 99));
  return labels.map((l) => ({ title: l === "More cards" ? l : `${l} cards`, text: CARD_SECTION_TEXT[l] || "", list: list.filter((p) => (p.cardLabel || "More cards") === l) }));
}
function pageCategory(ctx, c) {
  const list = keepWithWallets([...c.products].sort(byPop));
  const intro = ctx.catIntros[c.name] || `Hand-picked ${c.name.toLowerCase()} gift ideas for the chosson, the kallah and your spouse.`;
  const others = ctx.categories.filter((o) => o.name !== c.name).map((o) => `<a class="chip" href="/category/${o.slug}.html">${esc(o.name)} <span class="chip-count">${o.products.length}</span></a>`).join("");
  const isCards = /card/i.test(c.name), isWrap = /wrap/i.test(c.name);
  const h1 = isCards || isWrap ? c.name : `${c.name} Gift Ideas`;
  const ttl = isCards ? `${c.name}: Sweet & Funny (Clean) Cards for Your Spouse | 7 Day Gifts` : isWrap ? `Gift Wrap: Wrapping Paper, Ribbon & Seals for Anniversary & Wedding Gifts | 7 Day Gifts` : `${c.name} Gift Ideas for the Chosson, Kallah & Spouse | 7 Day Gifts`;
  return pageList(ctx, {
    h1, title: ttl, eyebrow: `${list.length} ${list.length === 1 ? "pick" : "picks"}`,
    description: clip(`${intro} ${list.length} hand-picked ${list.length === 1 ? "idea" : "ideas"}.`, 158),
    canonical: `${SITE}/category/${c.slug}.html`, intro, list, noindex: !c.indexable,
    sections: isCards ? cardSections(list) : null,
    crumbItems: [["/index.html", "Home"], ["/gift-gallery.html", "All Gifts"], [`/category/${c.slug}.html`, c.name === "Home" ? "For the Home" : c.name]],
    extra: `<div class="more-block"><h2 class="more-title">More categories</h2><div class="chip-row">${others}</div></div>`,
  });
}

function pageWho(ctx, key) {
  const w = WHO[key];
  const list = ctx.mainGifts.filter((p) => (key === "all" ? p.gender === "all" : p.gender === key || p.gender === "all")).sort((a, b) => (a.gender === key ? 0 : 1) - (b.gender === key ? 0 : 1) || byPop(a, b));
  const guideLinks = key === "her" ? ["gifts-for-the-kallah", "7-day-gift-ideas-before-the-wedding"] : key === "him" ? ["gifts-for-the-chosson", "7-day-gift-ideas-before-the-wedding"] : ["7-day-gift-ideas-before-the-wedding", "gifts-for-the-kallah", "gifts-for-the-chosson"];
  const gl = ctx.guides.filter((g) => guideLinks.includes(g.slug)).map((g) => `<a class="chip" href="/guides/${g.slug}.html">${esc(shortGuide(g.title))}</a>`).join("");
  return pageList(ctx, {
    h1: w.h1, title: `${w.title} | 7 Day Gifts`, description: clip(`${w.blurb} ${list.length} hand-picked ideas.`, 158), eyebrow: `${list.length} picks`,
    canonical: `${SITE}/for/${w.slug}.html`, intro: w.blurb, list,
    crumbItems: [["/index.html", "Home"], ["/gift-gallery.html", "All Gifts"], [`/for/${w.slug}.html`, w.label]],
    extra: `<div class="more-block"><h2 class="more-title">Related gift guides</h2><div class="chip-row">${gl}</div></div>`,
  });
}

// Budget pages: /budget/under-25.html … /budget/200-plus.html, plus /budget/under-50.html
function budgetPages(ctx) {
  const defs = [
    ...BANDS.map((b) => ({ slug: b.slug, label: b.label, keys: [b.key], h1: b.key === "u25" ? "Gifts Under $25" : b.key === "200p" ? "Gifts Over $200" : `Gifts ${b.label.replace("–", " to ")}` })),
    { slug: "under-50", label: "Under $50", keys: ["u25", "25-50"], h1: "Gifts Under $50" },
  ];
  const chips = defs.map((d) => `<a class="chip" href="/budget/${d.slug}.html">${esc(d.label)}</a>`).join("");
  return defs.map((d) => {
    const list = ctx.mainGifts.filter((p) => d.keys.includes(p.bandKey)).sort(byPop);
    return { rel: `budget/${d.slug}.html`, index: list.length >= 2, html: pageList(ctx, {
      h1: d.h1, title: `${d.h1}: Chosson, Kallah & Anniversary Gift Ideas | 7 Day Gifts`, eyebrow: `${list.length} picks · by budget`,
      intro: `Hand-picked gifts ${d.label.toLowerCase().startsWith("under") ? d.label.toLowerCase() : "in the " + d.label + " range"} for the chosson, the kallah, your wife or your husband. Budgets are a guide; check the current price before you buy.`,
      description: clip(`${list.length} hand-picked gift ideas ${d.label.toLowerCase().startsWith("under") ? d.label.toLowerCase() : d.label} for the chosson, the kallah and your spouse.`, 158),
      canonical: `${SITE}/budget/${d.slug}.html`, list, noindex: list.length < 2,
      crumbItems: [["/index.html", "Home"], ["/gift-gallery.html", "All Gifts"], [`/budget/${d.slug}.html`, d.label]],
      extra: `<div class="more-block"><h2 class="more-title">Other budgets</h2><div class="chip-row">${chips}</div></div>`,
    }) };
  });
}

// Chanukah pages: always built (the URLs never 404), indexed only in season.
function chanukahPages(ctx) {
  const s = ctx.season;
  const gifts = ctx.mainGifts.filter((p) => !isCardOrWrap(p) && !p.weddingOnly);
  let tagged = gifts.filter((p) => p.occasions.includes("chanukah"));
  if (!tagged.length) tagged = gifts; // nothing tagged yet: fall back to the top gifts by budget
  const pick = (f) => tagged.filter(f).sort(byPop);
  const wrap = ctx.products.filter((p) => /wrap/i.test(p.category)).sort(byPop);
  const when = `Chanukah ${s.year} begins at sundown on ${s.pretty}.`;
  const chips = [["/chanukah/", "All Chanukah gifts"], ["/chanukah/for-her.html", "For her"], ["/chanukah/for-him.html", "For him"], ["/chanukah/under-50.html", "Under $50"], ["/guides/chanukah-gifts-for-wife-or-husband.html", "Chanukah gift guide"]]
    .map(([h, l]) => `<a class="chip chip-chanukah" href="${h}">${l}</a>`).join("");
  const extra = `${wrap.length ? `<section class="list-section"><h2 class="list-section-title">Don’t forget the wrapping</h2>${grid(wrap.slice(0, 4))}</section>` : ""}<div class="more-block"><h2 class="more-title">More Chanukah gifts</h2><div class="chip-row">${chips}</div></div>`;
  const base = { seasonal: true, noindex: true, active: "Chanukah", extra, festive: true };
  const crumbsFor = (rel, label) => [["/index.html", "Home"], ["/chanukah/", "Chanukah Gifts"], ...(rel ? [[`/chanukah/${rel}`, label]] : [])];
  const bandSections = BANDS.map((b) => ({ id: `budget-${b.slug}`, title: b.label, list: pick((p) => p.bandKey === b.key), cap: 8, more: `/budget/${b.slug}.html` }));
  const noBand = pick((p) => !p.bandKey);
  if (noBand.length) bandSections.push({ title: "More Chanukah ideas", list: noBand });
  return [
    { rel: "chanukah/index.html", url: "chanukah/", html: pageList(ctx, { ...base, h1: `Chanukah Gifts ${s.year}`, eyebrow: "Eight nights · sorted by budget",
      title: `Chanukah Gifts ${s.year}: Ideas for Your Wife, Husband & Family, by Budget | 7 Day Gifts`,
      intro: `${when} Here are our favorite Chanukah gifts, from little nightly surprises to the big one, sorted by budget.`,
      description: clip(`${when} Chanukah gift ideas for your wife, your husband and the family, sorted by budget: under $25, $25–$50, $50–$100 and more.`, 158),
      canonical: `${SITE}/chanukah/`, sections: bandSections, crumbItems: crumbsFor() }) },
    { rel: "chanukah/for-her.html", html: pageList(ctx, { ...base, h1: `Chanukah Gifts for Her ${s.year}`, eyebrow: "For your wife or kallah",
      title: `Chanukah Gifts for Her ${s.year}: Ideas for Your Wife or Kallah | 7 Day Gifts`,
      intro: `${when} Thoughtful Chanukah gifts for your wife or your kallah, from small nightly treats to something special.`,
      description: clip(`${when} Chanukah gift ideas for your wife or kallah, hand-picked and sorted by popularity.`, 158),
      canonical: `${SITE}/chanukah/for-her.html`, list: pick((p) => p.gender === "her" || p.gender === "all").sort((a, b) => (a.gender === "her" ? 0 : 1) - (b.gender === "her" ? 0 : 1) || byPop(a, b)), crumbItems: crumbsFor("for-her.html", "For Her") }) },
    { rel: "chanukah/for-him.html", html: pageList(ctx, { ...base, h1: `Chanukah Gifts for Him ${s.year}`, eyebrow: "For your husband or chosson",
      title: `Chanukah Gifts for Him ${s.year}: Ideas for Your Husband or Chosson | 7 Day Gifts`,
      intro: `${when} Chanukah gifts he’ll actually use, for your husband or your chosson.`,
      description: clip(`${when} Chanukah gift ideas for your husband or chosson, hand-picked and sorted by popularity.`, 158),
      canonical: `${SITE}/chanukah/for-him.html`, list: pick((p) => p.gender === "him" || p.gender === "all").sort((a, b) => (a.gender === "him" ? 0 : 1) - (b.gender === "him" ? 0 : 1) || byPop(a, b)), crumbItems: crumbsFor("for-him.html", "For Him") }) },
    { rel: "chanukah/under-50.html", html: pageList(ctx, { ...base, h1: `Chanukah Gifts Under $50`, eyebrow: "Eight nights without breaking the bank",
      title: `Chanukah Gifts Under $50 (${s.year}): Nightly Gift Ideas for Your Spouse | 7 Day Gifts`,
      intro: `${when} Eight nights add up. These Chanukah gifts are all under $50, perfect for a little something each night.`,
      description: clip(`${when} Chanukah gift ideas under $50 for your wife, husband or family: perfect for a small gift each night.`, 158),
      canonical: `${SITE}/chanukah/under-50.html`, sections: [{ title: "Under $25", list: pick((p) => p.bandKey === "u25") }, { title: "$25–$50", list: pick((p) => p.bandKey === "25-50") }], crumbItems: crumbsFor("under-50.html", "Under $50") }) },
  ];
}

function pageGuide(ctx, g) {
  const map = new Map(ctx.products.map((p) => [p.id, p]));
  const bc = crumbs([["/index.html", "Home"], ["/guides/", "Gift Guides"], [`/guides/${g.slug}.html`, shortGuide(g.title)]]);
  const sections = g.sections.map((s) => {
    const list = s.products.map((id) => map.get(id)).filter(Boolean);
    if (!list.length) return "";
    const day = s.heading.match(/^Day\s*(\d)/i);
    return `<section class="guide-section"${day ? ` id="day-${day[1]}"` : ""}><h2>${esc(s.heading)}</h2><p>${esc(s.text)}</p>${grid(list)}</section>`;
  }).join("\n");
  const all = g.sections.flatMap((s) => s.products).map((id) => map.get(id)).filter(Boolean);
  const ld = { "@context": "https://schema.org", "@type": "Article", headline: g.title, description: g.description, url: `${SITE}/guides/${g.slug}.html`,
    image: all[0]?.image ? [all[0].image] : undefined, publisher: { "@type": "Organization", name: "7 Day Gifts", logo: { "@type": "ImageObject", url: SITE + "/logo.png" } }, author: { "@type": "Organization", name: "7 Day Gifts" } };
  const others = ctx.guides.filter((o) => o.slug !== g.slug).map((o) => `<a class="chip" href="/guides/${o.slug}.html">${esc(shortGuide(o.title))}</a>`).join("");
  return head({ ctx, title: `${g.metaTitle || g.title} | 7 Day Gifts`, description: g.description, canonical: `${SITE}/guides/${g.slug}.html`, type: "article", noindex: !!g.hidden, jsonld: [ld, bc.ld] }) + header("Gift Guides", ctx) + `
      <section class="section guide">
        ${bc.html}
        <p class="eyebrow">Gift guide</p>
        <h1 class="guide-title">${esc(g.title)}</h1>
        <div class="guide-intro">${g.intro.map((t) => `<p>${esc(t)}</p>`).join("")}</div>
        ${sections}
        ${g.tips?.length ? `<section class="guide-section callout"><h2>Tips</h2><ul>${g.tips.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></section>` : ""}
        <p class="guide-more">Want to see everything? <a href="/gift-gallery.html">Browse all ${ctx.mainGifts.length} gifts</a>, try the <a href="/gift-finder.html">3-tap gift finder</a>, or shop <a href="/for/her.html">gifts for her</a> and <a href="/for/him.html">gifts for him</a>.</p>
        <div class="more-block"><h2 class="more-title">More gift guides</h2><div class="chip-row">${others}</div></div>
      </section>` + footer(ctx);
}

function pageGuides(ctx) {
  const bc = crumbs([["/index.html", "Home"], ["/guides/", "Gift Guides"]]);
  return head({ ctx, title: "Gift Guides for the 7 Days Before the Wedding | 7 Day Gifts", description: "Practical gift guides for the seven days before the wedding, and gifts for the chosson and the kallah.", canonical: SITE + "/guides/", jsonld: [bc.ld] }) + header("Gift Guides", ctx) + `
      <section class="section">
        ${bc.html}
        ${sectionHeader("Gift Guides", "Short, practical guides to help you choose.", "h1")}
        <div class="guide-list">
          ${ctx.guides.map((g) => guideCard(ctx, g)).join("\n          ")}
        </div>
      </section>` + footer(ctx);
}

function pageContact(ctx) {
  const bc = crumbs([["/index.html", "Home"], ["/contact.html", "Contact Us"]]);
  const ld = { "@context": "https://schema.org", "@type": "ContactPage", name: "Contact 7 Day Gifts", url: SITE + "/contact.html",
    mainEntity: { "@type": "Organization", name: "7 Day Gifts", url: SITE + "/", email: "info@7daygifts.com", telephone: "+1-475-329-4438" } };
  return head({ ctx, title: "Contact Us | 7 Day Gifts", description: "Have a gift idea, a question, or feedback? We'd love to hear from you. Email info@7daygifts.com.", canonical: SITE + "/contact.html", jsonld: [ld, bc.ld] }) + header("Contact", ctx) + `
      <section class="section contact-page">
        ${bc.html}
        <div class="contact-card">
          <p class="eyebrow">Say hello</p>
          <h1 class="section-title">Contact Us</h1>
          <p class="contact-lead">Have a gift idea, a question, or feedback? We'd love to hear from you.</p>
          <p class="contact-direct"><a class="btn-pill btn-primary contact-mail" href="mailto:info@7daygifts.com?subject=Hello%20from%207daygifts.com">Email info@7daygifts.com</a></p>
          <p class="contact-or">Or write it here, and we'll open your email app with your note ready to send:</p>
          <form id="contactForm" class="contact-form">
            <label class="contact-label" for="contactName">Your name (optional)</label>
            <input type="text" id="contactName" name="name" class="contact-input" autocomplete="name" />
            <label class="contact-label" for="contactTopic">What's it about?</label>
            <select id="contactTopic" name="topic" class="contact-input">
              <option>A gift idea</option>
              <option>A question</option>
              <option>Feedback</option>
              <option>Something else</option>
            </select>
            <label class="contact-label" for="contactMessage">Message</label>
            <textarea id="contactMessage" name="message" class="contact-input contact-message" rows="5" required></textarea>
            <button type="submit" class="btn-pill btn-primary contact-send">Write the email</button>
          </form>
          <p id="contactDone" class="contact-done hidden">Your email app should open with your note. If it didn't, just email us at <a href="mailto:info@7daygifts.com">info@7daygifts.com</a>.</p>
          <p class="contact-phone">Prefer the phone? Call <a href="tel:14753294438">475-329-4438</a>.</p>
        </div>
      </section>` + footer(ctx);
}

function page404(ctx) {
  return head({ ctx, title: "Page not found · 7 Day Gifts", description: "This page could not be found on 7 Day Gifts. Browse popular gift ideas instead.", canonical: SITE + "/404.html", noindex: true }) + header("", ctx) + `
      <section class="section">
        ${sectionHeader("We couldn't find that page", "The gift may have been removed. Here are some popular ideas instead.", "h1")}
        ${grid([...ctx.mainGifts].filter((p) => !isCardOrWrap(p)).sort(byPop).slice(0, 8))}
        <p class="side-note"><a href="/gift-gallery.html">Browse all ${ctx.mainGifts.length} gifts</a></p>
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
  const season = chanukahSeason();
  const mainGifts = products.filter((p) => !p.side); // anniversary cards & wrapping paper have their own sections
  // A guide marked "hidden" in data/guides.json is still built (direct link only) but linked nowhere, noindex, not in the sitemap.
  const publicGuides = guides.filter((g) => !g.hidden);
  const ctx = { products, mainGifts, categories, guides: publicGuides, catIntros, season: { ...season, on: false } };

  // generated folders are rebuilt from scratch so removed products disappear
  for (const dir of ["gifts", "category", "for", "guides", "budget", "chanukah"]) await rm(path.join(OUT, dir), { recursive: true, force: true });

  const urls = [];
  const add = (rel, html, index = true, url = rel) => { if (index) urls.push(url); return writeOut(rel, html); };
  await add("index.html", pageHome(ctx), true, "");
  await add("gift-gallery.html", pageGallery(ctx));
  await add("gift-finder.html", pageFinder(ctx));
  await add("contact.html", pageContact(ctx));
  await add("wishlist.html", pageWishlist(ctx), false);
  await add("404.html", page404(ctx), false);
  await add("guides/index.html", pageGuides(ctx), true, "guides/");
  for (const g of guides) await add(`guides/${g.slug}.html`, pageGuide(ctx, g), !g.hidden);
  for (const k of ["her", "him", "all"]) await add(`for/${WHO[k].slug}.html`, pageWho(ctx, k));
  for (const b of budgetPages(ctx)) await add(b.rel, b.html, b.index);
  for (const c of chanukahPages(ctx)) await add(c.rel, c.html, false, c.url || c.rel); // direct link only, never in the sitemap
  for (const c of categories) await add(`category/${c.slug}.html`, pageCategory(ctx, c), c.indexable);
  const movedPages = await writeCategoryRedirects(categories);
  if (movedPages) console.log(`Old category addresses forwarded to the new ones: ${movedPages}`);
  for (const p of products) await add(`gifts/${p.slug}.html`, pageProduct(ctx, p));

  // product data for the wish list, gallery and gift finder scripts
  await writeOut("products.json", JSON.stringify(products.map((p) => ({ id: p.id, asin: p.asin, title: p.name, image: p.image, thumb: p.thumb, url: p.url, shop: p.shop, rel: p.rel, slug: p.slug, category: p.category, cardLabel: p.cardLabel, gender: p.gender, popularity: p.popularity, order: p.order, band: p.band, bandKey: p.bandKey, occasions: p.occasions, weddingOnly: p.weddingOnly, hook: p.hook, side: p.side }))));
  await writeOut("sitemap.xml", `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${SITE}/${u}</loc></url>`).join("\n")}\n</urlset>\n`);
  await writeOut("robots.txt", PREVIEW ? "User-agent: *\nAllow: /\n" : `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`);

  if (PREVIEW) {
    for (const f of ["style.css", "app.js", "reviews.js", "logo.png", "logo-sm.png", "favicon.ico", "hero.jpg", "hero-1600.jpg", "hero-800.jpg", "favicon-16x16.png", "favicon-32x32.png", "apple-touch-icon.png", "icon-192.png", "icon-512.png", "site.webmanifest"]) if (existsSync(path.join(ROOT, f))) await copyFile(path.join(ROOT, f), path.join(OUT, f));
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
  const noBand = products.filter((p) => !p.band).map((p) => p.id);
  console.log(`Built ${products.length} product pages (${mainGifts.length} in the main gift mix), ${categories.length} category pages, 3 who-it's-for pages, ${guides.length} guides, ${urls.length} URLs in sitemap -> ${OUT}`);
  console.log(`Chanukah ${season.year} starts ${season.start}: seasonal sections are ${season.on ? "ON" : "OFF"} for this build.`);
  if (noBand.length) console.log(`Products with no budget band in the sheet's price column (nothing shown): ${noBand.join(", ")}`);
  if (missing.length) console.log(`Products using the automatic fallback description (add one in the sheet's site_description or data/descriptions.json): ${missing.join(", ")}`);
}

main().catch((e) => { console.error("Build failed:", e.message); process.exit(1); });
