// ============================================================
// PRODUCT LISTING PAGE
// ============================================================

import { getProducts } from './api.js';
import { addToCart, updateCartBadge } from './cart.js';

async function init() {
  updateCartBadge();
  
  const grid = document.getElementById('products-grid');
  const loading = document.getElementById('loading');
  const error = document.getElementById('error');

  try {
    const products = await getProducts();
    loading.style.display = 'none';

    if (products.length === 0) {
      grid.innerHTML = `
        <div class="col-span-full text-center py-12 text-zinc-500">
          No products yet. Run the seed script to add some!
        </div>
      `;
      return;
    }

    grid.innerHTML = products.map(product => {
      const variant = product.variants[0]; // Default to first variant
      const price = (variant.price_cents / 100).toFixed(2);
      const image = variant.image_url || product.image_url || 'https://placehold.co/400x400/1a1a1a/666?text=No+Image';

      return `
        <div class="group" data-product-id="${product.id}">
          <div class="aspect-square bg-zinc-900 rounded-xl overflow-hidden mb-4 relative">
            <img 
              src="${image}" 
              alt="${product.title}"
              class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
              onerror="this.src='https://placehold.co/400x400/1a1a1a/666?text=No+Image'"
            >
            ${product.variants.length > 1 ? `
              <span class="absolute top-3 left-3 bg-black/70 text-white text-xs px-2 py-1 rounded">
                ${product.variants.length} options
              </span>
            ` : ''}
          </div>
          <h3 class="font-medium text-white mb-1">${product.title}</h3>
          <p class="text-zinc-400 text-sm mb-3">$${price}</p>
          
          ${product.variants.length > 1 ? `
            <select class="variant-select w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white mb-3 focus:outline-none focus:border-zinc-700">
              ${product.variants.map(v => `
                <option value="${v.sku}" data-price="${v.price_cents}" data-image="${v.image_url || ''}">
                  ${v.title} - $${(v.price_cents / 100).toFixed(2)}
                </option>
              `).join('')}
            </select>
          ` : ''}
          
          <button 
            class="add-to-cart w-full bg-white text-black font-medium py-2.5 rounded-lg hover:bg-zinc-200 transition-colors"
            data-sku="${variant.sku}"
          >
            Add to Cart
          </button>
        </div>
      `;
    }).join('');

    // Store products for reference
    window.__products = products;

    // Bind add to cart buttons
    grid.querySelectorAll('.add-to-cart').forEach(btn => {
      btn.addEventListener('click', handleAddToCart);
    });

    // Bind variant selects
    grid.querySelectorAll('.variant-select').forEach(select => {
      select.addEventListener('change', handleVariantChange);
    });

  } catch (err) {
    loading.style.display = 'none';
    error.style.display = 'block';
    error.querySelector('p').textContent = err.message;
    console.error('Failed to load products:', err);
  }
}

function handleVariantChange(e) {
  const select = e.target;
  const card = select.closest('[data-product-id]');
  const btn = card.querySelector('.add-to-cart');
  btn.dataset.sku = select.value;
}

function handleAddToCart(e) {
  const btn = e.target;
  const sku = btn.dataset.sku;
  const card = btn.closest('[data-product-id]');
  const productId = card.dataset.productId;
  
  const product = window.__products.find(p => p.id === productId);
  const variant = product.variants.find(v => v.sku === sku);

  addToCart(variant, product);

  // Visual feedback
  const originalText = btn.textContent;
  btn.textContent = 'Added!';
  btn.classList.add('bg-green-500', 'text-white');
  btn.classList.remove('bg-white', 'text-black');

  setTimeout(() => {
    btn.textContent = originalText;
    btn.classList.remove('bg-green-500', 'text-white');
    btn.classList.add('bg-white', 'text-black');
  }, 1000);
}

init();

