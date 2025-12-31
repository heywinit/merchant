// ============================================================
// CART STATE (localStorage)
// ============================================================

const CART_KEY = 'merchant_cart';

export function getCart() {
  try {
    return JSON.parse(localStorage.getItem(CART_KEY)) || [];
  } catch {
    return [];
  }
}

export function saveCart(items) {
  localStorage.setItem(CART_KEY, JSON.stringify(items));
  updateCartBadge();
}

export function addToCart(variant, product) {
  const cart = getCart();
  const existing = cart.find(item => item.sku === variant.sku);

  if (existing) {
    existing.qty += 1;
  } else {
    cart.push({
      sku: variant.sku,
      title: `${product.title} - ${variant.title}`,
      price_cents: variant.price_cents,
      image_url: variant.image_url || product.image_url,
      qty: 1,
    });
  }

  saveCart(cart);
  return cart;
}

export function updateQuantity(sku, qty) {
  let cart = getCart();
  
  if (qty <= 0) {
    cart = cart.filter(item => item.sku !== sku);
  } else {
    const item = cart.find(item => item.sku === sku);
    if (item) item.qty = qty;
  }

  saveCart(cart);
  return cart;
}

export function removeFromCart(sku) {
  return updateQuantity(sku, 0);
}

export function clearCart() {
  localStorage.removeItem(CART_KEY);
  updateCartBadge();
}

export function getCartTotal() {
  return getCart().reduce((sum, item) => sum + (item.price_cents * item.qty), 0);
}

export function getCartCount() {
  return getCart().reduce((sum, item) => sum + item.qty, 0);
}

export function updateCartBadge() {
  const badge = document.getElementById('cart-count');
  if (badge) {
    const count = getCartCount();
    badge.textContent = count;
    badge.style.display = count > 0 ? 'flex' : 'none';
  }
}

// Initialize badge on load
if (typeof window !== 'undefined') {
  document.addEventListener('DOMContentLoaded', updateCartBadge);
}

