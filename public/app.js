'use strict';

const $ = (sel) => document.querySelector(sel);
const money = (n) => `$${Number(n).toFixed(2).replace(/\.00$/, '')}`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

// Each category gets one of the soft tile tints defined in styles.css.
const CATEGORY_TINT = { Clothing: 1, Shoes: 2, Accessories: 3, Books: 4, Home: 5, Electronics: 6, Other: 6 };
const tint = (category) => `--tint: var(--tint-${CATEGORY_TINT[category] || 6})`;
const boothTint = (i) => `--tint: var(--tint-${(i % 6) + 1})`;
const hasSize = (size) => size && size !== 'One Size';

const CART_KEY = 'thrift-cart';
const state = {
  products: [],
  booths: [],
  booth: '',     // selected booth (seller name); '' means every booth
  category: '',  // selected category chip; '' means all
  payments: 'demo', // 'stripe' when the server takes real payments
  cart: loadCart(), // array of product snapshots { id, title, price, emoji, category }
};

function loadCart() {
  try { return JSON.parse(localStorage.getItem(CART_KEY)) || []; } catch { return []; }
}
function saveCart() {
  try { localStorage.setItem(CART_KEY, JSON.stringify(state.cart)); } catch { /* storage unavailable */ }
  renderCart();
}

// Where the market server lives. '' means the same site that served this page;
// config.js sets a full URL when the storefront is hosted separately (e.g. GitHub Pages).
const API_BASE = (window.MARKET_CONFIG?.apiBase || '').replace(/\/$/, '');
let demoApi = null; // set when no server answers and the in-browser demo takes over

async function api(path, options = {}) {
  const body = options.body ? JSON.stringify(options.body) : undefined;
  if (demoApi) return demoApi(path, { method: options.method, body });
  const res = await fetch(API_BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed'), { data });
  return data;
}

/** Find the market server, or fall back to the in-browser demo when there isn't one. */
async function connect() {
  try {
    return await api('/api/meta');
  } catch (err) {
    // A configured server that doesn't answer is an outage, not a demo: say so.
    if (API_BASE) throw new Error(`The market server isn't responding (${err.message}).`);
    demoApi = await window.createDemoApi();
    return api('/api/meta');
  }
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, 2600);
}

/* ---------- Catalog ---------- */

function filterParams() {
  const params = new URLSearchParams();
  const q = $('#search').value.trim();
  if (q) params.set('q', q);
  if (state.category) params.set('category', state.category);
  if (state.booth) params.set('seller', state.booth);
  if ($('#f-condition').value) params.set('condition', $('#f-condition').value);
  if ($('#f-price').value) params.set('maxPrice', $('#f-price').value);
  params.set('sort', $('#f-sort').value);
  return params;
}

function filtersActive() {
  return Boolean($('#search').value.trim() || state.category || state.booth
    || $('#f-condition').value || $('#f-price').value || $('#f-sort').value !== 'newest');
}

async function loadProducts() {
  $('#f-reset').hidden = !filtersActive();
  try {
    state.products = await api(`/api/products?${filterParams()}`);
    renderGrid();
  } catch (err) {
    $('#grid').innerHTML = `<p class="empty"><strong>Couldn't load items</strong>${escapeHtml(err.message)}</p>`;
  }
}

function renderSkeleton() {
  $('#grid').innerHTML = Array.from({ length: 8 }, () => `
    <div class="card skeleton" aria-hidden="true">
      <div class="thumb"></div>
      <div class="bar" style="width:70%"></div>
      <div class="bar" style="width:40%"></div>
    </div>`).join('');
}

async function loadBooths() {
  try {
    state.booths = await api('/api/booths');
  } catch {
    state.booths = [];
  }
  // A booth that sold out disappears from the market.
  if (state.booth && !state.booths.some((b) => b.name === state.booth)) state.booth = '';
  renderBooths();
}

function renderBooths() {
  const total = state.booths.reduce((sum, b) => sum + b.available, 0);
  $('#stat-items').textContent = total;
  $('#stat-booths').textContent = state.booths.length;

  const booth = (name, label, emoji, count, i) => `
    <button class="booth" role="listitem" data-booth="${escapeHtml(name)}" aria-pressed="${state.booth === name}">
      <span class="booth-avatar" style="${boothTint(i)}" aria-hidden="true">${escapeHtml(emoji)}</span>
      <span><span class="booth-name">${escapeHtml(label)}</span><span class="booth-count">${plural(count, 'item')}</span></span>
    </button>`;
  $('#booth-row').innerHTML = booth('', 'All booths', '🧺', total, 0)
    + state.booths.map((b, i) => booth(b.name, b.name, b.emoji || '🏷️', b.available, i + 1)).join('');
  $('#booth-names').innerHTML = state.booths.map((b) => `<option value="${escapeHtml(b.name)}">`).join('');
}

function boothIndex(name) {
  return state.booths.findIndex((b) => b.name === name) + 1;
}

function renderChips(categories) {
  $('#category-chips').innerHTML = ['', ...categories].map((c) => `
    <button class="chip" data-category="${escapeHtml(c)}" aria-pressed="${state.category === c}">${escapeHtml(c || 'All')}</button>`).join('');
}

function selectBooth(name) {
  state.booth = name;
  renderBooths();
  loadProducts();
}

function inCart(id) {
  return state.cart.some((item) => item.id === id);
}

function addToCart(p) {
  if (inCart(p.id)) return;
  state.cart.push({ id: p.id, title: p.title, price: p.price, emoji: p.emoji, category: p.category });
  saveCart();
  renderGrid();
  toast(`Added “${p.title}” to your basket`);
}

function renderGrid() {
  const { products } = state;
  $('#result-count').textContent = `${plural(products.length, 'item')}${state.booth ? ` at ${state.booth}` : ''}`;
  if (!products.length) {
    $('#grid').innerHTML = '<p class="empty"><strong>Nothing here yet</strong>Try another booth, category or search.</p>';
    return;
  }
  $('#grid').innerHTML = products.map((p) => {
    const added = inCart(p.id);
    return `
    <article class="card" tabindex="0" data-id="${escapeHtml(p.id)}" aria-label="${escapeHtml(p.title)}, ${money(p.price)}">
      <div class="thumb" style="${tint(p.category)}">
        <span class="emoji" aria-hidden="true">${escapeHtml(p.emoji || '🏷️')}</span>
        <span class="pill">${escapeHtml(p.condition)}</span>
        <button class="quick ${added ? 'added' : ''}" data-quick="${escapeHtml(p.id)}" tabindex="-1" ${added ? 'disabled' : ''}>
          ${added ? 'In your basket ✓' : 'Add to basket'}
        </button>
      </div>
      <div>
        <div class="card-row">
          <span class="card-title">${escapeHtml(p.title)}</span>
          <span class="card-price">${money(p.price)}</span>
        </div>
        <div class="card-meta">${escapeHtml(p.seller)}${hasSize(p.size) ? ` · Size ${escapeHtml(p.size)}` : ''}</div>
      </div>
    </article>`;
  }).join('');
}

function openProduct(id) {
  const p = state.products.find((x) => x.id === id);
  if (!p) return;
  const added = inCart(p.id);
  const sameBooth = state.booth === p.seller;
  $('#product-detail').innerHTML = `
    <div class="detail">
      <div class="detail-media" style="${tint(p.category)}" aria-hidden="true">${escapeHtml(p.emoji || '🏷️')}</div>
      <div class="detail-info">
        <h2>${escapeHtml(p.title)}</h2>
        <div class="detail-price">${money(p.price)}</div>
        <p class="muted">${escapeHtml(p.description || 'No description provided.')}</p>
        <dl class="specs">
          <div><dt>Condition</dt><dd>${escapeHtml(p.condition)}</dd></div>
          <div><dt>Size</dt><dd>${hasSize(p.size) ? escapeHtml(p.size) : 'One size'}</dd></div>
          <div><dt>Category</dt><dd>${escapeHtml(p.category)}</dd></div>
        </dl>
        <div class="seller">
          <span class="booth-avatar" style="${boothTint(boothIndex(p.seller))}" aria-hidden="true">🏪</span>
          <div><small>Sold at</small><strong>${escapeHtml(p.seller)}</strong></div>
          ${sameBooth ? '' : '<button class="btn btn-ghost" id="visit-booth">Visit booth</button>'}
        </div>
        <button class="btn btn-primary btn-block" id="add-to-cart" ${added ? 'disabled' : ''}>
          ${added ? 'In your basket ✓' : `Add to basket · ${money(p.price)}`}
        </button>
      </div>
    </div>`;
  $('#add-to-cart').addEventListener('click', () => {
    addToCart(p);
    $('#product-dialog').close();
  });
  $('#visit-booth')?.addEventListener('click', () => {
    $('#product-dialog').close();
    selectBooth(p.seller);
    $('#booths-title').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('#product-dialog').showModal();
}

/* ---------- Basket & checkout ---------- */

function renderCart() {
  $('#cart-count').textContent = state.cart.length;
  const total = state.cart.reduce((sum, i) => sum + i.price, 0);
  $('#cart-total').textContent = money(total);
  $('#cart-items').innerHTML = state.cart.length
    ? state.cart.map((i) => `
      <li>
        <span class="mini" style="${tint(i.category)}" aria-hidden="true">${escapeHtml(i.emoji || '🏷️')}</span>
        <div class="info"><strong>${escapeHtml(i.title)}</strong><span class="muted">${money(i.price)}</span></div>
        <button class="remove" data-remove="${escapeHtml(i.id)}" aria-label="Remove ${escapeHtml(i.title)}">Remove</button>
      </li>`).join('')
    : '<li class="cart-empty"><span aria-hidden="true">🧺</span>Your basket is empty.</li>';
  const button = $('#checkout-btn');
  button.disabled = !state.cart.length;
  button.textContent = state.payments === 'stripe' ? `Continue to payment · ${money(total)}` : 'Place order';
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
  const button = $('#checkout-btn');
  button.disabled = true;
  try {
    const order = await api('/api/orders', {
      method: 'POST',
      body: { items: state.cart.map((i) => i.id), customer },
    });
    if (order.checkoutUrl) {
      // Real payment: Stripe's page takes over and sends the shopper back here.
      button.textContent = 'Opening secure checkout…';
      window.location.href = order.checkoutUrl;
      return;
    }
    state.cart = [];
    saveCart();
    form.reset();
    setCartOpen(false);
    toast(`Order placed! ${money(order.total)} total. Thank you, ${customer.name}.`);
    loadBooths();
    loadProducts();
  } catch (ex) {
    err.textContent = ex.message;
    // Someone else bought an item first: drop it from the basket so the rest can go through.
    if (ex.data?.soldIds) {
      state.cart = state.cart.filter((i) => !ex.data.soldIds.includes(i.id));
      saveCart();
      loadBooths();
      loadProducts();
    }
  } finally {
    if (!button.textContent.startsWith('Opening')) renderCart();
  }
}

/** Back from Stripe: finish up a checkout or a payouts setup. */
async function handleReturn() {
  const params = new URLSearchParams(window.location.search);
  const orderId = params.get('order');
  const checkout = params.get('checkout');
  const payouts = params.get('payouts');
  if (!orderId && !payouts) return;
  history.replaceState(null, '', window.location.pathname);

  if (payouts === 'done') toast('Payouts are set up. Stripe will send your share of each sale.');
  if (payouts === 'retry') {
    $('#payout-error').textContent = 'That setup link expired. Please try again.';
    $('#payout-dialog').showModal();
  }
  if (!orderId) return;
  try {
    if (checkout === 'cancelled') {
      await api(`/api/orders/${encodeURIComponent(orderId)}/cancel`, { method: 'POST', body: {} });
      toast('Checkout cancelled. Your items are still in your basket.');
    } else if (checkout === 'success') {
      const order = await api(`/api/orders/${encodeURIComponent(orderId)}`);
      const paidIds = new Set(order.items.map((i) => i.id));
      state.cart = state.cart.filter((i) => !paidIds.has(i.id));
      saveCart();
      toast(`Payment received: ${money(order.total)}. Thank you!`);
    }
  } catch (err) {
    toast(err.message);
  }
  loadBooths();
  loadProducts();
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
    toast(`“${product.title}” is now listed at ${product.seller}`);
    if (product.boothKey) showBoothKey(product.seller, product.boothKey);
    loadBooths();
    loadProducts();
  } catch (ex) {
    err.textContent = ex.message;
  }
}

function showBoothKey(booth, key) {
  $('#key-value').textContent = key;
  $('#copy-key').textContent = 'Copy';
  $('#key-payouts').hidden = state.payments !== 'stripe';
  $('#key-payouts').onclick = () => startPayouts(booth, key, $('#key-payouts')).catch((err) => toast(err.message));
  $('#key-dialog').showModal();
}

async function startPayouts(booth, boothKey, button) {
  button.disabled = true;
  try {
    const { url } = await api('/api/booths/payouts', { method: 'POST', body: { booth, boothKey } });
    window.location.href = url;
  } catch (err) {
    button.disabled = false;
    throw err;
  }
}

async function payoutSubmit(e) {
  e.preventDefault();
  const { booth, boothKey } = Object.fromEntries(new FormData(e.target));
  $('#payout-error').textContent = '';
  try {
    await startPayouts(booth.trim(), boothKey.trim(), e.target.querySelector('button[type=submit]'));
  } catch (err) {
    $('#payout-error').textContent = err.message;
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
  renderSkeleton();
  let meta;
  try {
    meta = await connect();
  } catch (err) {
    $('#grid').innerHTML = `<p class="empty"><strong>We'll be right back</strong>${escapeHtml(err.message)}</p>`;
    return;
  }
  state.payments = meta.payments;
  $('#preview-bar').hidden = !meta.preview;
  const note = $('#pay-note');
  if (meta.payments === 'stripe') {
    note.textContent = '🔒 Secure payment by Stripe. Cards, Apple Pay and Google Pay.';
  } else {
    note.textContent = 'Demo mode: no payment is taken. Orders complete right away.';
    note.classList.add('demo');
  }
  renderChips(meta.categories);
  fillSelect($('#f-condition'), meta.conditions);
  fillSelect($('#sell-category'), meta.categories);
  fillSelect($('#sell-condition'), meta.conditions);

  $('#search').addEventListener('input', debounce(loadProducts, 250));
  ['#f-condition', '#f-price', '#f-sort'].forEach((s) => $(s).addEventListener('change', loadProducts));
  $('#category-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    state.category = chip.dataset.category;
    renderChips(meta.categories);
    loadProducts();
  });
  $('#f-reset').addEventListener('click', () => {
    $('#search').value = '';
    $('#f-condition').value = '';
    $('#f-price').value = '';
    $('#f-sort').value = 'newest';
    state.category = '';
    state.booth = '';
    renderChips(meta.categories);
    renderBooths();
    loadProducts();
  });

  $('#booth-row').addEventListener('click', (e) => {
    const booth = e.target.closest('.booth');
    if (booth) selectBooth(booth.dataset.booth);
  });
  $('#grid').addEventListener('click', (e) => {
    const quick = e.target.closest('[data-quick]');
    if (quick) {
      const p = state.products.find((x) => x.id === quick.dataset.quick);
      if (p) addToCart(p);
      return;
    }
    const card = e.target.closest('.card:not(.skeleton)');
    if (card) openProduct(card.dataset.id);
  });
  $('#grid').addEventListener('keydown', (e) => {
    const card = e.target.closest('.card');
    if (card && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openProduct(card.dataset.id); }
  });

  document.addEventListener('click', (e) => {
    const close = e.target.closest('[data-close-dialog]');
    if (close) close.closest('dialog').close();
    if (e.target.closest('[data-close-cart]')) setCartOpen(false);
    const remove = e.target.closest('[data-remove]');
    if (remove) {
      state.cart = state.cart.filter((i) => i.id !== remove.dataset.remove);
      saveCart();
      renderGrid();
    }
  });
  // Clicking the dimmed area outside a dialog closes it.
  document.querySelectorAll('dialog').forEach((d) => d.addEventListener('click', (e) => {
    if (e.target !== d) return;
    const r = d.getBoundingClientRect();
    const outside = e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    if (outside) d.close();
  }));
  $('#cart-btn').addEventListener('click', () => setCartOpen(true));
  $('#backdrop').addEventListener('click', () => setCartOpen(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setCartOpen(false); });

  $('#checkout-form').addEventListener('submit', checkout);
  $('#sell-btn').addEventListener('click', () => $('#sell-dialog').showModal());
  $('#sell-form').addEventListener('submit', sell);
  $('#payout-form').addEventListener('submit', payoutSubmit);
  $('#payout-link').addEventListener('click', () => {
    if (state.payments !== 'stripe') {
      toast('Payouts turn on once the market connects its Stripe account.');
      return;
    }
    $('#payout-dialog').showModal();
  });
  $('#copy-key').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('#key-value').textContent);
      $('#copy-key').textContent = 'Copied';
    } catch {
      $('#copy-key').textContent = 'Select & copy';
    }
  });

  renderCart();
  loadBooths();
  loadProducts();
  handleReturn();
}

init();
