import { Hono } from 'hono';
import { getDb } from '../db';
import { authMiddleware, adminOnly } from '../middleware/auth';
import { ApiError, uuid, now, type Env, type AuthContext } from '../types';
import { generateWebhookSecret, retryDelivery } from '../lib/webhooks';

// ============================================================
// OUTBOUND WEBHOOKS API (CRUD)
// ============================================================

const webhooksRoutes = new Hono<{
  Bindings: Env;
  Variables: { auth: AuthContext };
}>();

webhooksRoutes.use('*', authMiddleware, adminOnly);

// Supported event types
const VALID_EVENTS = [
  'order.created',
  'order.updated',
  'order.shipped',
  'order.refunded',
  'inventory.low',
  'order.*', // Wildcard for all order events
  '*',       // Wildcard for all events
] as const;

// GET /v1/webhooks
webhooksRoutes.get('/', async (c) => {
  const { store } = c.get('auth');
  const db = getDb(c.env);

  const webhooks = await db.query<any>(
    `SELECT * FROM webhooks WHERE store_id = ? ORDER BY created_at DESC`,
    [store.id]
  );

  return c.json({
    items: webhooks.map((w) => ({
      id: w.id,
      url: w.url,
      events: JSON.parse(w.events),
      status: w.status,
      created_at: w.created_at,
      // Don't expose the secret, just indicate if it exists
      has_secret: Boolean(w.secret),
    })),
  });
});

// GET /v1/webhooks/:id
webhooksRoutes.get('/:id', async (c) => {
  const { store } = c.get('auth');
  const db = getDb(c.env);
  const id = c.req.param('id');

  const [webhook] = await db.query<any>(
    `SELECT * FROM webhooks WHERE id = ? AND store_id = ?`,
    [id, store.id]
  );

  if (!webhook) throw ApiError.notFound('Webhook not found');

  // Get recent deliveries
  const deliveries = await db.query<any>(
    `SELECT id, event_type, status, attempts, response_code, created_at, last_attempt_at
     FROM webhook_deliveries 
     WHERE webhook_id = ? 
     ORDER BY created_at DESC 
     LIMIT 20`,
    [id]
  );

  return c.json({
    id: webhook.id,
    url: webhook.url,
    events: JSON.parse(webhook.events),
    status: webhook.status,
    created_at: webhook.created_at,
    has_secret: Boolean(webhook.secret),
    recent_deliveries: deliveries.map((d) => ({
      id: d.id,
      event_type: d.event_type,
      status: d.status,
      attempts: d.attempts,
      response_code: d.response_code,
      created_at: d.created_at,
      last_attempt_at: d.last_attempt_at,
    })),
  });
});

// POST /v1/webhooks
webhooksRoutes.post('/', async (c) => {
  const body = await c.req.json();
  const { url, events } = body;

  if (!url) throw ApiError.invalidRequest('url is required');
  if (!events || !Array.isArray(events) || events.length === 0) {
    throw ApiError.invalidRequest('events must be a non-empty array');
  }

  // Validate URL
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('Invalid protocol');
    }
  } catch {
    throw ApiError.invalidRequest('url must be a valid HTTP(S) URL');
  }

  // Validate events
  for (const event of events) {
    if (!VALID_EVENTS.includes(event)) {
      throw ApiError.invalidRequest(
        `Invalid event type: ${event}. Valid types: ${VALID_EVENTS.join(', ')}`
      );
    }
  }

  const { store } = c.get('auth');
  const db = getDb(c.env);

  const id = uuid();
  const secret = generateWebhookSecret();
  const timestamp = now();

  await db.run(
    `INSERT INTO webhooks (id, store_id, url, events, secret, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?)`,
    [id, store.id, url, JSON.stringify(events), secret, timestamp]
  );

  return c.json(
    {
      id,
      url,
      events,
      status: 'active',
      secret, // Only returned on creation!
      created_at: timestamp,
    },
    201
  );
});

// PATCH /v1/webhooks/:id
webhooksRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const { url, events, status } = body;

  const { store } = c.get('auth');
  const db = getDb(c.env);

  const [existing] = await db.query<any>(
    `SELECT * FROM webhooks WHERE id = ? AND store_id = ?`,
    [id, store.id]
  );

  if (!existing) throw ApiError.notFound('Webhook not found');

  const updates: string[] = [];
  const params: unknown[] = [];

  if (url !== undefined) {
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('Invalid protocol');
      }
    } catch {
      throw ApiError.invalidRequest('url must be a valid HTTP(S) URL');
    }
    updates.push('url = ?');
    params.push(url);
  }

  if (events !== undefined) {
    if (!Array.isArray(events) || events.length === 0) {
      throw ApiError.invalidRequest('events must be a non-empty array');
    }
    for (const event of events) {
      if (!VALID_EVENTS.includes(event)) {
        throw ApiError.invalidRequest(`Invalid event type: ${event}`);
      }
    }
    updates.push('events = ?');
    params.push(JSON.stringify(events));
  }

  if (status !== undefined) {
    if (!['active', 'disabled'].includes(status)) {
      throw ApiError.invalidRequest('status must be active or disabled');
    }
    updates.push('status = ?');
    params.push(status);
  }

  if (updates.length > 0) {
    params.push(id);
    await db.run(`UPDATE webhooks SET ${updates.join(', ')} WHERE id = ?`, params);
  }

  const [updated] = await db.query<any>(`SELECT * FROM webhooks WHERE id = ?`, [id]);

  return c.json({
    id: updated.id,
    url: updated.url,
    events: JSON.parse(updated.events),
    status: updated.status,
    created_at: updated.created_at,
    has_secret: true,
  });
});

// DELETE /v1/webhooks/:id
webhooksRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const { store } = c.get('auth');
  const db = getDb(c.env);

  const [existing] = await db.query<any>(
    `SELECT * FROM webhooks WHERE id = ? AND store_id = ?`,
    [id, store.id]
  );

  if (!existing) throw ApiError.notFound('Webhook not found');

  // Delete deliveries first (foreign key)
  await db.run(`DELETE FROM webhook_deliveries WHERE webhook_id = ?`, [id]);
  await db.run(`DELETE FROM webhooks WHERE id = ?`, [id]);

  return c.json({ deleted: true });
});

// POST /v1/webhooks/:id/rotate-secret
webhooksRoutes.post('/:id/rotate-secret', async (c) => {
  const id = c.req.param('id');
  const { store } = c.get('auth');
  const db = getDb(c.env);

  const [existing] = await db.query<any>(
    `SELECT * FROM webhooks WHERE id = ? AND store_id = ?`,
    [id, store.id]
  );

  if (!existing) throw ApiError.notFound('Webhook not found');

  const newSecret = generateWebhookSecret();

  await db.run(`UPDATE webhooks SET secret = ? WHERE id = ?`, [newSecret, id]);

  return c.json({ secret: newSecret });
});

// GET /v1/webhooks/:id/deliveries/:deliveryId
webhooksRoutes.get('/:id/deliveries/:deliveryId', async (c) => {
  const webhookId = c.req.param('id');
  const deliveryId = c.req.param('deliveryId');
  const { store } = c.get('auth');
  const db = getDb(c.env);

  // Verify webhook belongs to store
  const [webhook] = await db.query<any>(
    `SELECT id FROM webhooks WHERE id = ? AND store_id = ?`,
    [webhookId, store.id]
  );

  if (!webhook) throw ApiError.notFound('Webhook not found');

  const [delivery] = await db.query<any>(
    `SELECT * FROM webhook_deliveries WHERE id = ? AND webhook_id = ?`,
    [deliveryId, webhookId]
  );

  if (!delivery) throw ApiError.notFound('Delivery not found');

  return c.json({
    id: delivery.id,
    event_type: delivery.event_type,
    payload: JSON.parse(delivery.payload),
    status: delivery.status,
    attempts: delivery.attempts,
    response_code: delivery.response_code,
    response_body: delivery.response_body,
    created_at: delivery.created_at,
    last_attempt_at: delivery.last_attempt_at,
  });
});

// POST /v1/webhooks/:id/deliveries/:deliveryId/retry
webhooksRoutes.post('/:id/deliveries/:deliveryId/retry', async (c) => {
  const webhookId = c.req.param('id');
  const deliveryId = c.req.param('deliveryId');
  const { store } = c.get('auth');
  const db = getDb(c.env);

  const [webhook] = await db.query<any>(
    `SELECT * FROM webhooks WHERE id = ? AND store_id = ?`,
    [webhookId, store.id]
  );

  if (!webhook) throw ApiError.notFound('Webhook not found');

  const [delivery] = await db.query<any>(
    `SELECT * FROM webhook_deliveries WHERE id = ? AND webhook_id = ?`,
    [deliveryId, webhookId]
  );

  if (!delivery) throw ApiError.notFound('Delivery not found');

  // Reset status and actually dispatch the retry
  await db.run(
    `UPDATE webhook_deliveries SET status = 'pending', attempts = 0 WHERE id = ?`,
    [deliveryId]
  );

  // Actually trigger the retry delivery
  c.executionCtx.waitUntil(
    retryDelivery(c.env, webhook, delivery)
  );

  return c.json({ status: 'pending', message: 'Delivery retry triggered' });
});

export { webhooksRoutes };

