'use strict';

/*
 * In-browser stand-in for the market server, used when the storefront is
 * hosted on its own (e.g. GitHub Pages) with no API to talk to. It answers the
 * same /api/... requests from localStorage, so browsing, basket, checkout and
 * selling all work, but nothing is shared between visitors and no payment is taken.
 */
window.createDemoApi = async function createDemoApi() {
  const STORAGE_KEY = 'thrift-demo-v1';
  const CATEGORIES = ['Clothing', 'Shoes', 'Accessories', 'Books', 'Home', 'Electronics', 'Other'];
  const CONDITIONS = ['Like New', 'Good', 'Fair'];

  let db;
  try { db = JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch { db = null; }
  if (!db) {
    const seed = await (await fetch('seed.json')).json();
    const now = new Date().toISOString();
    db = { products: seed.map((p) => ({ ...p, sold: false, createdAt: now })), orders: [], booths: {} };
  }
  const save = () => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(db)); } catch { /* storage unavailable */ }
  };
  const fail = (message, status = 400, data = {}) => {
    throw Object.assign(new Error(message), { status, data: { error: message, ...data } });
  };
  const randomId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const cents = (n) => Math.round(n * 100);

  function listProducts(q) {
    let items = db.products.filter((p) => !p.sold);
    if (q.q) {
      const needle = q.q.toLowerCase();
      items = items.filter((p) => `${p.title} ${p.description} ${p.category}`.toLowerCase().includes(needle));
    }
    if (q.category) items = items.filter((p) => p.category === q.category);
    if (q.condition) items = items.filter((p) => p.condition === q.condition);
    if (q.seller) items = items.filter((p) => p.seller === q.seller);
    if (q.maxPrice) items = items.filter((p) => p.price <= Number(q.maxPrice));
    if (q.sort === 'price-asc') items.sort((a, b) => a.price - b.price);
    else if (q.sort === 'price-desc') items.sort((a, b) => b.price - a.price);
    else items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return items;
  }

  function listBooths() {
    const booths = new Map();
    for (const p of db.products) {
      const booth = booths.get(p.seller) || { name: p.seller, available: 0, emoji: p.emoji };
      if (!p.sold) booth.available += 1;
      booths.set(p.seller, booth);
    }
    return [...booths.values()].filter((b) => b.available > 0).sort((a, b) => a.name.localeCompare(b.name));
  }

  function addProduct(input) {
    const title = String(input.title || '').trim();
    const seller = String(input.seller || '').trim();
    const price = Number(input.price);
    if (title.length < 3 || title.length > 80) fail('Title must be 3–80 characters.');
    if (!seller || seller.length > 50) fail('Booth name is required (max 50 characters).');
    if (!CATEGORIES.includes(input.category)) fail('Please pick a category.');
    if (!CONDITIONS.includes(input.condition)) fail('Please pick a condition.');
    if (!Number.isFinite(price) || price <= 0 || price > 10000) fail('Price must be between 0 and 10,000.');

    let boothKey;
    const known = Object.hasOwn(db.booths, seller);
    if (!known && db.products.some((p) => p.seller === seller)) fail('That booth is run by the market.', 403);
    if (known && db.booths[seller].key !== String(input.boothKey || '').trim()) fail('Wrong booth key.', 403);
    if (!known) {
      boothKey = randomId().replace(/-/g, '').slice(0, 16);
      db.booths[seller] = { key: boothKey };
    }

    const product = {
      id: randomId(),
      title,
      description: String(input.description || '').trim().slice(0, 500),
      category: input.category,
      size: String(input.size || '').trim().slice(0, 20) || 'One Size',
      condition: input.condition,
      price: cents(price) / 100,
      emoji: '🏷️',
      seller,
      sold: false,
      createdAt: new Date().toISOString(),
    };
    db.products.push(product);
    save();
    return { ...product, ...(boothKey ? { boothKey } : {}) };
  }

  function createOrder({ items, customer }) {
    if (!Array.isArray(items) || !items.length) fail('Your basket is empty.');
    if (!String(customer?.name || '').trim()) fail('Name is required.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(customer?.email || '').trim())) fail('A valid email is required.');
    if (!String(customer?.address || '').trim()) fail('Shipping address is required.');
    const products = [...new Set(items)].map((id) => db.products.find((p) => p.id === id));
    if (products.some((p) => !p)) fail('Some items no longer exist.', 404);
    const gone = products.filter((p) => p.sold);
    if (gone.length) {
      fail(`Sorry, no longer available: ${gone.map((p) => p.title).join(', ')}`, 409, { soldIds: gone.map((p) => p.id) });
    }
    for (const p of products) p.sold = true;
    const order = {
      id: randomId(),
      status: 'paid',
      total: cents(products.reduce((sum, p) => sum + p.price, 0)) / 100,
      items: products.map(({ id, title, price }) => ({ id, title, price })),
    };
    db.orders.push(order);
    save();
    return order;
  }

  return async function demoApi(path, { method = 'GET', body } = {}) {
    const url = new URL(path, 'https://demo.invalid');
    const route = `${method} ${url.pathname}`;
    const json = body ? JSON.parse(body) : {};
    if (route === 'GET /api/meta') {
      return { categories: CATEGORIES, conditions: CONDITIONS, payments: 'demo', feePercent: 0, preview: true };
    }
    if (route === 'GET /api/booths') return listBooths();
    if (route === 'GET /api/products') return listProducts(Object.fromEntries(url.searchParams));
    if (route === 'POST /api/products') return addProduct(json);
    if (route === 'POST /api/orders') return createOrder(json);
    const order = url.pathname.match(/^\/api\/orders\/([\w-]+)$/);
    if (order && method === 'GET') {
      return db.orders.find((o) => o.id === order[1]) || fail('Order not found.', 404);
    }
    if (route === 'POST /api/booths/payouts') fail('Payouts need the market server with Stripe.');
    return fail('Not found.', 404);
  };
};
