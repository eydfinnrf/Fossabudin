/**
 * Fossabudin catalog API (Cloudflare Worker + D1).
 *
 * Public:
 *   GET  /catalog            -> in-stock catalog as nested JSON (for the website)
 *   GET  /offers             -> active "Ja Takk Tilboð" offers (frontpage section)
 *
 * Admin (require  Authorization: Bearer <ADMIN_TOKEN>):
 *   GET  /admin/catalog      -> full catalog incl. out-of-stock items
 *   POST /admin/toggle       -> { kind:'product'|'sub_item', id, in_stock:0|1 }
 *   POST /admin/category     -> { name, emoji }                      (add)
 *   POST /admin/product      -> { category_id, name, emoji, type }   (add)
 *   POST /admin/sub-item     -> { product_id, name }                 (add)
 *   PATCH /admin/product/:id -> { name?, emoji? }                    (rename/edit)
 *   PATCH /admin/sub-item/:id-> { name? }
 *   DELETE /admin/product/:id
 *   DELETE /admin/sub-item/:id
 *   GET  /admin/offers       -> all offers incl. switched-off ones
 *   POST /admin/offer        -> { sub_item_id, price_old, price_new, emoji? }
 *   PATCH /admin/offer/:id   -> { price_old?, price_new?, emoji?, active? }
 *   DELETE /admin/offer/:id
 *
 * All customer-facing names are Faroese — pass them through unchanged.
 */

import ADMIN_HTML from "./admin-page.html";

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...cors(), ...extra },
  });

const cors = () => ({
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
  "access-control-allow-headers": "content-type,authorization",
});

const authed = (request, env) => {
  const h = request.headers.get("authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  return env.ADMIN_TOKEN && token === env.ADMIN_TOKEN;
};

/** Build the nested catalog. onlyInStock=true drops hidden products/sub-items. */
async function buildCatalog(env, onlyInStock) {
  const catFilter = "";
  const prodFilter = onlyInStock ? "WHERE in_stock = 1" : "";
  const subFilter = onlyInStock ? "WHERE in_stock = 1" : "";

  const [cats, prods, subs] = await Promise.all([
    env.DB.prepare(`SELECT id, name, emoji, sort_order FROM categories ${catFilter} ORDER BY sort_order, id`).all(),
    env.DB.prepare(`SELECT id, category_id, name, emoji, type, sort_order, in_stock FROM products ${prodFilter} ORDER BY sort_order, id`).all(),
    env.DB.prepare(`SELECT id, product_id, name, sort_order, in_stock FROM sub_items ${subFilter} ORDER BY sort_order, id`).all(),
  ]);

  const subsByProduct = new Map();
  for (const s of subs.results) {
    if (!subsByProduct.has(s.product_id)) subsByProduct.set(s.product_id, []);
    subsByProduct.get(s.product_id).push({
      id: s.id, name: s.name, in_stock: !!s.in_stock,
    });
  }

  const prodsByCat = new Map();
  for (const p of prods.results) {
    const subItems = subsByProduct.get(p.id) || [];
    // an expandable product with no visible sub-items is not orderable -> skip when public
    if (onlyInStock && p.type === "expandable" && subItems.length === 0) continue;
    if (!prodsByCat.has(p.category_id)) prodsByCat.set(p.category_id, []);
    prodsByCat.get(p.category_id).push({
      id: p.id, name: p.name, emoji: p.emoji, type: p.type,
      in_stock: !!p.in_stock, sub_items: subItems,
    });
  }

  const out = [];
  for (const c of cats.results) {
    const products = prodsByCat.get(c.id) || [];
    if (onlyInStock && products.length === 0) continue;
    out.push({ id: c.id, name: c.name, emoji: c.emoji, products });
  }
  return out;
}

/**
 * Build the "Ja Takk Tilboð" list.
 *
 * The offer name/emoji come from the catalog at read time, so a rename in the
 * catalog shows up here too. Offers are NOT filtered by in_stock — the owner
 * chose to control them purely by hand (the switch / the bin), so an offer only
 * disappears when it is switched off or deleted.
 *
 * onlyActive=true -> what the website shows; false -> the admin list.
 */
async function buildOffers(env, onlyActive) {
  const where = onlyActive ? "WHERE o.active = 1" : "";
  const rows = await env.DB.prepare(
    `SELECT o.id, o.sub_item_id, o.price_old, o.price_new, o.active, o.sort_order,
            COALESCE(o.emoji, p.emoji, c.emoji) AS emoji,
            s.name AS name, s.in_stock AS in_stock,
            o.emoji AS emoji_override,
            c.name AS category_name
       FROM offers o
       JOIN sub_items  s ON s.id = o.sub_item_id
       JOIN products   p ON p.id = s.product_id
       JOIN categories c ON c.id = p.category_id
       ${where}
      ORDER BY o.sort_order, o.id`
  ).all();

  return rows.results.map(r => ({
    id: r.id,
    sub_item_id: r.sub_item_id,
    name: r.name,
    emoji: r.emoji,
    emoji_override: r.emoji_override,
    category_name: r.category_name,
    price_old: r.price_old,
    price_new: r.price_new,
    pct: discountPct(r.price_old, r.price_new),
    active: !!r.active,
    in_stock: !!r.in_stock,
  }));
}

/** Whole-number discount percent, or null when it wouldn't make sense. */
function discountPct(oldP, newP) {
  const o = Number(oldP), n = Number(newP);
  if (!(o > 0) || !(n >= 0) || n >= o) return null;
  return Math.round(((o - n) / o) * 100);
}

/** Parse a price typed by a Faroese user: accepts "12,50" as well as "12.50". */
function parsePrice(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(",", ".").trim());
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method.toUpperCase();

    if (method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });

    // On the admin hostname, send the bare root straight to the login page.
    if (url.hostname === "admin.fossabudin.fo" && path === "/" && method === "GET") {
      return Response.redirect(url.origin + "/admin", 302);
    }

    // ---- public ----
    if (path === "/catalog" && method === "GET") {
      try {
        const catalog = await buildCatalog(env, true);
        return json({ ok: true, catalog }, 200, {
          "cache-control": "public, max-age=60",
        });
      } catch (e) {
        return json({ ok: false, error: String(e) }, 500);
      }
    }

    if (path === "/offers" && method === "GET") {
      try {
        const offers = await buildOffers(env, true);
        return json({ ok: true, offers }, 200, {
          "cache-control": "public, max-age=60",
        });
      } catch (e) {
        return json({ ok: false, error: String(e) }, 500);
      }
    }

    if (path === "/" && method === "GET") {
      return json({ ok: true, service: "fossabudin-api", endpoints: ["/catalog", "/offers"] });
    }

    // Admin UI page — public HTML (a login screen); every ACTION it performs
    // still requires the bearer token, so serving the page is harmless.
    if (path === "/admin" && method === "GET") {
      return new Response(ADMIN_HTML, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", ...cors() },
      });
    }

    // ---- admin API (token required) ----
    if (path.startsWith("/admin")) {
      if (!authed(request, env)) return json({ ok: false, error: "unauthorized" }, 401);
      try {
        return await handleAdmin(path, method, request, env);
      } catch (e) {
        return json({ ok: false, error: String(e) }, 500);
      }
    }

    return json({ ok: false, error: "not found" }, 404);
  },
};

async function handleAdmin(path, method, request, env) {
  const body = method === "GET" ? {} : await request.json().catch(() => ({}));

  if (path === "/admin/catalog" && method === "GET") {
    return json({ ok: true, catalog: await buildCatalog(env, false) });
  }

  if (path === "/admin/toggle" && method === "POST") {
    const { kind, id, in_stock } = body;
    const table = kind === "product" ? "products" : kind === "sub_item" ? "sub_items" : null;
    if (!table || !id) return json({ ok: false, error: "bad request" }, 400);
    await env.DB.prepare(`UPDATE ${table} SET in_stock = ? WHERE id = ?`)
      .bind(in_stock ? 1 : 0, id).run();
    return json({ ok: true });
  }

  if (path === "/admin/category" && method === "POST") {
    const { name, emoji } = body;
    if (!name) return json({ ok: false, error: "name required" }, 400);
    const next = await nextSort(env, "categories", null);
    const r = await env.DB.prepare(
      "INSERT INTO categories (name, emoji, sort_order) VALUES (?, ?, ?)")
      .bind(name, emoji ?? null, next).run();
    return json({ ok: true, id: r.meta.last_row_id });
  }

  /* Reorder categories. Takes the full ordered id list and rewrites sort_order
     to 1..N, so it also normalises the duplicate/zero values that "append at
     MAX+1" leaves behind. Whole-list rather than a swap: a swap between two rows
     that share a sort_order silently does nothing. */
  if (path === "/admin/categories/reorder" && method === "POST") {
    const ids = Array.isArray(body.ids) ? body.ids.map(Number) : null;
    if (!ids || !ids.length || ids.some((n) => !Number.isInteger(n) || n <= 0)) {
      return json({ ok: false, error: "ids must be a non-empty array of category ids" }, 400);
    }
    if (new Set(ids).size !== ids.length) {
      return json({ ok: false, error: "ids contains duplicates" }, 400);
    }
    // Demand every category exactly once, so a stale admin page cannot drop one
    // out of the ordering and leave sort_order half written.
    const existing = await env.DB.prepare("SELECT id FROM categories").all();
    const have = existing.results.map((r) => r.id).sort((a, b) => a - b);
    const want = [...ids].sort((a, b) => a - b);
    if (have.length !== want.length || have.some((v, i) => v !== want[i])) {
      return json({ ok: false, error: "ids must list every category exactly once" }, 400);
    }
    await env.DB.batch(ids.map((id, i) =>
      env.DB.prepare("UPDATE categories SET sort_order = ? WHERE id = ?").bind(i + 1, id)));
    return json({ ok: true, count: ids.length });
  }

  if (path === "/admin/product" && method === "POST") {
    const { category_id, name, emoji, type } = body;
    if (!category_id || !name) return json({ ok: false, error: "category_id and name required" }, 400);
    const next = await nextSort(env, "products", ["category_id", category_id]);
    const r = await env.DB.prepare(
      "INSERT INTO products (category_id, name, emoji, type, sort_order, in_stock) VALUES (?, ?, ?, ?, ?, 1)")
      .bind(category_id, name, emoji ?? null, type === "simple" ? "simple" : "expandable", next).run();
    return json({ ok: true, id: r.meta.last_row_id });
  }

  if (path === "/admin/sub-item" && method === "POST") {
    const { product_id, name } = body;
    if (!product_id || !name) return json({ ok: false, error: "product_id and name required" }, 400);
    const next = await nextSort(env, "sub_items", ["product_id", product_id]);
    const r = await env.DB.prepare(
      "INSERT INTO sub_items (product_id, name, sort_order, in_stock) VALUES (?, ?, ?, 1)")
      .bind(product_id, name, next).run();
    return json({ ok: true, id: r.meta.last_row_id });
  }

  /* ---- Ja Takk Tilboð ---- */

  if (path === "/admin/offers" && method === "GET") {
    return json({ ok: true, offers: await buildOffers(env, false) });
  }

  if (path === "/admin/offer" && method === "POST") {
    const { sub_item_id, emoji } = body;
    const priceOld = parsePrice(body.price_old);
    const priceNew = parsePrice(body.price_new);
    if (!sub_item_id) return json({ ok: false, error: "sub_item_id required" }, 400);
    if (priceOld === null || priceNew === null) {
      return json({ ok: false, error: "price_old and price_new must be numbers" }, 400);
    }
    // The sub-item must exist, otherwise the offer would render as a blank card.
    const sub = await env.DB.prepare("SELECT id FROM sub_items WHERE id = ?").bind(sub_item_id).first();
    if (!sub) return json({ ok: false, error: "sub_item not found" }, 404);
    // One offer per product — re-adding the same product edits the existing offer.
    const existing = await env.DB.prepare("SELECT id FROM offers WHERE sub_item_id = ?").bind(sub_item_id).first();
    if (existing) {
      await env.DB.prepare(
        "UPDATE offers SET price_old = ?, price_new = ?, emoji = ?, active = 1 WHERE id = ?")
        .bind(priceOld, priceNew, emoji || null, existing.id).run();
      return json({ ok: true, id: existing.id, replaced: true });
    }
    const next = await nextSort(env, "offers", null);
    const r = await env.DB.prepare(
      "INSERT INTO offers (sub_item_id, emoji, price_old, price_new, active, sort_order) VALUES (?, ?, ?, ?, 1, ?)")
      .bind(sub_item_id, emoji || null, priceOld, priceNew, next).run();
    return json({ ok: true, id: r.meta.last_row_id });
  }

  const patchOffer = path.match(/^\/admin\/offer\/(\d+)$/);
  if (patchOffer && method === "PATCH") {
    const id = Number(patchOffer[1]);
    const sets = [], vals = [];
    if (body.price_old !== undefined) {
      const v = parsePrice(body.price_old);
      if (v === null) return json({ ok: false, error: "bad price_old" }, 400);
      sets.push("price_old = ?"); vals.push(v);
    }
    if (body.price_new !== undefined) {
      const v = parsePrice(body.price_new);
      if (v === null) return json({ ok: false, error: "bad price_new" }, 400);
      sets.push("price_new = ?"); vals.push(v);
    }
    if (body.emoji !== undefined) { sets.push("emoji = ?"); vals.push(body.emoji || null); }
    if (body.active !== undefined) { sets.push("active = ?"); vals.push(body.active ? 1 : 0); }
    if (!sets.length) return json({ ok: false, error: "nothing to update" }, 400);
    vals.push(id);
    await env.DB.prepare(`UPDATE offers SET ${sets.join(", ")} WHERE id = ?`).bind(...vals).run();
    return json({ ok: true });
  }

  const delOffer = path.match(/^\/admin\/offer\/(\d+)$/);
  if (delOffer && method === "DELETE") {
    await env.DB.prepare("DELETE FROM offers WHERE id = ?").bind(Number(delOffer[1])).run();
    return json({ ok: true });
  }

  const patchProd = path.match(/^\/admin\/product\/(\d+)$/);
  if (patchProd && method === "PATCH") {
    const id = Number(patchProd[1]);
    const sets = [], vals = [];
    if (body.name != null) { sets.push("name = ?"); vals.push(body.name); }
    if (body.emoji !== undefined) { sets.push("emoji = ?"); vals.push(body.emoji); }
    if (!sets.length) return json({ ok: false, error: "nothing to update" }, 400);
    vals.push(id);
    await env.DB.prepare(`UPDATE products SET ${sets.join(", ")} WHERE id = ?`).bind(...vals).run();
    return json({ ok: true });
  }

  const patchSub = path.match(/^\/admin\/sub-item\/(\d+)$/);
  if (patchSub && method === "PATCH") {
    const id = Number(patchSub[1]);
    if (body.name == null) return json({ ok: false, error: "name required" }, 400);
    await env.DB.prepare("UPDATE sub_items SET name = ? WHERE id = ?").bind(body.name, id).run();
    return json({ ok: true });
  }

  const patchCat = path.match(/^\/admin\/category\/(\d+)$/);
  if (patchCat && method === "PATCH") {
    const id = Number(patchCat[1]);
    const sets = [], vals = [];
    if (body.name != null) { sets.push("name = ?"); vals.push(body.name); }
    if (body.emoji !== undefined) { sets.push("emoji = ?"); vals.push(body.emoji); }
    if (!sets.length) return json({ ok: false, error: "nothing to update" }, 400);
    vals.push(id);
    await env.DB.prepare(`UPDATE categories SET ${sets.join(", ")} WHERE id = ?`).bind(...vals).run();
    return json({ ok: true });
  }

  // Deletes remove children explicitly (D1 does not enforce FK cascade by default).
  const delProd = path.match(/^\/admin\/product\/(\d+)$/);
  if (delProd && method === "DELETE") {
    const id = Number(delProd[1]);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM offers WHERE sub_item_id IN (SELECT id FROM sub_items WHERE product_id = ?)").bind(id),
      env.DB.prepare("DELETE FROM sub_items WHERE product_id = ?").bind(id),
      env.DB.prepare("DELETE FROM products WHERE id = ?").bind(id),
    ]);
    return json({ ok: true });
  }

  const delSub = path.match(/^\/admin\/sub-item\/(\d+)$/);
  if (delSub && method === "DELETE") {
    const id = Number(delSub[1]);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM offers WHERE sub_item_id = ?").bind(id),
      env.DB.prepare("DELETE FROM sub_items WHERE id = ?").bind(id),
    ]);
    return json({ ok: true });
  }

  const delCat = path.match(/^\/admin\/category\/(\d+)$/);
  if (delCat && method === "DELETE") {
    const id = Number(delCat[1]);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM offers WHERE sub_item_id IN (SELECT id FROM sub_items WHERE product_id IN (SELECT id FROM products WHERE category_id = ?))").bind(id),
      env.DB.prepare("DELETE FROM sub_items WHERE product_id IN (SELECT id FROM products WHERE category_id = ?)").bind(id),
      env.DB.prepare("DELETE FROM products WHERE category_id = ?").bind(id),
      env.DB.prepare("DELETE FROM categories WHERE id = ?").bind(id),
    ]);
    return json({ ok: true });
  }

  return json({ ok: false, error: "not found" }, 404);
}

/** next sort_order value for append, optionally scoped by a [column, value] pair. */
async function nextSort(env, table, scope) {
  const where = scope ? `WHERE ${scope[0]} = ?` : "";
  const stmt = env.DB.prepare(`SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM ${table} ${where}`);
  const row = await (scope ? stmt.bind(scope[1]) : stmt).first();
  return row.n;
}
