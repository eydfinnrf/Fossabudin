-- "Ja Takk Tilboð" — products on sale, shown as the first section of the frontpage.
--
-- Additive migration: apply to the LIVE database without touching the catalog.
--   npx wrangler d1 execute fossabudin-catalog --remote --config ./wrangler.toml \
--     --file ./migrations/001-offers.sql
--
-- The product NAME is deliberately not stored here — it is read live from
-- sub_items, so renaming a product in the catalog renames its offer card too.
-- emoji NULL means "inherit the emoji of the parent product".

CREATE TABLE IF NOT EXISTS offers (
  id          INTEGER PRIMARY KEY,
  sub_item_id INTEGER NOT NULL REFERENCES sub_items(id) ON DELETE CASCADE,
  emoji       TEXT,                                  -- NULL = inherit from product
  price_old   REAL    NOT NULL,
  price_new   REAL    NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,            -- 1 = shown on the site
  sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_offers_sub ON offers(sub_item_id);
