-- Make offers.price_old nullable ("Upprunaligi prísur" becomes optional).
-- SQLite can't ALTER COLUMN, so rebuild the table.
ALTER TABLE offers RENAME TO offers_old;

CREATE TABLE offers (
  id          INTEGER PRIMARY KEY,
  sub_item_id INTEGER NOT NULL REFERENCES sub_items(id) ON DELETE CASCADE,
  emoji       TEXT,
  price_old   REAL,                                    -- NULL = no original price / no discount shown
  price_new   REAL    NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 0
);

INSERT INTO offers (id, sub_item_id, emoji, price_old, price_new, active, sort_order)
  SELECT id, sub_item_id, emoji, price_old, price_new, active, sort_order FROM offers_old;

DROP TABLE offers_old;

CREATE INDEX idx_offers_sub ON offers(sub_item_id);
