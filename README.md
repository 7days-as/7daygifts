# 7 Day Gifts

Static site for https://7daygifts.com (hosted free on Vercel).

## Adding products
Add a row to the Google Sheet ("Site Asin List") exactly as before. Set `status` to `active`.
The site rebuilds itself every day (and on demand from GitHub → Actions → "Rebuild site from Google Sheet" → Run workflow).

- `site_description` in the sheet: if filled in, it is used on the product page. If empty, the description in `data/descriptions.json` is used.
- `data/names.json` (optional): a shorter display name for a product, keyed by `product_id`.
- `data/slugs.json` is written by the build and keeps each product's web address stable even if its title changes. Don't edit unless you want to change a URL.
- `data/guides.json`: the gift-guide pages and which products they feature.
- `data/categories.json`: the short intro shown on each category page.

## What the build makes
`node build.mjs` (Node 18+, no packages) fetches the sheet and writes:
`index.html`, `gift-gallery.html`, `wishlist.html`, `404.html`, `gifts/*.html` (one per active product),
`category/*.html`, `for/her.html`, `for/him.html`, `for/couples.html`, `guides/*.html`, `products.json`,
`sitemap.xml` and `robots.txt`. Do not hand-edit those files; they are overwritten on every build.

If the sheet can't be reached, or suddenly has fewer than 10 active products, the build stops and the site stays as it was.

`app.js` adds the wish list (saved on the visitor's device), click tracking and the email sign-up on top of the built pages.

## v2 additions
- `price` column: type a budget band (Under $25, $25–$50, $50–$100, $100–$200, $200+). It shows on cards and product pages and drives the Budget filter, the gift finder and the budget pages (`/budget/…`). Leave blank to show nothing. Exact prices are never shown.
- `occasions` column: comma list of wedding, anniversary, chanukah, birthday, just because. Used by the gift finder and the Chanukah pages (blank = works for any occasion).
- Categories "Anniversary Cards" and "Wrapping Paper" have their own pages and homepage spots and are kept out of the main gift mix.
- Chanukah season: the Chanukah band, homepage banner, nav link and finder option show from 6 weeks before the first night through the 8th day, then hide. Dates live in `CHANUKAH_STARTS` in build.mjs (loaded through 2030) and the same check runs in the browser. Out of season the `/chanukah/` pages stay up but are noindex and left out of the sitemap. Preview any date with `node build.mjs --preview out --date 2027-03-01`, or add `?chanukah=on` / `?chanukah=off` to a page URL.
