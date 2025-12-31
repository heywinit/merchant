// ============================================================
// MERCHANT API CLIENT
// ============================================================
// Copy this to api.js and update with your keys:
//   cp src/api.example.js src/api.js

// Configuration - update these with your values
const API_URL = 'http://localhost:8787';
const PUBLIC_KEY = 'pk_your_public_key_here';

async function request(endpoint, options = {}) {
  const res = await fetch(`${API_URL}${endpoint}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${PUBLIC_KEY}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error?.message || 'API request failed');
  }

  return data;
}

// ============================================================
// PRODUCTS
// ============================================================

export async function getProducts() {
  const data = await request('/v1/products');
  // Filter to only active products with variants
  return data.items.filter(p => p.status === 'active' && p.variants?.length > 0);
}

export async function getProduct(id) {
  return request(`/v1/products/${id}`);
}

// ============================================================
// CHECKOUT
// ============================================================

export async function createCart(email) {
  return request('/v1/carts', {
    method: 'POST',
    body: JSON.stringify({ customer_email: email }),
  });
}

export async function addItemsToCart(cartId, items) {
  return request(`/v1/carts/${cartId}/items`, {
    method: 'POST',
    body: JSON.stringify({ items }),
  });
}

export async function checkout(cartId, successUrl, cancelUrl) {
  return request(`/v1/carts/${cartId}/checkout`, {
    method: 'POST',
    body: JSON.stringify({
      success_url: successUrl,
      cancel_url: cancelUrl,
      collect_shipping: true,
      shipping_countries: ['US', 'CA', 'GB', 'AU'],
    }),
  });
}

