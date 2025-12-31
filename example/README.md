# Example Store

A minimal swag store demonstrating the Merchant API.

## Setup

1. **Start the Merchant API** (from root):
   ```bash
   npm run dev
   ```

2. **Run the init script** to get your API keys:
   ```bash
   npx tsx scripts/init.ts
   ```

3. **Seed some products**:
   ```bash
   npx tsx scripts/seed.ts http://localhost:8787 sk_your_admin_key
   ```

4. **Create your API config**:
   ```bash
   cp src/api.example.js src/api.js
   ```
   Then edit `src/api.js` and update with your public key from the init output.

5. **Start the store**:
   ```bash
   cd example
   npm run dev
   ```

6. Open http://localhost:3000

## How It Works

- **Products** — Fetched from `/v1/products` using the public key
- **Cart** — Stored in localStorage, synced to Merchant cart on checkout
- **Checkout** — Creates a Merchant cart, then redirects to Stripe Checkout
- **Success** — Shows confirmation after payment

## Files

```
index.html      → Product listing
cart.html       → Shopping cart
success.html    → Post-checkout confirmation
src/
  config.js     → API URL and public key
  api.js        → Merchant API client
  cart.js       → Cart state management
  main.js       → Product listing logic
  cart-page.js  → Cart page logic
```

## Customization

- Update `src/config.js` with your API URL and key
- Replace product images in the UI (or use image URLs from your products)
- Modify styles directly in HTML (Tailwind via CDN)

