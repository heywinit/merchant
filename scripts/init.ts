#!/usr/bin/env npx tsx
/**
 * Init script - creates your first store
 * 
 * Usage:
 *   npx tsx scripts/init.ts
 */

import { execSync } from 'child_process';

async function hashKey(key: string): Promise<string> {
  const data = new TextEncoder().encode(key);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function generateApiKey(prefix: 'pk' | 'sk'): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const key = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return `${prefix}_${key}`;
}

function runSql(sql: string) {
  const escaped = sql.replace(/'/g, "'\\''");
  execSync(`npx wrangler d1 execute merchant-db --local --command='${escaped}'`, {
    stdio: 'inherit',
  });
}

async function init() {
  console.log('🚀 Initializing merchant...\n');

  // Apply schema
  console.log('📋 Applying schema...');
  execSync('npx wrangler d1 execute merchant-db --local --file=schema-d1.sql', {
    stdio: 'inherit',
  });

  // Create store
  const storeId = crypto.randomUUID();
  console.log('\n🏪 Creating store...');
  runSql(`INSERT OR IGNORE INTO stores (id, name, status) VALUES ('${storeId}', 'My Store', 'enabled')`);

  // Generate keys
  const publicKey = generateApiKey('pk');
  const adminKey = generateApiKey('sk');
  const publicHash = await hashKey(publicKey);
  const adminHash = await hashKey(adminKey);

  console.log('🔑 Creating API keys...');
  runSql(`INSERT OR IGNORE INTO api_keys (id, store_id, key_hash, key_prefix, role) VALUES ('${crypto.randomUUID()}', '${storeId}', '${publicHash}', 'pk_', 'public')`);
  runSql(`INSERT OR IGNORE INTO api_keys (id, store_id, key_hash, key_prefix, role) VALUES ('${crypto.randomUUID()}', '${storeId}', '${adminHash}', 'sk_', 'admin')`);

  console.log('\n✅ Store created!\n');
  console.log('─'.repeat(50));
  console.log('\n🔑 API Keys (save these, shown only once):\n');
  console.log(`   Public:  ${publicKey}`);
  console.log(`   Admin:   ${adminKey}`);
  console.log('\n' + '─'.repeat(50));
  console.log('\n📝 Next steps:\n');
  console.log('   1. Start the API:');
  console.log('      npm run dev\n');
  console.log('   2. Connect Stripe (optional for testing):');
  console.log(`      curl -X POST http://localhost:8787/v1/setup/stripe \\`);
  console.log(`        -H "Authorization: Bearer ${adminKey}" \\`);
  console.log(`        -H "Content-Type: application/json" \\`);
  console.log(`        -d '{"stripe_secret_key":"sk_test_...","stripe_webhook_secret":"whsec_..."}'\n`);
  console.log('   3. Seed demo data:');
  console.log(`      npx tsx scripts/seed.ts http://localhost:8787 ${adminKey}\n`);
  console.log('   4. Start admin dashboard:');
  console.log('      cd admin && npm install && npm run dev\n');
}

init().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
