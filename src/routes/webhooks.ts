import { Hono } from 'hono';
import Stripe from 'stripe';
import { getDb } from '../db';
import { ApiError, uuid, now, generateOrderNumber, type Env } from '../types';
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
    const webhookSession = event.data.object as Stripe.Checkout.Session;
    const cartId = webhookSession.metadata?.cart_id;

    if (cartId) {
      const [cart] = await db.query<any>(`SELECT * FROM carts WHERE id = ?`, [cartId]);
      if (cart) {
        const items = await db.query<any>(`SELECT * FROM cart_items WHERE cart_id = ?`, [cartId]);

        // Retrieve full session from Stripe to get shipping_details
        // (webhook payload sometimes doesn't include all fields)
        const session = await stripe.checkout.sessions.retrieve(webhookSession.id);

        // Extract customer details from full Stripe session
        const customerEmail = cart.customer_email;
        const shippingName = session.shipping_details?.name || session.customer_details?.name || null;
        const shippingPhone = session.shipping_details?.phone || session.customer_details?.phone || null;
        const shippingAddress = session.shipping_details?.address || null;

        // Upsert customer (create or update on email match)
        let customerId: string | null = null;
        const [existingCustomer] = await db.query<any>(
          `SELECT id, order_count, total_spent_cents FROM customers WHERE store_id = ? AND email = ?`,
          [store.id, customerEmail]
        );

        if (existingCustomer) {
          // Update existing customer
          customerId = existingCustomer.id;
          await db.run(
            `UPDATE customers SET 
              name = COALESCE(?, name),
              phone = COALESCE(?, phone),
              order_count = order_count + 1,
              total_spent_cents = total_spent_cents + ?,
              last_order_at = ?,
              updated_at = ?
            WHERE id = ?`,
            [shippingName, shippingPhone, session.amount_total ?? 0, now(), now(), customerId]
          );
        } else {
          // Create new customer
          customerId = uuid();
          await db.run(
            `INSERT INTO customers (id, store_id, email, name, phone, order_count, total_spent_cents, last_order_at)
             VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
            [customerId, store.id, customerEmail, shippingName, shippingPhone, session.amount_total ?? 0, now()]
          );
        }

        // Save shipping address to customer if provided
        if (shippingAddress && customerId) {
          const [existingAddress] = await db.query<any>(
            `SELECT id FROM customer_addresses WHERE customer_id = ? AND line1 = ? AND postal_code = ?`,
            [customerId, shippingAddress.line1, shippingAddress.postal_code]
          );

          if (!existingAddress) {
            // Check if customer has any addresses
            const [addressCount] = await db.query<any>(
              `SELECT COUNT(*) as count FROM customer_addresses WHERE customer_id = ?`,
              [customerId]
            );
            const isDefault = addressCount.count === 0 ? 1 : 0;

            await db.run(
              `INSERT INTO customer_addresses (id, customer_id, is_default, name, line1, line2, city, state, postal_code, country, phone)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                uuid(), customerId, isDefault, shippingName,
                shippingAddress.line1, shippingAddress.line2 || null,
                shippingAddress.city, shippingAddress.state,
                shippingAddress.postal_code, shippingAddress.country,
                shippingPhone
              ]
            );
          }
        }

        // Generate order number (timestamp-based to avoid race conditions)
        const orderNumber = generateOrderNumber();

        // Create order (now with customer link and shipping details)
        const orderId = uuid();
        await db.run(
          `INSERT INTO orders (id, store_id, customer_id, number, status, customer_email, 
           shipping_name, shipping_phone, ship_to,
           subtotal_cents, tax_cents, shipping_cents, total_cents, currency,
           stripe_checkout_session_id, stripe_payment_intent_id)
           VALUES (?, ?, ?, ?, 'paid', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            orderId, store.id, customerId, orderNumber, customerEmail,
            shippingName, shippingPhone,
            shippingAddress ? JSON.stringify(shippingAddress) : null,
            session.amount_subtotal ?? 0, session.total_details?.amount_tax ?? 0,
            session.total_details?.amount_shipping ?? 0, session.amount_total ?? 0, cart.currency,
            session.id, session.payment_intent
          ]
        );

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
            customer_email: customerEmail,
            customer_id: customerId,
            shipping: {
              name: shippingName,
              phone: shippingPhone,
              address: shippingAddress,
            },
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
