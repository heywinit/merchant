# merchant

**The open-source commerce backend for Cloudflare + Stripe. Bring a Stripe key. Start selling.**

A lightweight, API-first backend for products, inventory, checkout, and orders—designed to run on Cloudflare Workers with Stripe handling payments.

## Quick Start

```bash
# 1. Clone & Install
git clone https://github.com/ygwyg/merchant
cd merchant && npm install

# 2. Initialize (creates store + API keys)
npx tsx scripts/init.ts

# 3. Start the API
npm run dev

# 4. Seed demo data (optional)
npx tsx scripts/seed.ts http://localhost:8787 sk_your_admin_key

# 5. Connect Stripe
curl -X POST http://localhost:8787/v1/setup/stripe \
  -H "Authorization: Bearer sk_your_admin_key" \
  -H "Content-Type: application/json" \
  -d '{"stripe_secret_key":"sk_test_..."}'

# 6. Admin dashboard
cd admin && npm install && npm run dev
```

## Deploy to Cloudflare

```bash
# Create D1 database
wrangler d1 create merchant-db
# Update database_id in wrangler.toml with the returned ID

# Create R2 bucket
wrangler r2 bucket create merchant-images

# Deploy
wrangler deploy

# Run init script against production
npx tsx scripts/init.ts --remote
```

## API Reference

All endpoints require `Authorization: Bearer <key>` header.

- `pk_...` → Public key. Can create carts and checkout.
- `sk_...` → Admin key. Full access to everything.

### Products (admin)

```bash
# List products
GET /v1/products

# Create product
POST /v1/products
{"title": "T-Shirt", "description": "Premium cotton tee"}

# Update product
PATCH /v1/products/{id}
{"title": "Updated Title", "status": "draft"}

# Add variant
POST /v1/products/{id}/variants
{"sku": "TEE-BLK-M", "title": "Black / M", "price_cents": 2999}
```

### Inventory (admin)

```bash
# List all inventory
GET /v1/inventory

# Get single SKU
GET /v1/inventory?sku=TEE-BLK-M

# Adjust inventory
POST /v1/inventory/{sku}/adjust
{"delta": 100, "reason": "restock"}
# reason: restock | correction | damaged | return
```

### Checkout (public)

```bash
# Create cart
POST /v1/carts
{"customer_email": "buyer@example.com"}

# Add items to cart
POST /v1/carts/{id}/items
{"items": [{"sku": "TEE-BLK-M", "qty": 2}]}

# Checkout → returns Stripe URL
POST /v1/carts/{id}/checkout
{"success_url": "https://...", "cancel_url": "https://..."}
```

### Orders (admin)

```bash
# List orders
GET /v1/orders

# Get order details
GET /v1/orders/{id}

# Refund order
POST /v1/orders/{id}/refund
{"amount_cents": 1000}  # optional, omit for full refund

# Create test order (skips Stripe, for testing)
POST /v1/orders/test
{"customer_email": "test@example.com", "items": [{"sku": "TEE-BLK-M", "qty": 1}]}
```

### Images (admin)

```bash
# Upload image
POST /v1/images
Content-Type: multipart/form-data
file: <image file>
# Returns: {"url": "...", "key": "..."}

# Delete image
DELETE /v1/images/{key}
```

### Setup (admin)

```bash
# Connect Stripe
POST /v1/setup/stripe
{"stripe_secret_key": "sk_...", "stripe_webhook_secret": "whsec_..."}
```

## Webhooks

Set your Stripe webhook endpoint to `https://your-domain/v1/webhooks/stripe`

Events handled:
- `checkout.session.completed` → Creates order, deducts inventory

For local development:
```bash
stripe listen --forward-to localhost:8787/v1/webhooks/stripe
```

## Admin Dashboard

```bash
cd admin && npm run dev
```

Connect with your API URL and admin key (`sk_...`).

Features:
- View and search orders
- Manage inventory levels
- View products and variants
- Upload variant images

## Architecture

```
src/
├── index.ts          # Entry point, routes
├── db.ts             # D1 database wrapper
├── types.ts          # Types and errors
├── cron.ts           # Expired cart cleanup
├── middleware/
│   └── auth.ts       # API key auth
└── routes/
    ├── catalog.ts    # Products & variants
    ├── checkout.ts   # Carts & Stripe checkout
    ├── orders.ts     # Order management
    ├── inventory.ts  # Stock levels
    ├── images.ts     # R2 image upload
    ├── setup.ts      # Store configuration
    └── webhooks.ts   # Stripe webhooks
```

## Stack

| Component | Technology |
|-----------|------------|
| Runtime | Cloudflare Workers |
| Framework | Hono |
| Database | D1 (SQLite) |
| Images | R2 |
| Payments | Stripe |

## Scaling

For high traffic, switch from D1 to Postgres via Hyperdrive:

1. Create a Postgres database (Neon, Supabase, etc.)
2. Create a Hyperdrive config: `wrangler hyperdrive create merchant-db --connection-string="..."`
3. Uncomment Hyperdrive in `wrangler.toml`
4. Apply `schema-postgres.sql` to your database

## License

MIT
