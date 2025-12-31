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

D1 and R2 are **auto-provisioned** on first deploy — no manual setup required!

```bash
# Deploy (D1 database + R2 bucket created automatically)
wrangler deploy

# Run init script against production
npx tsx scripts/init.ts --remote
```

Resource IDs will be written back to `wrangler.jsonc` after deploy.

## API Reference

All endpoints require `Authorization: Bearer <key>` header.

- `pk_...` → Public key. Can create carts and checkout.
- `sk_...` → Admin key. Full access to everything.

### Products (admin)

```bash
# List products (with pagination)
GET /v1/products?limit=20&cursor=...&status=active

# Get single product
GET /v1/products/{id}

# Create product
POST /v1/products
{"title": "T-Shirt", "description": "Premium cotton tee"}

# Update product
PATCH /v1/products/{id}
{"title": "Updated Title", "status": "draft"}

# Delete product (fails if variants have been ordered)
DELETE /v1/products/{id}

# Add variant
POST /v1/products/{id}/variants
{"sku": "TEE-BLK-M", "title": "Black / M", "price_cents": 2999}

# Update variant
PATCH /v1/products/{id}/variants/{variantId}
{"price_cents": 3499}

# Delete variant (fails if ordered)
DELETE /v1/products/{id}/variants/{variantId}
```

### Inventory (admin)

```bash
# List inventory (with pagination)
GET /v1/inventory?limit=100&cursor=...&low_stock=true

# Get single SKU
GET /v1/inventory?sku=TEE-BLK-M

# Adjust inventory
POST /v1/inventory/{sku}/adjust
{"delta": 100, "reason": "restock"}
# reason: restock | correction | damaged | return
```

**Query params:**
- `limit` — Max items per page (default 100, max 500)
- `cursor` — Pagination cursor (SKU of last item)
- `low_stock` — Filter items with ≤10 available

### Checkout (public)

```bash
# Create cart
POST /v1/carts
{"customer_email": "buyer@example.com"}

# Get cart
GET /v1/carts/{id}

# Add items to cart (replaces existing items)
POST /v1/carts/{id}/items
{"items": [{"sku": "TEE-BLK-M", "qty": 2}]}

# Checkout → returns Stripe URL
POST /v1/carts/{id}/checkout
{
  "success_url": "https://...",
  "cancel_url": "https://...",
  "collect_shipping": true,
  "shipping_countries": ["US", "CA", "GB"]
}
```

**Checkout options:**
- `collect_shipping` — Enable shipping address collection
- `shipping_countries` — Allowed countries (default: `["US"]`)
- `shipping_options` — Custom shipping rates (optional, has sensible defaults)

Automatic tax calculation is enabled via Stripe Tax.

### Customers (admin)

```bash
# List customers (with pagination and search)
GET /v1/customers?limit=20&cursor=...&search=john@example.com

# Get customer with addresses
GET /v1/customers/{id}

# Get customer's order history
GET /v1/customers/{id}/orders

# Update customer
PATCH /v1/customers/{id}
{"name": "John Doe", "phone": "+1234567890"}

# Add address
POST /v1/customers/{id}/addresses
{"line1": "123 Main St", "city": "NYC", "postal_code": "10001"}

# Delete address
DELETE /v1/customers/{id}/addresses/{addressId}
```

Customers are automatically created from Stripe checkout sessions (guest checkout by email).

### Orders (admin)

```bash
# List orders (with pagination and filters)
GET /v1/orders?limit=20&cursor=...&status=shipped&email=customer@example.com

# Get order details
GET /v1/orders/{id}

# Update order status/tracking
PATCH /v1/orders/{id}
{"status": "shipped", "tracking_number": "1Z999...", "tracking_url": "https://..."}

# Refund order
POST /v1/orders/{id}/refund
{"amount_cents": 1000}  # optional, omit for full refund

# Create test order (skips Stripe, for testing)
POST /v1/orders/test
{"customer_email": "test@example.com", "items": [{"sku": "TEE-BLK-M", "qty": 1}]}
```

**Order statuses:** `pending` → `paid` → `processing` → `shipped` → `delivered` | `refunded` | `canceled`

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

### Outbound Webhooks (admin)

```bash
# List webhooks
GET /v1/webhooks

# Create webhook
POST /v1/webhooks
{"url": "https://your-server.com/webhook", "events": ["order.created", "order.shipped"]}

# Get webhook (includes recent deliveries)
GET /v1/webhooks/{id}

# Update webhook
PATCH /v1/webhooks/{id}
{"events": ["*"], "status": "paused"}

# Rotate secret
POST /v1/webhooks/{id}/rotate-secret

# Delete webhook
DELETE /v1/webhooks/{id}
```

**Events:** `order.created`, `order.updated`, `order.shipped`, `order.refunded`, `inventory.low`

**Wildcards:** `order.*` or `*` for all events

Payloads are signed with HMAC-SHA256. Verify with the `X-Merchant-Signature` header.

## Stripe Webhooks

Set your Stripe webhook endpoint to `https://your-domain/v1/webhooks/stripe`

Events handled:
- `checkout.session.completed` → Creates order, deducts inventory

For local development:
```bash
stripe listen --forward-to localhost:8787/v1/webhooks/stripe
```

## Rate Limiting

All endpoints return rate limit headers:
- `X-RateLimit-Limit` — Requests allowed per window
- `X-RateLimit-Remaining` — Requests remaining
- `X-RateLimit-Reset` — Unix timestamp when window resets

Limits are configurable in `src/config/rate-limits.ts`.

## Admin Dashboard

```bash
cd admin && npm install && npm run dev
```

Connect with your API URL and admin key (`sk_...`).

## Example Store

A complete vanilla JS storefront demonstrating the full checkout flow:

```bash
cd example && npm run dev
```

Update `example/src/config.js` with your public key (`pk_...`), then open http://localhost:3000

Features:
- **Orders** — Search, filter by status, update tracking, one-click refunds
- **Inventory** — View stock levels, quick adjustments (+10, +50, etc.)
- **Products** — Create products, add/edit variants, upload images
- **Webhooks** — Create endpoints, view delivery history, rotate secrets
- Light/dark mode, collapsible sidebar

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
    ├── customers.ts  # Customer management
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


## License

MIT
