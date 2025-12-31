// ============================================================
// CART PAGE
// ============================================================

import { createCart, addItemsToCart, checkout } from './api.js';
import { getCart, updateQuantity, removeFromCart, clearCart, getCartTotal, updateCartBadge } from './cart.js';

const SUCCESS_URL = window.location.origin + '/success.html';
const CANCEL_URL = window.location.origin + '/cart.html';

function formatPrice(cents) {
  return (cents / 100).toFixed(2);
}

function renderCart() {
  updateCartBadge();
  
  const container = document.getElementById('cart-items');
  const emptyState = document.getElementById('empty-cart');
  const cartContent = document.getElementById('cart-content');
  const subtotalEl = document.getElementById('subtotal');
  const items = getCart();

  if (items.length === 0) {
    emptyState.style.display = 'block';
    cartContent.style.display = 'none';
    return;
  }

  emptyState.style.display = 'none';
  cartContent.style.display = 'block';

  container.innerHTML = items.map(item => `
    <div class="flex gap-4 py-4 border-b border-zinc-800" data-sku="${item.sku}">
      <div class="w-20 h-20 bg-zinc-900 rounded-lg overflow-hidden flex-shrink-0">
        <img 
          src="${item.image_url || 'https://placehold.co/80x80/1a1a1a/666?text=•'}" 
          alt="${item.title}"
          class="w-full h-full object-cover"
          onerror="this.src='https://placehold.co/80x80/1a1a1a/666?text=•'"
        >
      </div>
      <div class="flex-1 min-w-0">
        <h3 class="font-medium text-white truncate">${item.title}</h3>
        <p class="text-zinc-400 text-sm">$${formatPrice(item.price_cents)}</p>
        <div class="flex items-center gap-3 mt-2">
          <div class="flex items-center border border-zinc-700 rounded-lg">
            <button class="qty-btn px-3 py-1 text-zinc-400 hover:text-white" data-delta="-1">−</button>
            <span class="qty-display px-2 text-white">${item.qty}</span>
            <button class="qty-btn px-3 py-1 text-zinc-400 hover:text-white" data-delta="1">+</button>
          </div>
          <button class="remove-btn text-zinc-500 hover:text-red-400 text-sm">Remove</button>
        </div>
      </div>
      <div class="text-right">
        <p class="font-medium text-white">$${formatPrice(item.price_cents * item.qty)}</p>
      </div>
    </div>
  `).join('');

  subtotalEl.textContent = `$${formatPrice(getCartTotal())}`;

  // Bind quantity buttons
  container.querySelectorAll('.qty-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const row = e.target.closest('[data-sku]');
      const sku = row.dataset.sku;
      const delta = parseInt(e.target.dataset.delta);
      const item = getCart().find(i => i.sku === sku);
      if (item) {
        updateQuantity(sku, item.qty + delta);
        renderCart();
      }
    });
  });

  // Bind remove buttons
  container.querySelectorAll('.remove-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const row = e.target.closest('[data-sku]');
      removeFromCart(row.dataset.sku);
      renderCart();
    });
  });
}

async function handleCheckout() {
  const emailInput = document.getElementById('email');
  const checkoutBtn = document.getElementById('checkout-btn');
  const errorEl = document.getElementById('checkout-error');
  
  const email = emailInput.value.trim();
  
  if (!email || !email.includes('@')) {
    errorEl.textContent = 'Please enter a valid email address';
    errorEl.style.display = 'block';
    emailInput.focus();
    return;
  }

  errorEl.style.display = 'none';
  checkoutBtn.disabled = true;
  checkoutBtn.textContent = 'Processing...';

  try {
    const items = getCart();
    
    // Create cart in Merchant
    const cart = await createCart(email);
    
    // Add items
    await addItemsToCart(cart.id, items.map(i => ({ sku: i.sku, qty: i.qty })));
    
    // Start checkout
    const { checkout_url } = await checkout(cart.id, SUCCESS_URL, CANCEL_URL);
    
    // Clear local cart before redirect
    clearCart();
    
    // Redirect to Stripe
    window.location.href = checkout_url;
    
  } catch (err) {
    errorEl.textContent = err.message || 'Checkout failed. Please try again.';
    errorEl.style.display = 'block';
    checkoutBtn.disabled = false;
    checkoutBtn.textContent = 'Checkout';
    console.error('Checkout error:', err);
  }
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  renderCart();
  
  document.getElementById('checkout-btn')?.addEventListener('click', handleCheckout);
  
  // Allow enter key on email input
  document.getElementById('email')?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleCheckout();
  });
});

