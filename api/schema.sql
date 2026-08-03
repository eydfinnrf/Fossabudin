-- Fossabudin catalog schema (Cloudflare D1 / SQLite)
-- Three levels: categories -> products -> sub_items.
-- in_stock lives on both products and sub_items so the shop can hide a whole
-- product OR a single variant. All customer-facing text is Faroese.

DROP TABLE IF EXISTS sub_items;
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS categories;

CREATE TABLE categories (
  id         INTEGER PRIMARY KEY,
  name       TEXT    NOT NULL,
  emoji      TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE products (
  id          INTEGER PRIMARY KEY,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  emoji       TEXT,
  type        TEXT    NOT NULL DEFAULT 'expandable', -- 'expandable' | 'simple'
  sort_order  INTEGER NOT NULL DEFAULT 0,
  in_stock    INTEGER NOT NULL DEFAULT 1             -- 1 = shown, 0 = hidden
);

CREATE TABLE sub_items (
  id         INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name       TEXT    NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  in_stock   INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX idx_products_cat  ON products(category_id);
CREATE INDEX idx_subitems_prod ON sub_items(product_id);
