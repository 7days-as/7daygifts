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

## Gift guides fill from the Sheet (`guides` column)
Each guide section in `data/guides.json` has a short `key`. Type keys in a product's `guides` cell (comma list) and the build adds it to those sections after the hand-picked `products`, most popular first, up to 8 per section (cards and wrapping paper are skipped unless the section is about them; wedding-only items never go into Chanukah sections).
Keys: day1-sentimental, day2-cozy, day3-everyday, day4-home, day5-travel, day6-fun, day7-special, kallah-keepsakes, kallah-fragrance, kallah-travel, kallah-cozy, chosson-carry, chosson-desk, chosson-travel, chosson-fun, chanukah-wife, chanukah-husband, chanukah-both. Shortcuts: `day1`…`day7`; `chanukah` (picks wife/husband/both from who_is_it_for). Unknown keys are listed in the build log.

## Small Shops (products not on Amazon)
A row with `amazon_enabled` = FALSE, `amazon_asin` empty and `my_url` = the product's link on any shop gets a "Shop at <domain>" button (rel="nofollow"; "sponsored nofollow" when the link carries an affiliate parameter), no Amazon wording, and also shows on `/category/small-shops.html` (made only when at least one such product exists). Clicks are tracked like Amazon clicks.
