'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Store } = require('../src/store');
const { createServer } = require('../server');

let server;
let base;

before(async () => {
  // dbFile: null keeps the store in memory so tests never touch data/db.json.
  const store = new Store({ dbFile: null, seedFile: path.join(__dirname, '..', 'data', 'seed.json') });
  server = createServer(store);
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
});

after(() => server.close());

const post = (url, body) => fetch(base + url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const customer = { name: 'Ada', email: 'ada@example.com', address: '1 Main St' };

test('lists available products', async () => {
  const res = await fetch(`${base}/api/products`);
  assert.equal(res.status, 200);
  const items = await res.json();
  assert.ok(items.length >= 10);
  assert.ok(items.every((p) => !p.sold));
});

test('filters by search, category and max price, and sorts by price', async () => {
  const shoes = await (await fetch(`${base}/api/products?category=Shoes`)).json();
  assert.ok(shoes.length > 0 && shoes.every((p) => p.category === 'Shoes'));

  const cheap = await (await fetch(`${base}/api/products?maxPrice=15&sort=price-asc`)).json();
  assert.ok(cheap.every((p) => p.price <= 15));
  assert.deepEqual(cheap.map((p) => p.price), [...cheap.map((p) => p.price)].sort((a, b) => a - b));

  const jeans = await (await fetch(`${base}/api/products?q=levi`)).json();
  assert.equal(jeans.length, 1);
});

test('lists vendor booths and filters products by booth', async () => {
  const booths = await (await fetch(`${base}/api/booths`)).json();
  assert.ok(booths.length >= 4);
  const shoeCrate = booths.find((b) => b.name === 'The Shoe Crate');
  assert.equal(shoeCrate.available, 2);

  const items = await (await fetch(`${base}/api/products?seller=${encodeURIComponent('The Shoe Crate')}`)).json();
  assert.equal(items.length, 2);
  assert.ok(items.every((p) => p.seller === 'The Shoe Crate'));
});

test('returns 404 for an unknown product', async () => {
  const res = await fetch(`${base}/api/products/nope`);
  assert.equal(res.status, 404);
});

test('lists a new item for sale and validates input', async () => {
  const bad = await post('/api/products', { title: 'x', category: 'Clothing', condition: 'Good', price: 5, seller: 'Bo' });
  assert.equal(bad.status, 400);

  const res = await post('/api/products', {
    title: 'Denim Jacket', description: 'Oversized', category: 'Clothing',
    condition: 'Good', size: 'L', price: '25', seller: 'Bo',
  });
  assert.equal(res.status, 201);
  const product = await res.json();
  assert.equal(product.price, 25);

  const newest = await (await fetch(`${base}/api/products?sort=newest`)).json();
  assert.equal(newest[0].id, product.id);
});

test('a new booth gets an owner key that is needed to add more items', async () => {
  const item = { description: '', category: 'Books', condition: 'Good', price: 8 };
  const first = await (await post('/api/products', { ...item, title: 'Poetry Book', seller: 'Page Turners' })).json();
  assert.ok(first.boothKey);

  const noKey = await post('/api/products', { ...item, title: 'Atlas', seller: 'Page Turners' });
  assert.equal(noKey.status, 403);
  const withKey = await post('/api/products', { ...item, title: 'Atlas', seller: 'Page Turners', boothKey: first.boothKey });
  assert.equal(withKey.status, 201);
  assert.equal((await withKey.json()).boothKey, undefined);

  // Names that clash with built-in object properties are just ordinary booths.
  const proto = await post('/api/products', { ...item, title: 'Odd Book', seller: 'constructor' });
  assert.equal(proto.status, 201);

  // Market-run booths can't be claimed.
  const seedBooth = await post('/api/products', { ...item, title: 'Old Map', seller: 'Bookworm Barn' });
  assert.equal(seedBooth.status, 403);
});

test('demo mode has no payouts', async () => {
  const meta = await (await fetch(`${base}/api/meta`)).json();
  assert.equal(meta.payments, 'demo');
  assert.equal((await post('/api/booths/payouts', { booth: 'Bo', boothKey: 'x' })).status, 400);
});

test('checkout marks items sold and blocks a second purchase', async () => {
  const res = await post('/api/orders', { items: ['p1', 'p2'], customer });
  assert.equal(res.status, 201);
  const order = await res.json();
  assert.equal(order.total, 73);

  const listed = await (await fetch(`${base}/api/products`)).json();
  assert.ok(!listed.some((p) => p.id === 'p1' || p.id === 'p2'));

  const again = await post('/api/orders', { items: ['p1', 'p3'], customer });
  assert.equal(again.status, 409);
  assert.deepEqual((await again.json()).soldIds, ['p1']);

  // p3 must not have been sold by the rejected order.
  const p3 = await (await fetch(`${base}/api/products/p3`)).json();
  assert.equal(p3.sold, false);
});

test('checkout validates customer details and cart', async () => {
  assert.equal((await post('/api/orders', { items: [], customer })).status, 400);
  assert.equal((await post('/api/orders', { items: ['p4'], customer: { ...customer, email: 'bad' } })).status, 400);
  assert.equal((await post('/api/orders', { items: ['missing'], customer })).status, 404);
});

test('serves the storefront and blocks path traversal', async () => {
  const home = await fetch(`${base}/`);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /Second Chance/);
  const evil = await fetch(`${base}/..%2fserver.js`);
  assert.notEqual(evil.status, 200);
});
