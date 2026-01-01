import { getDb } from './db';
import { uuid, now, type Env } from './types';
import { retryFailedDeliveries } from './lib/webhooks';

// ============================================================
// CRON - Scheduled tasks
// ============================================================

export async function handleCron(env: Env, ctx: ExecutionContext) {
  const db = getDb(env);
  const currentTime = now();

  // Find expired open carts
  const expiredCarts = await db.query<any>(
    `SELECT * FROM carts WHERE status = 'open' AND expires_at < ?`,
    [currentTime]
  );

  for (const cart of expiredCarts) {
    const items = await db.query<any>(`SELECT * FROM cart_items WHERE cart_id = ?`, [cart.id]);

    // Release reserved inventory
    for (const item of items) {
      await db.run(
        `UPDATE inventory SET reserved = MAX(reserved - ?, 0), updated_at = ? WHERE store_id = ? AND sku = ?`,
        [item.qty, currentTime, cart.store_id, item.sku]
      );

      await db.run(
        `INSERT INTO inventory_logs (id, store_id, sku, delta, reason) VALUES (?, ?, ?, ?, 'release')`,
        [uuid(), cart.store_id, item.sku, -item.qty]
      );
    }

    // Mark cart expired
    await db.run(`UPDATE carts SET status = 'expired' WHERE id = ?`, [cart.id]);
  }

  console.log(`Released ${expiredCarts.length} expired carts`);

  // These represent checkout sessions that were created but webhook never arrived
  // Release their reserved discount usage and inventory
  // Use updated_at (when checkout was initiated) instead of created_at (when cart was created)
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const abandonedCheckouts = await db.query<any>(
    `SELECT * FROM carts WHERE status = 'checked_out' AND updated_at < ? AND stripe_checkout_session_id IS NOT NULL`,
    [oneHourAgo]
  );

  for (const cart of abandonedCheckouts) {
    const items = await db.query<any>(`SELECT * FROM cart_items WHERE cart_id = ?`, [cart.id]);

    // Release reserved inventory
    for (const item of items) {
      await db.run(
        `UPDATE inventory SET reserved = MAX(reserved - ?, 0), updated_at = ? WHERE store_id = ? AND sku = ?`,
        [item.qty, currentTime, cart.store_id, item.sku]
      );
    }

    // Release reserved discount usage
    if (cart.discount_id) {
      await db.run(
        `UPDATE discounts SET usage_count = MAX(usage_count - 1, 0), updated_at = ? WHERE id = ?`,
        [currentTime, cart.discount_id]
      );
    }

    // Mark as expired (or could create a new status like 'abandoned')
    await db.run(`UPDATE carts SET status = 'expired' WHERE id = ?`, [cart.id]);
  }

  if (abandonedCheckouts.length > 0) {
    console.log(`Released ${abandonedCheckouts.length} abandoned checkout sessions`);
  }

  // Retry failed webhook deliveries
  const retriedCount = await retryFailedDeliveries(env, ctx);
  console.log(`Retried ${retriedCount} failed webhook deliveries`);
}
