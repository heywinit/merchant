import { Hono } from 'hono';
import Stripe from 'stripe';
import { getDb } from '../db';
import { authMiddleware } from '../middleware/auth';
import { ApiError, uuid, now, isValidEmail, type Env, type AuthContext } from '../types';

// ============================================================
// CHECKOUT ROUTES
// ============================================================

export const checkout = new Hono<{
  Bindings: Env;
  Variables: { auth: AuthContext };
}>();

checkout.use('*', authMiddleware);

// GET /v1/carts/:cartId - Retrieve cart
checkout.get('/:cartId', async (c) => {
  const cartId = c.req.param('cartId');
  const { store } = c.get('auth');
  const db = getDb(c.env);

  const [cart] = await db.query<any>(
    `SELECT * FROM carts WHERE id = ? AND store_id = ?`,
    [cartId, store.id]
  );
  if (!cart) throw ApiError.notFound('Cart not found');

  const items = await db.query<any>(`SELECT * FROM cart_items WHERE cart_id = ?`, [cartId]);

  return c.json({
    id: cart.id,
    status: cart.status,
    currency: cart.currency,
    customer_email: cart.customer_email,
    items: items.map((i) => ({
      sku: i.sku,
      title: i.title,
      qty: i.qty,
      unit_price_cents: i.unit_price_cents,
    })),
    expires_at: cart.expires_at,
    stripe_checkout_session_id: cart.stripe_checkout_session_id,
  });
});

// POST /v1/carts
checkout.post('/', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const customerEmail = body?.customer_email;

  if (!customerEmail || !isValidEmail(customerEmail)) {
    throw ApiError.invalidRequest('A valid customer_email is required');
  }

  const { store } = c.get('auth');
  const db = getDb(c.env);

  const id = uuid();
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();

  await db.run(
    `INSERT INTO carts (id, store_id, customer_email, expires_at) VALUES (?, ?, ?, ?)`,
    [id, store.id, customerEmail, expiresAt]
  );

  return c.json({
    id,
    status: 'open',
    currency: 'USD',
    customer_email: customerEmail,
    items: [],
    expires_at: expiresAt,
  });
});

// POST /v1/carts/:cartId/items
checkout.post('/:cartId/items', async (c) => {
  const cartId = c.req.param('cartId');
  const body = await c.req.json().catch(() => ({}));
  const items = body?.items;

  if (!Array.isArray(items) || items.length === 0) {
    throw ApiError.invalidRequest('items array is required');
  }

  const { store } = c.get('auth');
  const db = getDb(c.env);

  // Get cart
  const [cart] = await db.query<any>(
    `SELECT * FROM carts WHERE id = ? AND store_id = ?`,
    [cartId, store.id]
  );
  if (!cart) throw ApiError.notFound('Cart not found');
  if (cart.status !== 'open') throw ApiError.conflict('Cart is not open');

  // Clear existing items
  await db.run(`DELETE FROM cart_items WHERE cart_id = ?`, [cartId]);

  // Add new items
  const newItems = [];
  for (const { sku, qty } of items) {
    if (!sku || !qty || qty < 1) {
      throw ApiError.invalidRequest('Each item needs sku and qty > 0');
    }

    const [variant] = await db.query<any>(
      `SELECT * FROM variants WHERE store_id = ? AND sku = ?`,
      [store.id, sku]
    );
    if (!variant) throw ApiError.notFound(`SKU not found: ${sku}`);
    if (variant.status !== 'active') throw ApiError.invalidRequest(`SKU not active: ${sku}`);

    const [inv] = await db.query<any>(
      `SELECT * FROM inventory WHERE store_id = ? AND sku = ?`,
      [store.id, sku]
    );
    const available = (inv?.on_hand ?? 0) - (inv?.reserved ?? 0);
    if (available < qty) throw ApiError.insufficientInventory(sku);

    await db.run(
      `INSERT INTO cart_items (id, cart_id, sku, title, qty, unit_price_cents) VALUES (?, ?, ?, ?, ?, ?)`,
      [uuid(), cartId, sku, variant.title, qty, variant.price_cents]
    );

    newItems.push({
      sku,
      title: variant.title,
      qty,
      unit_price_cents: variant.price_cents,
    });
  }

  return c.json({
    id: cart.id,
    status: cart.status,
    currency: cart.currency,
    customer_email: cart.customer_email,
    items: newItems,
    expires_at: cart.expires_at,
  });
});

// POST /v1/carts/:cartId/checkout
checkout.post('/:cartId/checkout', async (c) => {
  const cartId = c.req.param('cartId');
  const body = await c.req.json().catch(() => ({}));
  const successUrl = body?.success_url;
  const cancelUrl = body?.cancel_url;
  const collectShipping = body?.collect_shipping ?? false;
  const shippingCountries = body?.shipping_countries ?? ['US'];
  const shippingOptions = body?.shipping_options;

  if (!successUrl) throw ApiError.invalidRequest('success_url is required');
  if (!cancelUrl) throw ApiError.invalidRequest('cancel_url is required');

  const { store } = c.get('auth');
  if (!store.stripe_secret_key) {
    throw ApiError.invalidRequest('Stripe not connected. POST /v1/setup/stripe first.');
  }

  const db = getDb(c.env);

  const [cart] = await db.query<any>(
    `SELECT * FROM carts WHERE id = ? AND store_id = ?`,
    [cartId, store.id]
  );
  if (!cart) throw ApiError.notFound('Cart not found');
  if (cart.status !== 'open') throw ApiError.conflict('Cart is not open');

  const items = await db.query<any>(`SELECT * FROM cart_items WHERE cart_id = ?`, [cartId]);
  if (items.length === 0) throw ApiError.invalidRequest('Cart is empty');

  // Reserve inventory atomically (prevents overselling under concurrent requests)
  for (const item of items) {
    const result = await db.runWithChanges(
      `UPDATE inventory 
       SET reserved = reserved + ?, updated_at = ? 
       WHERE store_id = ? AND sku = ? AND on_hand - reserved >= ?`,
      [item.qty, now(), store.id, item.sku, item.qty]
    );
    
    if (result.changes === 0) {
      // Rollback previously reserved items
      for (const prevItem of items) {
        if (prevItem.sku === item.sku) break;
        await db.run(
          `UPDATE inventory SET reserved = reserved - ?, updated_at = ? WHERE store_id = ? AND sku = ?`,
          [prevItem.qty, now(), store.id, prevItem.sku]
        );
      }
      throw ApiError.insufficientInventory(item.sku);
    }
  }

  // Create Stripe session
  const stripe = new Stripe(store.stripe_secret_key);

  // Build shipping options if provided, otherwise use defaults
  const defaultShippingOptions: Stripe.Checkout.SessionCreateParams.ShippingOption[] = [
    {
      shipping_rate_data: {
        type: 'fixed_amount',
        fixed_amount: { amount: 0, currency: 'usd' },
        display_name: 'Standard Shipping',
        delivery_estimate: {
          minimum: { unit: 'business_day', value: 5 },
          maximum: { unit: 'business_day', value: 7 },
        },
      },
    },
  ];

  let session;
  try {
    session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: cart.customer_email,
      automatic_tax: { enabled: true },
      ...(collectShipping && {
        shipping_address_collection: {
          allowed_countries: shippingCountries as Stripe.Checkout.SessionCreateParams.ShippingAddressCollection.AllowedCountry[],
        },
        shipping_options: shippingOptions ?? defaultShippingOptions,
      }),
      line_items: items.map((item) => ({
        price_data: {
          currency: 'usd',
          product_data: { name: item.title },
          unit_amount: item.unit_price_cents,
        },
        quantity: item.qty,
      })),
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: { cart_id: cartId, store_id: store.id },
    });
  } catch (err: any) {
    // Release reserved inventory on Stripe error
    for (const item of items) {
      await db.run(
        `UPDATE inventory SET reserved = reserved - ?, updated_at = ? WHERE store_id = ? AND sku = ?`,
        [item.qty, now(), store.id, item.sku]
      );
    }
    throw ApiError.invalidRequest(`Stripe error: ${err.message}`);
  }

  await db.run(
    `UPDATE carts SET status = 'checked_out', stripe_checkout_session_id = ? WHERE id = ?`,
    [session.id, cartId]
  );

  return c.json({
    checkout_url: session.url,
    stripe_checkout_session_id: session.id,
  });
});
