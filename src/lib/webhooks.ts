import { getDb } from '../db';
import { uuid, now, type Env } from '../types';

// ============================================================
// OUTBOUND WEBHOOK DISPATCHER
// ============================================================

export type WebhookEventType =
  | 'order.created'
  | 'order.updated'
  | 'order.shipped'
  | 'order.refunded'
  | 'inventory.low';

export type WebhookPayload = {
  id: string;
  type: WebhookEventType;
  created_at: string;
  store_id: string;
  data: Record<string, unknown>;
};

const MAX_ATTEMPTS = 3;
const LOW_INVENTORY_THRESHOLD = 5;

/**
 * Generate HMAC-SHA256 signature for webhook payload
 */
async function signPayload(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Generate a secure random webhook secret
 */
export function generateWebhookSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return 'whsec_' + Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Dispatch webhooks for a given event
 * Uses waitUntil for non-blocking delivery
 */
export async function dispatchWebhooks(
  env: Env,
  ctx: ExecutionContext,
  storeId: string,
  eventType: WebhookEventType,
  data: Record<string, unknown>
): Promise<void> {
  const db = getDb(env);

  // Find active webhooks subscribed to this event
  const webhooks = await db.query<{
    id: string;
    url: string;
    events: string;
    secret: string;
  }>(
    `SELECT id, url, events, secret FROM webhooks 
     WHERE store_id = ? AND status = 'active'`,
    [storeId]
  );

  for (const webhook of webhooks) {
    const subscribedEvents: string[] = JSON.parse(webhook.events);
    
    // Check if webhook is subscribed to this event type
    // Support wildcard subscriptions like 'order.*'
    const isSubscribed = subscribedEvents.some((e) => {
      if (e === '*') return true;
      if (e === eventType) return true;
      if (e.endsWith('.*')) {
        const prefix = e.slice(0, -2);
        return eventType.startsWith(prefix + '.');
      }
      return false;
    });

    if (!isSubscribed) continue;

    // Create delivery record
    const deliveryId = uuid();
    const payload: WebhookPayload = {
      id: deliveryId,
      type: eventType,
      created_at: now(),
      store_id: storeId,
      data,
    };

    await db.run(
      `INSERT INTO webhook_deliveries (id, webhook_id, event_type, payload, status, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?)`,
      [deliveryId, webhook.id, eventType, JSON.stringify(payload), now()]
    );

    // Dispatch asynchronously using waitUntil
    ctx.waitUntil(
      deliverWebhook(env, webhook.id, webhook.url, webhook.secret, deliveryId, payload)
    );
  }
}

/**
 * Deliver a single webhook with retries
 */
async function deliverWebhook(
  env: Env,
  webhookId: string,
  url: string,
  secret: string,
  deliveryId: string,
  payload: WebhookPayload
): Promise<void> {
  const db = getDb(env);
  const payloadString = JSON.stringify(payload);
  const signature = await signPayload(payloadString, secret);
  const timestamp = Math.floor(Date.now() / 1000);

  let lastError: Error | null = null;
  let responseCode: number | null = null;
  let responseBody: string | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      // Update attempt count
      await db.run(
        `UPDATE webhook_deliveries SET attempts = ?, last_attempt_at = ? WHERE id = ?`,
        [attempt, now(), deliveryId]
      );

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Merchant-Signature': signature,
          'X-Merchant-Timestamp': String(timestamp),
          'X-Merchant-Delivery-Id': deliveryId,
          'User-Agent': 'Merchant-Webhook/1.0',
        },
        body: payloadString,
      });

      responseCode = response.status;
      responseBody = await response.text().catch(() => null);

      // Success: 2xx status
      if (response.ok) {
        await db.run(
          `UPDATE webhook_deliveries 
           SET status = 'success', response_code = ?, response_body = ? 
           WHERE id = ?`,
          [responseCode, responseBody?.slice(0, 1000), deliveryId]
        );
        return;
      }

      // Non-retryable: 4xx (except 429)
      if (responseCode >= 400 && responseCode < 500 && responseCode !== 429) {
        await db.run(
          `UPDATE webhook_deliveries 
           SET status = 'failed', response_code = ?, response_body = ? 
           WHERE id = ?`,
          [responseCode, responseBody?.slice(0, 1000), deliveryId]
        );
        return;
      }

      lastError = new Error(`HTTP ${responseCode}`);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }

    // Exponential backoff before retry
    if (attempt < MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
    }
  }

  // All retries exhausted
  await db.run(
    `UPDATE webhook_deliveries 
     SET status = 'failed', response_code = ?, response_body = ? 
     WHERE id = ?`,
    [responseCode, lastError?.message?.slice(0, 1000) || responseBody?.slice(0, 1000), deliveryId]
  );
}

/**
 * Check inventory levels and dispatch low stock webhooks
 */
/**
 * Retry a single webhook delivery (called from API)
 */
export async function retryDelivery(
  env: Env,
  webhook: { id: string; url: string; secret: string },
  delivery: { id: string; payload: string }
): Promise<void> {
  const payload = JSON.parse(delivery.payload);
  await deliverWebhook(env, webhook.id, webhook.url, webhook.secret, delivery.id, payload);
}

export async function checkLowInventory(
  env: Env,
  ctx: ExecutionContext,
  storeId: string,
  sku: string,
  available: number
): Promise<void> {
  if (available <= LOW_INVENTORY_THRESHOLD && available >= 0) {
    await dispatchWebhooks(env, ctx, storeId, 'inventory.low', {
      sku,
      available,
      threshold: LOW_INVENTORY_THRESHOLD,
    });
  }
}

/**
 * Retry failed webhook deliveries (for cron job)
 */
export async function retryFailedDeliveries(env: Env, ctx: ExecutionContext): Promise<number> {
  const db = getDb(env);

  // Get failed deliveries that haven't exceeded max attempts
  const failed = await db.query<{
    id: string;
    webhook_id: string;
    payload: string;
    attempts: number;
  }>(
    `SELECT wd.id, wd.webhook_id, wd.payload, wd.attempts
     FROM webhook_deliveries wd
     JOIN webhooks w ON w.id = wd.webhook_id
     WHERE wd.status = 'failed' 
       AND wd.attempts < ?
       AND w.status = 'active'
       AND wd.created_at > datetime('now', '-24 hours')
     LIMIT 50`,
    [MAX_ATTEMPTS]
  );

  for (const delivery of failed) {
    const [webhook] = await db.query<{ url: string; secret: string }>(
      `SELECT url, secret FROM webhooks WHERE id = ?`,
      [delivery.webhook_id]
    );

    if (webhook) {
      // Reset to pending for retry
      await db.run(`UPDATE webhook_deliveries SET status = 'pending' WHERE id = ?`, [delivery.id]);

      ctx.waitUntil(
        deliverWebhook(
          env,
          delivery.webhook_id,
          webhook.url,
          webhook.secret,
          delivery.id,
          JSON.parse(delivery.payload)
        )
      );
    }
  }

  return failed.length;
}

