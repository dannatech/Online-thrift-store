'use strict';

const $ = (sel) => document.querySelector(sel);
const money = (n) => `$${Number(n).toFixed(2)}`;
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const sizeLabel = (size) => (size && size !== 'One Size' ? ` · Size ${escapeHtml(size)}` : '');

const CART_KEY = 'thrift-cart';
const state = {
  products: [],
  cart: loadCart(), // array of product snapshots { id, title, price, emoji }
};

function loadCart() {
  try { return JSON.parse(localStorage.getItem(CART_KEY)) || []; } catch { return []; }
}
function saveCart() {
  try { localStorage.setItem(CART_KEY, JSON.stringify(state.cart)); } catch { /* storage unavailable */ }
  renderCart();
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed'), { data });
  return data;
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, 2500);
}

/* ---------- Catalog ---------- */

function filterParams() {
  const params = new URLSearchParams();
  const q = $('#search').value.trim();
  if (q) params.set('q', q);
  if ($('#f-category').value) params.set('category', $('#f-category').value);
  if ($('#f-condition').value) params.set('condition', $('#f-condition').value);
  if ($('#f-price').value !== $('#f-price').max) params.set('maxPrice', $('#f-price').value);
  params.set('sort', $('#f-sort').value);
  return params;
}

async function loadProducts() {
  try {
    state.products = await api(`/api/products?${filterParams()}`);
    renderGrid();
  } catch (err) {
    $('#grid').innerHTML = `<p class="empty">Couldn't load items: ${escapeHtml(err.message)}</p>`;
  }
}

function inCart(id) {
  return state.cart.some((item) => item.id === id);
}

function renderGrid() {
  const { products } = state;
  $('#result-count').textContent = `${products.length} item${products.length === 1 ? '' : 's'} available`;
  if (!products.length) {
    $('#grid').innerHTML = '<p class="empty">No items match your filters. Try widening your search.</p>';
    return;
  }
  $('#grid').innerHTML = products.map((p) => `
    <article class="card" tabindex="0" data-id="${escapeHtml(p.id)}">
      <div class="thumb" aria-hidden="true">${escapeHtml(p.emoji || '🏷️')}</div>
      <div class="card-body">
        <div class="card-title">${escapeHtml(p.title)}</div>
        <div class="card-meta">${escapeHtml(p.category)}${sizeLabel(p.size)}</div>
        <div class="card-foot">
          <span class="price">${money(p.price)}</span>
          <span class="tag">${escapeHtml(p.condition)}</span>
        </div>
      </div>
    </article>`).join('');
}

function openProduct(id) {
  const p = state.products.find((x) => x.id === id);
  if (!p) return;
  const added = inCart(p.id);
  $('#product-detail').innerHTML = `
    <div class="detail-thumb" aria-hidden="true">${escapeHtml(p.emoji || '🏷️')}</div>
    <h2 style="margin-top:1rem">${escapeHtml(p.title)}</h2>
    <div class="detail-tags">
      <span class="tag">${escapeHtml(p.category)}</span>
      <span class="tag">${p.size && p.size !== 'One Size' ? `Size ${escapeHtml(p.size)}` : 'One size'}</span>
      <span class="tag">${escapeHtml(p.condition)}</span>
    </div>
    <p>${escapeHtml(p.description || 'No description provided.')}</p>
    <p class="muted">Sold by ${escapeHtml(p.seller)}</p>
    <div class="detail-actions">
      <span class="price">${money(p.price)}</span>
      <div>
        <button class="btn btn-outline" data-close-dialog>Close</button>
        <button class="btn" id="add-to-cart" ${added ? 'disabled' : ''}>${added ? 'In cart' : 'Add to cart'}</button>
      </div>
    </div>`;
  $('#add-to-cart').addEventListener('click', () => {
    state.cart.push({ id: p.id, title: p.title, price: p.price, emoji: p.emoji });
    saveCart();
    $('#product-dialog').close();
    toast(`Added “${p.title}” to your cart`);
  });
  $('#product-dialog').showModal();
}

/* ---------- Cart & checkout ---------- */

function renderCart() {
  $('#cart-count').textContent = state.cart.length;
  const total = state.cart.reduce((sum, i) => sum + i.price, 0);
  $('#cart-total').textContent = money(total);
  $('#cart-items').innerHTML = state.cart.length
    ? state.cart.map((i) => `
      <li>
        <span class="emoji" aria-hidden="true">${escapeHtml(i.emoji || '🏷️')}</span>
        <div class="info"><div>${escapeHtml(i.title)}</div><div class="muted">${money(i.price)}</div></div>
        <button class="icon-btn" data-remove="${escapeHtml(i.id)}" aria-label="Remove ${escapeHtml(i.title)}">🗑️</button>
      </li>`).join('')
    : '<li class="muted">Your cart is empty.</li>';
  $('#checkout-form').querySelector('button[type=submit]').disabled = !state.cart.length;
}

function setCartOpen(open) {
  $('#cart').classList.toggle('open', open);
  $('#cart').setAttribute('aria-hidden', String(!open));
  $('#backdrop').hidden = !open;
}

async function checkout(e) {
  e.preventDefault();
  const form = e.target;
  const err = $('#checkout-error');
  err.textContent = '';
  const customer = Object.fromEntries(new FormData(form));
  try {
    const order = await api('/api/orders', {
      method: 'POST',
      body: { items: state.cart.map((i) => i.id), customer },
    });
    state.cart = [];
    saveCart();
    form.reset();
    setCartOpen(false);
    toast(`Order placed! Total ${money(order.total)} — thank you, ${customer.name}.`);
    loadProducts();
  } catch (ex) {
    err.textContent = ex.message;
    // Someone else bought an item first: drop it from the cart so the rest can go through.
    if (ex.data?.soldIds) {
      state.cart = state.cart.filter((i) => !ex.data.soldIds.includes(i.id));
      saveCart();
      loadProducts();
    }
  }
}

/* ---------- Sell ---------- */

async function sell(e) {
  e.preventDefault();
  const form = e.target;
  const err = $('#sell-error');
  err.textContent = '';
  try {
    const product = await api('/api/products', { method: 'POST', body: Object.fromEntries(new FormData(form)) });
    form.reset();
    $('#sell-dialog').close();
    toast(`“${product.title}” is now listed!`);
    loadProducts();
  } catch (ex) {
    err.textContent = ex.message;
  }
}

/* ---------- Init ---------- */

function fillSelect(el, options) {
  el.insertAdjacentHTML('beforeend', options.map((o) => `<option>${escapeHtml(o)}</option>`).join(''));
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

async function init() {
  const meta = await api('/api/meta');
  fillSelect($('#f-category'), meta.categories);
  fillSelect($('#f-condition'), meta.conditions);
  fillSelect($('#sell-category'), meta.categories);
  fillSelect($('#sell-condition'), meta.conditions);

  $('#search').addEventListener('input', debounce(loadProducts, 250));
  ['#f-category', '#f-condition', '#f-sort'].forEach((s) => $(s).addEventListener('change', loadProducts));
  $('#f-price').addEventListener('input', () => {
    const v = $('#f-price').value;
    $('#f-price-label').textContent = v === $('#f-price').max ? 'Any' : `≤ $${v}`;
  });
  $('#f-price').addEventListener('change', loadProducts);
  $('#f-reset').addEventListener('click', () => {
    $('#search').value = '';
    $('#f-category').value = '';
    $('#f-condition').value = '';
    $('#f-sort').value = 'newest';
    $('#f-price').value = $('#f-price').max;
    $('#f-price-label').textContent = 'Any';
    loadProducts();
  });

  $('#grid').addEventListener('click', (e) => {
    const card = e.target.closest('.card');
    if (card) openProduct(card.dataset.id);
  });
  $('#grid').addEventListener('keydown', (e) => {
    const card = e.target.closest('.card');
    if (card && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openProduct(card.dataset.id); }
  });

  document.addEventListener('click', (e) => {
    if (e.target.matches('[data-close-dialog]')) e.target.closest('dialog').close();
    if (e.target.matches('[data-close-cart]')) setCartOpen(false);
    const remove = e.target.closest('[data-remove]');
    if (remove) {
      state.cart = state.cart.filter((i) => i.id !== remove.dataset.remove);
      saveCart();
    }
  });
  $('#cart-btn').addEventListener('click', () => setCartOpen(true));
  $('#backdrop').addEventListener('click', () => setCartOpen(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setCartOpen(false); });

  $('#checkout-form').addEventListener('submit', checkout);
  $('#sell-btn').addEventListener('click', () => $('#sell-dialog').showModal());
  $('#sell-form').addEventListener('submit', sell);

  renderCart();
  loadProducts();
}

init();
