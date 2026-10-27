import express from "express";
import pg from "pg";

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT || 3000);
const SECRET = (
  process.env.MCARIS_PRICE_STOCK_SECRET ||
  process.env.MCARIS_PAZARAMA_RELAY_SECRET ||
  ""
).trim();
const DATABASE_URL = (process.env.DATABASE_URL || "").trim();

if (!DATABASE_URL) {
  console.error("DATABASE_URL missing");
  process.exit(1);
}
if (!SECRET) {
  console.error("MCARIS_PRICE_STOCK_SECRET missing");
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes("sslmode=require")
    ? { rejectUnauthorized: false }
    : undefined,
  max: 5,
});

function unauthorized() {
  return { status: 401, body: { ok: false, error: "unauthorized" } };
}

function parsePrice(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).trim().replace(",", "."));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function parseStock(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).trim().replace(",", "."));
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.max(0, Math.floor(n));
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "mcaris-shop-price-stock" });
});

app.post("/api/internal/price-stock", async (req, res) => {
  const provided = String(req.header("x-mcaris-relay-key") || "").trim();
  if (!provided || provided !== SECRET) {
    const u = unauthorized();
    return res.status(u.status).json(u.body);
  }

  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (items.length === 0) {
    return res.status(400).json({ ok: false, error: "items_required" });
  }
  if (items.length > 100) {
    return res.status(400).json({ ok: false, error: "too_many_items" });
  }

  const results = [];
  let updated = 0;
  let failed = 0;

  for (const item of items) {
    const sku = String(item?.sku || "").trim().toUpperCase();
    if (!sku) {
      failed++;
      results.push({ ok: false, sku: "", error: "sku_required" });
      continue;
    }
    const price = parsePrice(item.price);
    const stock = parseStock(item.stock);
    if (price === null && stock === null) {
      failed++;
      results.push({ ok: false, sku, error: "price_or_stock_required" });
      continue;
    }

    try {
      const found = await pool.query(
        `SELECT id, sku, slug, price::float8 AS price, stock
         FROM "Product"
         WHERE UPPER(sku) = $1
         LIMIT 1`,
        [sku]
      );
      if (!found.rowCount) {
        failed++;
        results.push({ ok: false, sku, error: "not_found" });
        continue;
      }
      const product = found.rows[0];
      const sets = [];
      const params = [];
      if (price !== null) {
        params.push(price);
        sets.push(`price = $${params.length}`);
      }
      if (stock !== null) {
        params.push(stock);
        sets.push(`stock = $${params.length}`);
      }
      params.push(product.id);
      const saved = await pool.query(
        `UPDATE "Product"
         SET ${sets.join(", ")}, "updatedAt" = NOW()
         WHERE id = $${params.length}
         RETURNING id, sku, slug, price::float8 AS price, stock`,
        params
      );
      const row = saved.rows[0];
      updated++;
      results.push({
        ok: true,
        sku: row.sku || sku,
        id: row.id,
        price: Number(row.price),
        stock: row.stock,
      });
    } catch (err) {
      failed++;
      results.push({
        ok: false,
        sku,
        error: String(err?.message || "update_failed").slice(0, 160),
      });
    }
  }

  res.json({
    ok: failed === 0 && updated > 0,
    updated,
    failed,
    results,
  });
});

app.listen(PORT, () => {
  console.log(`mcaris-shop-price-stock on :${PORT}`);
});
