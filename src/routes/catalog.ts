import { Hono } from 'hono';
import { getDb } from '../db';
import { authMiddleware, adminOnly } from '../middleware/auth';
import { ApiError, uuid, now, type Env, type AuthContext } from '../types';

// ============================================================
// CATALOG ROUTES (Products & Variants)
// ============================================================

const catalogRoutes = new Hono<{
  Bindings: Env;
  Variables: { auth: AuthContext };
}>();

catalogRoutes.use('*', authMiddleware);

// GET /v1/products
catalogRoutes.get('/', async (c) => {
  const { store } = c.get('auth');
  const db = getDb(c.env);

  // Pagination params
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 100);
  const cursor = c.req.query('cursor');
  const status = c.req.query('status'); // Filter by status

  // Build query
  let query = `SELECT * FROM products WHERE store_id = ?`;
  const params: unknown[] = [store.id];

  if (status) {
    query += ` AND status = ?`;
    params.push(status);
  }

  if (cursor) {
    query += ` AND created_at < ?`;
    params.push(cursor);
  }

  query += ` ORDER BY created_at DESC LIMIT ?`;
  params.push(limit + 1); // Fetch one extra to check for next page

  const products = await db.query<any>(query, params);

  // Check if there's a next page
  const hasMore = products.length > limit;
  if (hasMore) products.pop();

  // Batch fetch all variants for these products (avoids N+1 query)
  const productIds = products.map((p) => p.id);
  let variantsByProduct: Record<string, any[]> = {};
  
  if (productIds.length > 0) {
    const placeholders = productIds.map(() => '?').join(',');
    const allVariants = await db.query<any>(
      `SELECT * FROM variants WHERE product_id IN (${placeholders}) ORDER BY created_at ASC`,
      productIds
    );
    
    // Group variants by product_id
    for (const v of allVariants) {
      if (!variantsByProduct[v.product_id]) {
        variantsByProduct[v.product_id] = [];
      }
      variantsByProduct[v.product_id].push(v);
    }
  }

  const items = products.map((p) => ({
    id: p.id,
    title: p.title,
    description: p.description,
    status: p.status,
    created_at: p.created_at,
    variants: (variantsByProduct[p.id] || []).map((v) => ({
      id: v.id,
      sku: v.sku,
      title: v.title,
      price_cents: v.price_cents,
      image_url: v.image_url,
    })),
  }));

  const nextCursor = hasMore && items.length > 0 ? items[items.length - 1].created_at : null;

  return c.json({
    items,
    pagination: {
      has_more: hasMore,
      next_cursor: nextCursor,
    },
  });
});

// GET /v1/products/:id
catalogRoutes.get('/:id', async (c) => {
  const { store } = c.get('auth');
  const db = getDb(c.env);
  const id = c.req.param('id');

  const [product] = await db.query<any>(
    `SELECT * FROM products WHERE id = ? AND store_id = ?`,
    [id, store.id]
  );

  if (!product) throw ApiError.notFound('Product not found');

  const variants = await db.query<any>(
    `SELECT * FROM variants WHERE product_id = ? ORDER BY created_at ASC`,
    [id]
  );

  return c.json({
    id: product.id,
    title: product.title,
    description: product.description,
    status: product.status,
    created_at: product.created_at,
    variants: variants.map((v) => ({
      id: v.id,
      sku: v.sku,
      title: v.title,
      price_cents: v.price_cents,
      image_url: v.image_url,
    })),
  });
});

// POST /v1/products (admin only)
catalogRoutes.post('/', adminOnly, async (c) => {
  const body = await c.req.json();
  const { title, description } = body;

  if (!title) throw ApiError.invalidRequest('title is required');

  const { store } = c.get('auth');
  const db = getDb(c.env);

  const id = uuid();
  const timestamp = now();

  await db.run(
    `INSERT INTO products (id, store_id, title, description, status, created_at)
     VALUES (?, ?, ?, ?, 'active', ?)`,
    [id, store.id, title, description || null, timestamp]
  );

  return c.json({ id, title, description: description || null, status: 'active', variants: [] }, 201);
});

// PATCH /v1/products/:id (admin only)
catalogRoutes.patch('/:id', adminOnly, async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const { title, description, status } = body;

  const { store } = c.get('auth');
  const db = getDb(c.env);

  const [existing] = await db.query<any>(
    `SELECT * FROM products WHERE id = ? AND store_id = ?`,
    [id, store.id]
  );

  if (!existing) throw ApiError.notFound('Product not found');

  const updates: string[] = [];
  const params: unknown[] = [];

  if (title !== undefined) {
    updates.push('title = ?');
    params.push(title);
  }
  if (description !== undefined) {
    updates.push('description = ?');
    params.push(description);
  }
  if (status !== undefined) {
    if (!['active', 'draft'].includes(status)) {
      throw ApiError.invalidRequest('status must be active or draft');
    }
    updates.push('status = ?');
    params.push(status);
  }

  if (updates.length > 0) {
    params.push(id);
    params.push(store.id);

    await db.run(
      `UPDATE products SET ${updates.join(', ')} WHERE id = ? AND store_id = ?`,
      params
    );
  }

  const [product] = await db.query<any>(
    `SELECT * FROM products WHERE id = ? AND store_id = ?`,
    [id, store.id]
  );

  const variants = await db.query<any>(
    `SELECT * FROM variants WHERE product_id = ?`,
    [id]
  );

  return c.json({
    id: product.id,
    title: product.title,
    description: product.description,
    status: product.status,
    variants: variants.map((v) => ({
      id: v.id,
      sku: v.sku,
      title: v.title,
      price_cents: v.price_cents,
      image_url: v.image_url,
    })),
  });
});

// POST /v1/products/:id/variants (admin only)
catalogRoutes.post('/:id/variants', adminOnly, async (c) => {
  const productId = c.req.param('id');
  const body = await c.req.json();
  const { sku, title, price_cents, image_url } = body;

  if (!sku) throw ApiError.invalidRequest('sku is required');
  if (!title) throw ApiError.invalidRequest('title is required');
  if (typeof price_cents !== 'number' || price_cents < 0) {
    throw ApiError.invalidRequest('price_cents must be a positive number');
  }

  const { store } = c.get('auth');
  const db = getDb(c.env);

  // Check product exists
  const [product] = await db.query<any>(
    `SELECT * FROM products WHERE id = ? AND store_id = ?`,
    [productId, store.id]
  );
  if (!product) throw ApiError.notFound('Product not found');

  // Check SKU uniqueness for this store
  const [existingSku] = await db.query<any>(
    `SELECT * FROM variants WHERE sku = ? AND store_id = ?`,
    [sku, store.id]
  );
  if (existingSku) throw ApiError.conflict(`SKU ${sku} already exists`);

  const id = uuid();
  const timestamp = now();

  // Insert variant (with required fields)
  await db.run(
    `INSERT INTO variants (id, product_id, store_id, sku, title, price_cents, weight_g, image_url, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, productId, store.id, sku, title, price_cents, 0, image_url || null, timestamp]
  );

  // Create inventory record
  await db.run(
    `INSERT INTO inventory (id, store_id, sku, on_hand, reserved, updated_at)
     VALUES (?, ?, ?, 0, 0, ?)`,
    [uuid(), store.id, sku, timestamp]
  );

  return c.json({ id, sku, title, price_cents, image_url: image_url || null }, 201);
});

// PATCH /v1/products/:id/variants/:variantId (admin only)
catalogRoutes.patch('/:id/variants/:variantId', adminOnly, async (c) => {
  const productId = c.req.param('id');
  const variantId = c.req.param('variantId');
  const body = await c.req.json();
  const { sku, title, price_cents, image_url } = body;

  const { store } = c.get('auth');
  const db = getDb(c.env);

  // Check variant exists and belongs to product/store
  const [existing] = await db.query<any>(
    `SELECT * FROM variants WHERE id = ? AND product_id = ? AND store_id = ?`,
    [variantId, productId, store.id]
  );
  if (!existing) throw ApiError.notFound('Variant not found');

  const updates: string[] = [];
  const params: unknown[] = [];

  if (sku !== undefined) {
    // Check SKU uniqueness (excluding this variant)
    const [existingSku] = await db.query<any>(
      `SELECT * FROM variants WHERE sku = ? AND store_id = ? AND id != ?`,
      [sku, store.id, variantId]
    );
    if (existingSku) throw ApiError.conflict(`SKU ${sku} already exists`);

    // Update inventory SKU as well
    await db.run(
      `UPDATE inventory SET sku = ? WHERE sku = ? AND store_id = ?`,
      [sku, existing.sku, store.id]
    );

    updates.push('sku = ?');
    params.push(sku);
  }
  if (title !== undefined) {
    updates.push('title = ?');
    params.push(title);
  }
  if (price_cents !== undefined) {
    if (typeof price_cents !== 'number' || price_cents < 0) {
      throw ApiError.invalidRequest('price_cents must be a positive number');
    }
    updates.push('price_cents = ?');
    params.push(price_cents);
  }
  if (image_url !== undefined) {
    updates.push('image_url = ?');
    params.push(image_url);
  }

  if (updates.length > 0) {
    params.push(variantId);
    await db.run(`UPDATE variants SET ${updates.join(', ')} WHERE id = ?`, params);
  }

  const [variant] = await db.query<any>(`SELECT * FROM variants WHERE id = ?`, [variantId]);

  return c.json({
    id: variant.id,
    sku: variant.sku,
    title: variant.title,
    price_cents: variant.price_cents,
    image_url: variant.image_url,
  });
});

// DELETE /v1/products/:id (admin only)
catalogRoutes.delete('/:id', adminOnly, async (c) => {
  const id = c.req.param('id');
  const { store } = c.get('auth');
  const db = getDb(c.env);

  const [product] = await db.query<any>(
    `SELECT * FROM products WHERE id = ? AND store_id = ?`,
    [id, store.id]
  );
  if (!product) throw ApiError.notFound('Product not found');

  // Check if any variants have been used in orders
  const variants = await db.query<any>(
    `SELECT sku FROM variants WHERE product_id = ?`,
    [id]
  );
  
  if (variants.length > 0) {
    const skus = variants.map((v) => v.sku);
    const placeholders = skus.map(() => '?').join(',');
    const [orderItem] = await db.query<any>(
      `SELECT id FROM order_items WHERE sku IN (${placeholders}) LIMIT 1`,
      skus
    );
    
    if (orderItem) {
      throw ApiError.conflict('Cannot delete product with variants that have been ordered. Set status to draft instead.');
    }
  }

  // Delete inventory records for all variants
  for (const v of variants) {
    await db.run(`DELETE FROM inventory WHERE sku = ? AND store_id = ?`, [v.sku, store.id]);
  }

  // Delete variants
  await db.run(`DELETE FROM variants WHERE product_id = ?`, [id]);
  
  // Delete product
  await db.run(`DELETE FROM products WHERE id = ?`, [id]);

  return c.json({ deleted: true });
});

// DELETE /v1/products/:id/variants/:variantId (admin only)
catalogRoutes.delete('/:id/variants/:variantId', adminOnly, async (c) => {
  const productId = c.req.param('id');
  const variantId = c.req.param('variantId');
  const { store } = c.get('auth');
  const db = getDb(c.env);

  const [variant] = await db.query<any>(
    `SELECT * FROM variants WHERE id = ? AND product_id = ? AND store_id = ?`,
    [variantId, productId, store.id]
  );
  if (!variant) throw ApiError.notFound('Variant not found');

  // Check if variant has been used in any orders
  const [orderItem] = await db.query<any>(
    `SELECT id FROM order_items WHERE sku = ? LIMIT 1`,
    [variant.sku]
  );
  
  if (orderItem) {
    throw ApiError.conflict('Cannot delete variant that has been ordered. Set product status to draft instead.');
  }

  // Delete inventory record
  await db.run(`DELETE FROM inventory WHERE sku = ? AND store_id = ?`, [variant.sku, store.id]);
  
  // Delete variant
  await db.run(`DELETE FROM variants WHERE id = ?`, [variantId]);

  return c.json({ deleted: true });
});

export { catalogRoutes as catalog };
