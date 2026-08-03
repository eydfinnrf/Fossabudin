/**
 * Fossabudin catalog API (Cloudflare Worker + D1).
 *
 * Public:
 *   GET  /catalog            -> in-stock catalog as nested JSON (for the website)
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method.toUpperCase();

    if (method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });

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

    if (path === "/" && method === "GET") {
      return json({ ok: true, service: "fossabudin-api", endpoints: ["/catalog"] });
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
      env.DB.prepare("DELETE FROM sub_items WHERE product_id = ?").bind(id),
      env.DB.prepare("DELETE FROM products WHERE id = ?").bind(id),
    ]);
    return json({ ok: true });
  }

  const delSub = path.match(/^\/admin\/sub-item\/(\d+)$/);
  if (delSub && method === "DELETE") {
    await env.DB.prepare("DELETE FROM sub_items WHERE id = ?").bind(Number(delSub[1])).run();
    return json({ ok: true });
  }

  const delCat = path.match(/^\/admin\/category\/(\d+)$/);
  if (delCat && method === "DELETE") {
    const id = Number(delCat[1]);
    await env.DB.batch([
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
