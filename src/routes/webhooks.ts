import { Hono } from 'hono';
import Stripe from 'stripe';
import { getDb } from '../db';
import { ApiError, uuid, now, type Env } from '../types';
import { dispatchWebhooks } from '../lib/webhooks';

// ============================================================
// WEBHOOK ROUTES
// ============================================================

export const webhooks = new Hono<{ Bindings: Env }>();

// POST /v1/webhooks/stripe
webhooks.post('/stripe', async (c) => {
  const signature = c.req.header('stripe-signature');
  const body = await c.req.text();

  if (!signature) throw ApiError.invalidRequest('Missing stripe-signature header');

  let rawEvent: any;
  try {
    rawEvent = JSON.parse(body);
  } catch {
    throw ApiError.invalidRequest('Invalid JSON');
  }

  const storeId = rawEvent.data?.object?.metadata?.store_id;
  if (!storeId) throw ApiError.invalidRequest('Missing store_id in metadata');

  const db = getDb(c.env);

  const [store] = await db.query<any>(`SELECT * FROM stores WHERE id = ?`, [storeId]);
  if (!store?.stripe_webhook_secret) {
    throw ApiError.invalidRequest('Store not found or webhook secret missing');
  }

  // Verify signature
  const stripe = new Stripe(store.stripe_secret_key);
  let event: Stripe.Event;

  try {
    event = await stripe.webhooks.constructEventAsync(body, signature, store.stripe_webhook_secret);
  } catch (e: any) {
    throw new ApiError('webhook_signature_invalid', 400, e.message);
  }

  // Dedupe
  const [existing] = await db.query<any>(`SELECT id FROM events WHERE stripe_event_id = ?`, [event.id]);
  if (existing) return c.json({ ok: true });

  // Handle checkout.session.completed
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;
    const cartId = session.metadata?.cart_id;

    if (cartId) {
      const [cart] = await db.query<any>(`SELECT * FROM carts WHERE id = ?`, [cartId]);
      if (cart) {
        const items = await db.query<any>(`SELECT * FROM cart_items WHERE cart_id = ?`, [cartId]);

        // Handle discount
        let discountCode = null;
        let discountId = null;
        let discountAmountCents = 0;
        const shippingCents = session.total_details?.amount_shipping ?? 0;

        if (session.metadata?.discount_id) {
          const [discount] = await db.query<any>(
            `SELECT * FROM discounts WHERE id = ? AND store_id = ?`,
            [session.metadata.discount_id, store.id]
          );

          if (discount) {
            discountCode = discount.code;
            discountId = discount.id;
            discountAmountCents = cart.discount_amount_cents || 0;

            // We don't increment again here to avoid double-counting
            // The usage_count was reserved at checkout and is now being committed with the order
          }
        }

        // Calculate subtotal from cart items (before discounts)
        // session.amount_subtotal includes discounts as negative line items, so we calculate from original items
        const subtotalCents = items.reduce((sum, item) => sum + item.unit_price_cents * item.qty, 0);

        // This prevents race conditions that could occur with COUNT(*) based numbering
        const timestamp = Date.now();
        const randomSuffix = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
        const orderNumber = `ORD-${timestamp}-${randomSuffix}`;

        // Create order
        const orderId = uuid();
        await db.run(
          `INSERT INTO orders (id, store_id, number, status, customer_email, ship_to,
           subtotal_cents, tax_cents, shipping_cents, total_cents, currency,
           discount_code, discount_id, discount_amount_cents,
           stripe_checkout_session_id, stripe_payment_intent_id)
           VALUES (?, ?, ?, 'paid', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            orderId, store.id, orderNumber, cart.customer_email,
            session.shipping_details?.address ? JSON.stringify(session.shipping_details.address) : null,
            subtotalCents, session.total_details?.amount_tax ?? 0,
            shippingCents, session.amount_total ?? 0, cart.currency,
            discountCode, discountId, discountAmountCents,
            session.id, session.payment_intent
          ]
        );

        // Track discount usage for per-customer limit tracking
        // Note: usage_count was already incremented at checkout time (atomic reservation)
        // We only record the usage here for per-customer tracking and audit purposes
        if (discountId && discountAmountCents > 0) {
          // Check if already recorded (idempotency)
          const [existing] = await db.query<any>(
            `SELECT id FROM discount_usage WHERE order_id = ? AND discount_id = ?`,
            [orderId, discountId]
          );
          
          if (!existing) {
            await db.run(
              `INSERT INTO discount_usage (id, discount_id, order_id, customer_email, discount_amount_cents)
               VALUES (?, ?, ?, ?, ?)`,
              [uuid(), discountId, orderId, cart.customer_email.toLowerCase(), discountAmountCents]
            );
          }
          // If already exists, silently skip 
        }

        // Create order items & update inventory
        for (const item of items) {
          await db.run(
            `INSERT INTO order_items (id, order_id, sku, title, qty, unit_price_cents) VALUES (?, ?, ?, ?, ?, ?)`,
            [uuid(), orderId, item.sku, item.title, item.qty, item.unit_price_cents]
          );

          await db.run(
            `UPDATE inventory SET reserved = reserved - ?, on_hand = on_hand - ?, updated_at = ? WHERE store_id = ? AND sku = ?`,
            [item.qty, item.qty, now(), store.id, item.sku]
          );

          await db.run(
            `INSERT INTO inventory_logs (id, store_id, sku, delta, reason) VALUES (?, ?, ?, ?, 'sale')`,
            [uuid(), store.id, item.sku, -item.qty]
          );
        }

        // Dispatch order.created webhook
        const orderItems = await db.query<any>(`SELECT * FROM order_items WHERE order_id = ?`, [orderId]);
        await dispatchWebhooks(c.env, c.executionCtx, store.id, 'order.created', {
          order: {
            id: orderId,
            number: orderNumber,
            status: 'paid',
            customer_email: cart.customer_email,
            ship_to: session.shipping_details?.address || null,
            amounts: {
              subtotal_cents: session.amount_subtotal ?? 0,
              tax_cents: session.total_details?.amount_tax ?? 0,
              shipping_cents: session.total_details?.amount_shipping ?? 0,
              total_cents: session.amount_total ?? 0,
              currency: cart.currency,
            },
            items: orderItems.map((i: any) => ({
              sku: i.sku,
              title: i.title,
              qty: i.qty,
              unit_price_cents: i.unit_price_cents,
            })),
            stripe: {
              checkout_session_id: session.id,
              payment_intent_id: session.payment_intent,
            },
          },
        });
      }
    }
  }

  // Log event
  await db.run(
    `INSERT INTO events (id, store_id, stripe_event_id, type, payload) VALUES (?, ?, ?, ?, ?)`,
    [uuid(), store.id, event.id, event.type, JSON.stringify(event.data.object)]
  );

  return c.json({ ok: true });
});
