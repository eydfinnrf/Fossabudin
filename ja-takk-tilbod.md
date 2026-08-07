# Ja Takk Tilboð — build documentation

Full record of the session that added the **"Ja Takk Tilboð"** offers feature to
fossabudin.fo. Date: 2026-08-07. Branch: `dev`.

---

## 1. What was asked for

> A new section on the frontpage, placed **first — before "Nær hava vit opið?"** —
> showing products that are on sale, headed **"Ja Takk Tilboð"**.
>
> Which products appear, the previous price and the current price are all
> managed on **admin.fossabudin.fo**. There should be a section there for
> "Ja Takk Tilboð" with a **`+` button** that lets you pick products from the
> order section, type a previous price and a current price, and have that go
> automatically to the official site.

---

## 2. Decisions taken (answers to the clarifying questions)

| Question | Decision |
|---|---|
| What level do you pick in the `+` picker? | **Specific variant (sub-item)** — e.g. Mjólk → "Bónda mjólk - 3,5% (1 L)". A price belongs to one exact item. |
| What happens when a customer taps a card? | **Nothing — the card is a poster.** Display only. |
| What goes on each card? | **Emoji + name + prices.** No description line. |
| Section heading | **Just the big title "Ja Takk Tilboð"** — no small eyebrow label above it. |
| Empty state | **Section always visible**, with a Faroese line saying there are no offers. |
| Price entry | **Decimals allowed** (`15,50`), **−% auto-calculated** from the two prices. |
| Emoji per offer | **Inherited from the product**, overridable per offer. |
| Auto-removal | **Never.** Fully manual — the switch and the bin only. An out-of-stock item keeps its offer card. |
| Old "Viku tilboð" code | **Deleted.** |
| Who builds / how far | Built here (not by Charlie — too big for his remit). **Pushed to `dev` only**; `main` needs owner approval. |

### Faroese wording (owner-corrected)

- Empty state: **"Onki Ja Takk Tilboð í løtuni"**
- Admin fields: **"Upprunaligi prísur"** / **"Ja Takk Prísur"** / **"Vel Vøru"**

---

## 3. Starting state found in the code

- Catalog lives in **Cloudflare D1**, three levels: `categories → products → sub_items`.
  Confirmed live counts: **31 categories, 31 products (all `expandable`), 406 sub-items, zero `simple` products.**
  That last fact is why sub-item-only offers are safe — no product is unreachable in the picker.
- **No price columns existed anywhere.** Prices had been deferred in earlier phases, so this needed a schema change.
- API Worker: `fossabudin-api`, code in `api/src/catalog-api.js`, admin page in `api/src/admin-page.html`, served at `admin.fossabudin.fo`.
- The frontpage already had a **commented-out "Viku tilboð" section** plus a dead
  hardcoded `TILBOD` array and `renderTilbod()`. Its CSS (`.tilbod-card`,
  `.tilbod-badge`, `.tilbod-price-new/old`) was intact and became the base for the new cards.

---

## 4. What was built

### 4.1 Database — new `offers` table

Applied as an **additive** migration so the live catalog was never wiped:
`api/migrations/001-offers.sql`

```sql
CREATE TABLE IF NOT EXISTS offers (
  id          INTEGER PRIMARY KEY,
  sub_item_id INTEGER NOT NULL REFERENCES sub_items(id) ON DELETE CASCADE,
  emoji       TEXT,                       -- NULL = inherit from product
  price_old   REAL    NOT NULL,
  price_new   REAL    NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1, -- 1 = shown on the site
  sort_order  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_offers_sub ON offers(sub_item_id);
```

Apply with:

```bash
cd api
npx wrangler d1 execute fossabudin-catalog --remote --config ./wrangler.toml \
  --file ./migrations/001-offers.sql
```

**Design note:** the product *name is deliberately not stored*. It is read live
from `sub_items` at request time, so renaming a product in the catalog renames
its offer card automatically. Same for the emoji when no override is set.

The same table was added to `api/schema.sql` so a future full rebuild keeps it.

### 4.2 API — `api/src/catalog-api.js`

**Public**

| Endpoint | Behaviour |
|---|---|
| `GET /offers` | Active offers with name, emoji, both prices, and computed `pct`. 60s cache, CORS open. |

Deliberately **not** filtered by `in_stock` — that is the "never auto-remove" decision.

**Admin** (all require `Authorization: Bearer <ADMIN_TOKEN>`)

| Endpoint | Behaviour |
|---|---|
| `GET /admin/offers` | All offers, including switched-off ones |
| `POST /admin/offer` | `{ sub_item_id, price_old, price_new, emoji? }` |
| `PATCH /admin/offer/:id` | `{ price_old?, price_new?, emoji?, active? }` |
| `DELETE /admin/offer/:id` | Remove |

Helpers added:

- `discountPct(old, new)` — whole-number percent, `null` when it wouldn't make sense.
- `parsePrice(v)` — accepts `"12,50"` as well as `"12.50"`, so Faroese decimal commas work.
- `buildOffers(env, onlyActive)` — joins `offers → sub_items → products → categories`
  and resolves name + inherited emoji.

**Re-adding the same product edits the existing offer instead of duplicating it**
(returns `{ok:true, id, replaced:true}`).

**Orphan cleanup:** the existing category / product / sub-item `DELETE` handlers
now also delete matching `offers` rows in their `env.DB.batch`. D1 does not
enforce foreign-key cascade, so without this a deleted product would leave a
blank offer card on the frontpage.

### 4.3 Admin page — `api/src/admin-page.html`

A **"Ja Takk Tilboð"** panel sits above the catalog accordion.

- Each offer row: on/off switch, emoji, name, `15,50 kr` struck through, `12 kr` in green, `−23%` badge, edit (✏️), delete (🗑).
- A sold-out item shows an extra **"Uppselt"** badge — since offers never hide themselves, this is the warning that you're advertising something you can't sell.
- **`＋ Nýtt tilboð`** opens the **"Vel Vøru"** picker: a category → variant accordion over the catalog already in memory, with a search box that filters across all 406 items and auto-expands matches.
- Picking a variant opens the price form: **Ikon** (pre-filled from the product), **Upprunaligi prísur**, **Ja Takk Prísur**, and a **live −% preview** that updates as you type.
- Validation: refuses to save if either price is blank ("Skriva báðar prísarnar.") or if the offer price isn't lower ("Ja Takk prísurin má vera lægri enn upprunaligi prísurin.").
- The emoji is only stored when it **differs** from the inherited one, so it keeps following the product otherwise.

### 4.4 Frontpage — `index.html`

- New `<section id="jatakk">` placed **between the hero and `#tiding`**.
  Verified section order is now: `hero → jatakk → tiding → um → samband`.
- Heading is `<h2 class="section-title">Ja Takk Tilboð</h2>` alone, no eyebrow label.
- Cards are **not clickable** — poster only.
- Fetches `/offers` on `DOMContentLoaded`, with a `localStorage` fallback
  (`fossabudin_offers_v1`) mirroring how the catalog already works, so an API
  outage shows the last known offers rather than an error.
- `fmtKr()` formats Faroese-style: `15 kr` for whole krónur, `34,50 kr` when there are øre.
- Empty state: grid hidden, status line shows **"Onki Ja Takk Tilboð í løtuni"**.

**Removed** (owner approved): the commented-out `Viku tilboð` section, the
hardcoded 7-item `TILBOD` array, and `renderTilbod()`.

> Note found during the work: `renderTilbod()` **was** actually being called on
> load — it just silently bailed out because its grid element didn't exist. It
> was dead in effect, not in fact. Its call site was replaced with the new
> `loadOffers` hooked to `DOMContentLoaded` (which also avoids a temporal-dead-zone
> problem with the `CATALOG_API` const).

**CSS:** the old `.tilbod-*` rules were renamed to `.jatakk-*` (12 occurrences),
`.jatakk-desc` was dropped since there's no description line, and `.jatakk-status`
was added for the loading/empty text.

### 4.5 Card redesign (2026-08-07, commit `b075e51`)

The first version reused the old `.tilbod-card` shape: a 4:3 image slot above
the text. That shape was drawn for **product photographs** — filled with one
emoji it left roughly **195px of empty box** on every card, and the horizontal
scroller meant a phone showed **one** offer at a time.

Replaced with a **compact row**:

```
[ 52px emoji disc ]  Name              −15%
                     17 kr  20 kr
```

- `.jatakk-grid` is now `repeat(auto-fill, minmax(280px, 1fr))` — it **wraps**
  instead of scrolling sideways, so no offer is hidden off the edge. One column
  on a phone, two on a tablet, three on a desktop, with no media query needed.
- `.jatakk-img` became `.jatakk-emoji`: a 52px circle in `--warm`.
- Card height dropped from ~380px to around **108px**. Three offers now fit on
  one phone screen above the fold.

### 4.6 Long names (2026-08-07, commit `2abfdcc`)

The first pass parked the `−%` badge at the card's right edge. Measured against
the real catalog that was the wrong trade: **median sub-item name is 24
characters, the longest is 50** ("Fryseposer med skrivefelt (Rema 1000, 8L, 50
stk.)"), 199 of 406 are over 24 and 85 are over 32. Names are nearly always
`Base name (Brand, size)`, where the parenthetical carries the size — so
truncating it loses information the customer needs. The badge was consuming
exactly the width those names required.

- **The badge moved back beside the prices**, giving the name the full row width.
- **`-webkit-line-clamp: 3`** on `.jatakk-name`, with the untruncated name kept
  in the `title` attribute — a freak name can't stretch the card.
- **`grid-auto-rows: 1fr`** makes every card the same height, so a two-line name
  no longer leaves its neighbours looking stunted.
- Track is **`minmax(min(320px, 100%), 1fr)`** — without the `min()`, a 320px
  phone (viewport minus 5vw padding = 288px) would overflow sideways.

Checked with the three longest real names at 320px, 375px, 768px and at the
tight 3-column desktop width (323px columns): every card 108px, **nothing
clamped**, no sideways overflow. A deliberately absurd 152-character name
clamps to exactly 3 lines, keeps both cards equal at 128px, and retains the
full text in `title`.

Confirmed afterwards on the deployed dev site against an offer the owner had
just added — "Mikroovn Popcorn med salt (Rema 1000, 3x100g)", 45 characters —
which wraps to two lines, keeps the `3x100g` size visible, and matches its
neighbours at 108px.

### 4.7 Previous price legibility (2026-08-07, commit `686e543`)

`.jatakk-price-old` was `--stone` (`#c8bfae`) on a white card — about **1.9:1**
contrast, far below the 4.5:1 readability threshold, so the struck-through
price effectively vanished. Owner asked for it to be more visible.

Now `--bark` at **6.48:1**, and `.8rem → .9rem`. The green current price keeps
the emphasis through **size and weight** (18.4px semibold vs 14.4px regular)
rather than by washing the old price out. Card heights unchanged at 108px.

Note: `api/src/admin-page.html` already used `--bark` for `.offer-prices`, so
the admin list never had this problem — it was frontpage-only.

### 4.8 Offers marked in the ordering list too (2026-08-07, commit `4b3c236`)

Owner: *"when a product gets listed on Ja Takk Tilboð the same data should be in
the normal order list … for the customers that are ordering to see it there as
well."* Until now an offer lived only in the `#jatakk` section at the top of the
page; a customer already scrolling the ordering list saw nothing, which is where
the buying decision is actually made.

The join is `offer.sub_item_id` → `sub.id`, exact and already in both payloads.

**Badge only — no prices in the ordering list.** That list carries no price on
any row (`/catalog` has no price field at all), so a lone "17 kr" on one row
would imply the other 405 items are priceless. The Ja Takk card above still
carries the actual numbers.

Two badges, both reusing the `.order-sale-badge` style that was already sitting
unused in the CSS from an earlier design:

- on the sub-item — `−15%`, or `Tilboð` when an offer has no percentage, so a
  discount-less offer is still findable;
- on the **collapsed group row** — `Tilboð`. Without this the badge is only ever
  seen by someone who already opened that group, which loses most of the point.

Three things had to be protected, because the badge is a child of the button
whose text is read elsewhere:

| Reader | Protection |
|---|---|
| Order summary, category rows, owner's SMS | `cleanItemName()` now strips `.order-sale-badge` as well as `.sub-dot`. Verified: a selected offer item still collects as `1x Heil breyð`. |
| Product search | reads a new `data-name` attribute instead of `textContent`, so searching `tilboð` matches 0 rows and `15` matches only real names (150g, 15L, 415g). |
| Either list reloading | `applyOfferBadges()` removes every badge before re-adding, so it is idempotent — 3 calls still give 8 badges. |

`renderCatalog()` and `renderOffers()` are two independent `DOMContentLoaded`
fetches, so **both** call `applyOfferBadges()`; whichever lands second does the
work. Verified in both orders, and with offers arriving empty (0 badges).

`loadOffers()` also gained `cache: 'no-store'`, matching `loadCatalog()`. The API
sends `cache-control: public, max-age=60` on `/offers`, so without it an offer
added or removed in admin could be up to a minute stale on a fresh load.

**No code change is needed per offer** — admin writes to D1, `/offers` serves it,
and both the card and the ordering-list badge follow on the next page load. A
page already open does not update until reloaded.

---

## 5. Verification actually performed

### API (curl against the live Worker)

- `GET /offers` empty → `{"ok":true,"offers":[]}`
- Unauthorised write → **401**
- Create with comma decimals `"15,50"` / `"12,00"` → stored as `15.5` / `12`, `pct: 23`
- Name and emoji correctly inherited: `"Bónda mjólk - 3,5% (1 L)"`, `🥛`
- Re-adding the same product → `replaced: true`, still **1** offer, prices updated, `pct` recalculated to 25
- Switch off → disappears from public `/offers`, still present in `/admin/offers` with `active: false`
- Switch back on → reappears
- Rejects a non-existent product → `sub_item not found`

### Orphan cleanup (throwaway data, real catalog untouched)

Created a temp category → product → sub-item, attached an offer, deleted the
whole category. Offer count dropped from 2 → 1, and a direct SQL check for
orphans returned **0**. Catalog verified back at **31 categories / 406 sub-items**.

### Admin UI (driven in a browser)

Driven against a **stubbed API**, not the live one — deliberately, so no password
was typed into a login form.

- Panel renders with the empty message
- `＋ Nýtt tilboð` → "Vel Vøru" picker opens with categories
- Search `bónda` → filters and auto-expands to the one match
- Clicking the variant → price form opens, titled "Nýtt Ja Takk Tilboð", showing "Mjólk · Bónda mjólk - 3,5% (1 L)", emoji pre-filled 🥛
- Live preview: `15,50 / 12,00 → −23%`, `20 / 15 → −25%`, `10 / 10` and `10 / 12` → the red validation message, blank → no preview
- Save → offer row appears with switch, badge, prices; toast "Tilboð stovnað"
- Switch off → row dims (`offer off`); switch on → restores
- Delete → returns to the empty message

### Frontpage (browser, against live data)

- Section order confirmed `hero → jatakk → tiding`
- 4 offers rendered, formatting correct including `34,50 kr` and `44,95 kr`
- No console errors
- Empty state renders the corrected Faroese line

**One caveat, stated plainly:** the browser screenshot tool would not capture
this page correctly once scrolled below the hero — it returned blank frames and
once drew the nav bar at the bottom. The DOM was verified as correct
(`opacity: 1`, `visibility: visible`, no hidden ancestors, card at viewport
centre), and the section was screenshotted successfully by isolating it at
scroll 0. **The full page was never visually confirmed in a scrolled screenshot.**
Worth an eyeball on dev.fossabudin.fo.

**Also not tested:** mobile / narrow viewport rendering of the new section.

### Deployed dev site (added after the push)

Verified against `fossabudin-dev.eydfinn-rajani-faroe.workers.dev` — the same
Worker as dev.fossabudin.fo but reachable without the Access login.

- **Mobile 375×812: correct.** Scrolled screenshot captured cleanly. Cards are
  260px in a 337px horizontal scroller, `document.scrollWidth` does **not**
  exceed the viewport, so the page has no sideways overflow.
- **Tablet 768×1024: correct.** Scrolled screenshot captured cleanly, three
  cards visible with the fourth peeking — the intended carousel.
- **Section order confirmed live:** `hero → jatakk → tiding → um → samband`.
- **No console errors.**
- The blank-frame screenshot problem **recurred at 1280×800 only** — the same
  nav-bar-at-the-bottom artefact. It is a capture bug in the tool, not the page:
  the DOM at that width reports the grid at 1098px scroll width in a 1000px
  container with all four cards laid out correctly.

---

## 6. Current state — IMPORTANT

### Deployed
- **The API Worker is deployed** (version `c214fe79-82ef-4cff-a315-f2495a432bdb`).
  Because the Worker and D1 are **shared between dev and production**, the new
  "Ja Takk Tilboð" panel is **already live on admin.fossabudin.fo**. This is
  harmless — offers with no frontpage section to show them do nothing — but it
  is not dev-only.
- **The `offers` table exists in the live database.**
- **Committed and pushed to `dev`** as `2b5e4df`. Cloudflare Workers Builds
  redeployed dev.fossabudin.fo automatically and the section is live there.

### Not done yet
- **4 test offers are still sitting in the live database** (Bónda mjólk, 12 stk. Egg,
  Heil breyð, Danbo Mild & Cremet). These were demo data — **delete them in admin
  before this goes anywhere near customers**, or they'll show as real offers.
  They could not be deleted from the terminal: `api/admin-token.local.txt` no
  longer matches the Worker's `ADMIN_TOKEN` secret (every admin call returns
  401), and the local wrangler OAuth token has no D1 scope, so
  `wrangler d1 execute --remote` fails with `7403`. **Delete them with the bin
  icon on admin.fossabudin.fo** — that takes half a minute and is the workflow
  the feature exists for.
- **`main` / production untouched**, as agreed.
- Production `fossabudin.fo` is still behind the Cloudflare Access login wall
  from earlier work, so customers can't see the shop at all yet regardless.

---

## 7. Files changed

| File | Change |
|---|---|
| `api/migrations/001-offers.sql` | **new** — additive `offers` table migration |
| `api/schema.sql` | `offers` table + index added to the full-rebuild schema |
| `api/src/catalog-api.js` | `/offers`, four `/admin/offer*` endpoints, `buildOffers`, `discountPct`, `parsePrice`, orphan cleanup in three delete handlers |
| `api/src/admin-page.html` | Ja Takk Tilboð panel, product picker modal, price form modal, offer CSS, ~10 new JS functions |
| `index.html` | new `#jatakk` section, `loadOffers`/`renderOffers`/`fmtKr`, `.tilbod-*` → `.jatakk-*` CSS, old Viku tilboð code deleted |

`.claude/settings.local.json` also shows as modified — that's tool permissions, not part of this feature.

---

## 8. How the owner uses it

1. Go to **admin.fossabudin.fo**, log in with the shop password.
2. The **Ja Takk Tilboð** panel is at the top.
3. Press **`＋ Nýtt tilboð`** → search or browse to the exact product variant → click it.
4. Type **Upprunaligi prísur** and **Ja Takk Prísur**. The `−%` works itself out.
5. Press **Goym**. It's on the website within a minute (60s cache).
6. The switch hides an offer without deleting it; the bin removes it for good.

No commit, no deploy, no developer needed — same instant-live channel as the
stock toggles.

---

## 9. Open items

- [ ] **Delete the 4 demo offers** — owner has to do this in admin.fossabudin.fo
      (see §6: the local admin token and the wrangler D1 scope are both expired)
- [x] Commit and push to `dev` — `2b5e4df`
- [x] Eyeball the section on the deployed dev site, mobile and tablet (see §5)
- [x] Show offers in the ordering list as well — `4b3c236` (§4.8), verified live
      on `fossabudin-dev.eydfinn-rajani-faroe.workers.dev`
- [ ] Decide whether an already-open page should pick up offer changes without a
      reload (polling `/offers`), or whether next-load is enough — see §4.8
- [ ] Owner approves merge `dev` → `main` for production

### Noticed, not acted on

- `api/admin-token.local.txt` is stale. Worth refreshing it (or dropping it) so
  the next session isn't misled into thinking it has admin access.
- ~~The card's emoji tile is too tall~~ — **fixed in §4.5.**
