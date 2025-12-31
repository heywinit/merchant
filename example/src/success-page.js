// ============================================================
// SUCCESS PAGE
// ============================================================

import { clearCart, updateCartBadge } from './cart.js';

document.addEventListener('DOMContentLoaded', () => {
  // Clear the cart on success
  clearCart();
  updateCartBadge();
  
  // Get session ID from URL if present
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get('session_id');
  
  if (sessionId) {
    const sessionEl = document.getElementById('session-id');
    if (sessionEl) {
      sessionEl.textContent = sessionId;
      sessionEl.parentElement.style.display = 'block';
    }
  }
});

