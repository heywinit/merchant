import { Hono } from 'hono';
import { getDb } from '../db';
import { ApiError, type Env, type AuthContext, now } from '../types';
import { authMiddleware, adminOnly } from '../middleware/auth';

// ============================================================
// CUSTOMER ROUTES
// ============================================================

export const customers = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>();

// All customer routes require admin auth
customers.use('*', authMiddleware, adminOnly);

// ------------------------------------------------------------
// GET /v1/customers - List customers with pagination
// ------------------------------------------------------------
customers.get('/', async (c) => {
  const { store } = c.get('auth');
  const db = getDb(c.env);

  const limit = Math.min(Number(c.req.query('limit')) || 50, 100);
  const cursor = c.req.query('cursor');
  const search = c.req.query('search');

  let query = `SELECT * FROM customers WHERE store_id = ?`;
  const params: any[] = [store.id];

  // Search by email or name
  if (search) {
    query += ` AND (email LIKE ? OR name LIKE ?)`;
    params.push(`%${search}%`, `%${search}%`);
  }

  // Cursor pagination
  if (cursor) {
    query += ` AND created_at < ?`;
    params.push(cursor);
  }

  query += ` ORDER BY created_at DESC LIMIT ?`;
  params.push(limit + 1);

  const rows = await db.query<any>(query, params);
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, -1) : rows;

  return c.json({
    items: items.map(formatCustomer),
    pagination: {
      has_more: hasMore,
      next_cursor: hasMore ? items[items.length - 1].created_at : null,
    },
  });
});

// ------------------------------------------------------------
// GET /v1/customers/:id - Get single customer with addresses
// ------------------------------------------------------------
customers.get('/:id', async (c) => {
  const { store } = c.get('auth');
  const db = getDb(c.env);
  const customerId = c.req.param('id');

  const [customer] = await db.query<any>(
    `SELECT * FROM customers WHERE id = ? AND store_id = ?`,
    [customerId, store.id]
  );

  if (!customer) throw ApiError.notFound('Customer');

  // Get addresses
  const addresses = await db.query<any>(
    `SELECT * FROM customer_addresses WHERE customer_id = ? ORDER BY is_default DESC, created_at DESC`,
    [customerId]
  );

  return c.json({
    ...formatCustomer(customer),
    addresses: addresses.map(formatAddress),
  });
});

// ------------------------------------------------------------
// GET /v1/customers/:id/orders - Get customer's order history
// ------------------------------------------------------------
customers.get('/:id/orders', async (c) => {
  const { store } = c.get('auth');
  const db = getDb(c.env);
  const customerId = c.req.param('id');

  const limit = Math.min(Number(c.req.query('limit')) || 20, 100);
  const cursor = c.req.query('cursor');

  // Verify customer exists and belongs to store
  const [customer] = await db.query<any>(
    `SELECT id FROM customers WHERE id = ? AND store_id = ?`,
    [customerId, store.id]
  );

  if (!customer) throw ApiError.notFound('Customer');

  let query = `SELECT * FROM orders WHERE customer_id = ?`;
  const params: any[] = [customerId];

  if (cursor) {
    query += ` AND created_at < ?`;
    params.push(cursor);
  }

  query += ` ORDER BY created_at DESC LIMIT ?`;
  params.push(limit + 1);

  const rows = await db.query<any>(query, params);
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, -1) : rows;

  // Batch fetch all order items (avoids N+1 query)
  const orderIds = items.map((o: any) => o.id);
  let itemsByOrder: Record<string, any[]> = {};
  
  if (orderIds.length > 0) {
    const placeholders = orderIds.map(() => '?').join(',');
    const allItems = await db.query<any>(
      `SELECT * FROM order_items WHERE order_id IN (${placeholders})`,
      orderIds
    );
    
    for (const item of allItems) {
      if (!itemsByOrder[item.order_id]) {
        itemsByOrder[item.order_id] = [];
      }
      itemsByOrder[item.order_id].push(item);
    }
  }

  const ordersWithItems = items.map((order: any) => ({
    ...order,
    items: itemsByOrder[order.id] || [],
  }));

  return c.json({
    items: ordersWithItems.map(formatOrder),
    pagination: {
      has_more: hasMore,
      next_cursor: hasMore ? items[items.length - 1].created_at : null,
    },
  });
});

// ------------------------------------------------------------
// PATCH /v1/customers/:id - Update customer
// ------------------------------------------------------------
customers.patch('/:id', async (c) => {
  const { store } = c.get('auth');
  const db = getDb(c.env);
  const customerId = c.req.param('id');
  const body = await c.req.json();

  const [customer] = await db.query<any>(
    `SELECT * FROM customers WHERE id = ? AND store_id = ?`,
    [customerId, store.id]
  );

  if (!customer) throw ApiError.notFound('Customer');

  // Allowed updates
  const updates: string[] = [];
  const params: any[] = [];

  if (body.name !== undefined) {
    updates.push('name = ?');
    params.push(body.name);
  }
  if (body.phone !== undefined) {
    updates.push('phone = ?');
    params.push(body.phone);
  }
  if (body.accepts_marketing !== undefined) {
    updates.push('accepts_marketing = ?');
    params.push(body.accepts_marketing ? 1 : 0);
  }
  if (body.metadata !== undefined) {
    updates.push('metadata = ?');
    params.push(JSON.stringify(body.metadata));
  }

  if (updates.length === 0) {
    return c.json(formatCustomer(customer));
  }

  updates.push('updated_at = ?');
  params.push(now());
  params.push(customerId);

  await db.run(
    `UPDATE customers SET ${updates.join(', ')} WHERE id = ?`,
    params
  );

  const [updated] = await db.query<any>(
    `SELECT * FROM customers WHERE id = ?`,
    [customerId]
  );

  return c.json(formatCustomer(updated));
});

// ------------------------------------------------------------
// POST /v1/customers/:id/addresses - Add address
// ------------------------------------------------------------
customers.post('/:id/addresses', async (c) => {
  const { store } = c.get('auth');
  const db = getDb(c.env);
  const customerId = c.req.param('id');
  const body = await c.req.json();

  const [customer] = await db.query<any>(
    `SELECT id FROM customers WHERE id = ? AND store_id = ?`,
    [customerId, store.id]
  );

  if (!customer) throw ApiError.notFound('Customer');

  // Validate required fields
  if (!body.line1) throw ApiError.invalidRequest('line1 is required');
  if (!body.city) throw ApiError.invalidRequest('city is required');
  if (!body.postal_code) throw ApiError.invalidRequest('postal_code is required');

  const id = crypto.randomUUID();

  // If setting as default, unset other defaults
  if (body.is_default) {
    await db.run(
      `UPDATE customer_addresses SET is_default = 0 WHERE customer_id = ?`,
      [customerId]
    );
  }

  // Check if first address (auto-default)
  const [addressCount] = await db.query<any>(
    `SELECT COUNT(*) as count FROM customer_addresses WHERE customer_id = ?`,
    [customerId]
  );
  const isDefault = body.is_default || addressCount.count === 0 ? 1 : 0;

  await db.run(
    `INSERT INTO customer_addresses (id, customer_id, label, is_default, name, company, line1, line2, city, state, postal_code, country, phone)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, customerId, body.label || null, isDefault,
      body.name || null, body.company || null,
      body.line1, body.line2 || null,
      body.city, body.state || null, body.postal_code, body.country || 'US',
      body.phone || null
    ]
  );

  const [address] = await db.query<any>(
    `SELECT * FROM customer_addresses WHERE id = ?`,
    [id]
  );

  return c.json(formatAddress(address), 201);
});

// ------------------------------------------------------------
// DELETE /v1/customers/:id/addresses/:addressId - Delete address
// ------------------------------------------------------------
customers.delete('/:id/addresses/:addressId', async (c) => {
  const { store } = c.get('auth');
  const db = getDb(c.env);
  const customerId = c.req.param('id');
  const addressId = c.req.param('addressId');

  // Verify customer belongs to store
  const [customer] = await db.query<any>(
    `SELECT id FROM customers WHERE id = ? AND store_id = ?`,
    [customerId, store.id]
  );

  if (!customer) throw ApiError.notFound('Customer');

  const [address] = await db.query<any>(
    `SELECT * FROM customer_addresses WHERE id = ? AND customer_id = ?`,
    [addressId, customerId]
  );

  if (!address) throw ApiError.notFound('Address');

  await db.run(`DELETE FROM customer_addresses WHERE id = ?`, [addressId]);

  // If deleted address was default, set another as default
  if (address.is_default) {
    await db.run(
      `UPDATE customer_addresses SET is_default = 1 
       WHERE customer_id = ? AND id = (SELECT id FROM customer_addresses WHERE customer_id = ? LIMIT 1)`,
      [customerId, customerId]
    );
  }

  return c.json({ deleted: true });
});

// ------------------------------------------------------------
// Formatters
// ------------------------------------------------------------

function formatCustomer(c: any) {
  return {
    id: c.id,
    email: c.email,
    name: c.name,
    phone: c.phone,
    has_account: !!c.password_hash,
    accepts_marketing: !!c.accepts_marketing,
    stats: {
      order_count: c.order_count || 0,
      total_spent_cents: c.total_spent_cents || 0,
      last_order_at: c.last_order_at,
    },
    metadata: c.metadata ? JSON.parse(c.metadata) : null,
    created_at: c.created_at,
    updated_at: c.updated_at,
  };
}

function formatAddress(a: any) {
  return {
    id: a.id,
    label: a.label,
    is_default: !!a.is_default,
    name: a.name,
    company: a.company,
    line1: a.line1,
    line2: a.line2,
    city: a.city,
    state: a.state,
    postal_code: a.postal_code,
    country: a.country,
    phone: a.phone,
  };
}

function formatOrder(o: any) {
  return {
    id: o.id,
    number: o.number,
    status: o.status,
    shipping: {
      name: o.shipping_name,
      phone: o.shipping_phone,
      address: o.ship_to ? JSON.parse(o.ship_to) : null,
    },
    amounts: {
      subtotal_cents: o.subtotal_cents,
      tax_cents: o.tax_cents,
      shipping_cents: o.shipping_cents,
      total_cents: o.total_cents,
      currency: o.currency,
    },
    items: (o.items || []).map((i: any) => ({
      sku: i.sku,
      title: i.title,
      qty: i.qty,
      unit_price_cents: i.unit_price_cents,
    })),
    tracking: o.tracking_number ? {
      number: o.tracking_number,
      url: o.tracking_url,
      shipped_at: o.shipped_at,
    } : null,
    created_at: o.created_at,
  };
}

