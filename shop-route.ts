import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type ItemIn = {
  sku?: string;
  price?: number | string | null;
  stock?: number | string | null;
};

function unauthorized() {
  return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
}

function badRequest(message: string) {
  return NextResponse.json({ ok: false, error: message }, { status: 400 });
}

function relaySecret(): string {
  return (
    process.env.MCARIS_PRICE_STOCK_SECRET ||
    process.env.MCARIS_PAZARAMA_RELAY_SECRET ||
    "ea313ea8a58d6b92ceec34a4ef4dcc00537af7d23a850f8e"
  ).trim();
}

function normSku(raw: string): string {
  return raw.trim().toUpperCase();
}

function parsePrice(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number" && Number.isFinite(v)) {
    return Math.max(0, Math.round((v + Number.EPSILON) * 100) / 100);
  }
  const s = String(v).trim().replace(/\s/g, "").replace(",", ".");
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.max(0, Math.round((n + Number.EPSILON) * 100) / 100);
}

function parseStock(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).trim().replace(",", "."));
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.max(0, Math.floor(n));
}

export async function POST(request: Request) {
  const secret = relaySecret();
  const provided = (request.headers.get("x-mcaris-relay-key") || "").trim();
  if (!secret || !provided || provided !== secret) {
    return unauthorized();
  }

  let payload: { items?: ItemIn[] };
  try {
    payload = await request.json();
  } catch {
    return badRequest("invalid_json");
  }

  const items = Array.isArray(payload.items) ? payload.items : [];
  if (items.length === 0) {
    return badRequest("items_required");
  }
  if (items.length > 100) {
    return badRequest("too_many_items");
  }

  const results: Array<Record<string, unknown>> = [];
  let updated = 0;
  let failed = 0;
  const slugs = new Set<string>();

  for (const item of items) {
    const sku = normSku(String(item?.sku || ""));
    if (sku === "") {
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
      const product = await prisma.product.findFirst({
        where: { sku: { equals: sku, mode: "insensitive" } },
        select: { id: true, sku: true, slug: true, price: true, stock: true },
      });
      if (!product) {
        failed++;
        results.push({ ok: false, sku, error: "not_found" });
        continue;
      }

      const data: Prisma.ProductUpdateInput = {};
      if (price !== null) data.price = new Prisma.Decimal(price);
      if (stock !== null) data.stock = stock;

      const saved = await prisma.product.update({
        where: { id: product.id },
        data,
        select: { id: true, sku: true, slug: true, price: true, stock: true },
      });

      if (saved.slug) slugs.add(saved.slug);
      updated++;
      results.push({
        ok: true,
        sku: saved.sku || sku,
        id: saved.id,
        price: Number(saved.price),
        stock: saved.stock,
      });
    } catch (error) {
      failed++;
      const message = error instanceof Error ? error.message : "update_failed";
      results.push({ ok: false, sku, error: message.slice(0, 160) });
    }
  }

  try {
    revalidatePath("/admin/urunler");
    revalidatePath("/urunler");
    revalidatePath("/feed.xml");
    revalidatePath("/products.xml");
    for (const slug of slugs) {
      revalidatePath(`/urun/${slug}`);
    }
  } catch {
    // revalidate best-effort
  }

  return NextResponse.json(
    {
      ok: failed === 0 && updated > 0,
      updated,
      failed,
      results,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
