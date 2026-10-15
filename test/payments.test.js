'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Store } = require('../src/store');
const { createServer } = require('../server');
const { signWebhook, verifyWebhook, encodeForm } = require('../src/stripe');

const WEBHOOK_SECRET = 'whsec_test';
const customer = { name: 'Ada', email: 'ada@example.com', address: '1 Main St' };

/** Records calls and returns canned Stripe objects. */
function fakeStripe() {
  const calls = [];
  let n = 0;
  const record = (name, result) => (...args) => {
    calls.push({ name, args });
    if (fakeStripe.fail?.[name]) return Promise.reject(Object.assign(new Error(`${name} failed`), { status: 502 }));
    return Promise.resolve(typeof result === 'function' ? result(...args) : result);
  };
  return {
    calls,
    createCheckoutSession: record('createCheckoutSession', () => ({ id: `cs_${++n}`, url: `https://checkout.stripe.test/cs_${n}` })),
    expireCheckoutSession: record('expireCheckoutSession', (id) => ({ id, status: 'expired' })),
    retrievePaymentIntent: record('retrievePaymentIntent', (id) => ({ id, latest_charge: 'ch_123' })),
    createAccount: record('createAccount', () => ({ id: 'acct_booth' })),
    createAccountLink: record('createAccountLink', () => ({ url: 'https://connect.stripe.test/onboard' })),
    createTransfer: record('createTransfer', () => ({ id: `tr_${++n}` })),
  };
}

let server;
let base;
let stripe;
let store;

before(async () => {
  store = new Store({ dbFile: null, seedFile: path.join(__dirname, '..', 'data', 'seed.json') });
  stripe = fakeStripe();
  server = createServer(store, { stripe, webhookSecret: WEBHOOK_SECRET, publicUrl: 'https://market.test', feePercent: 10 });
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());
beforeEach(() => { fakeStripe.fail = {}; });

const post = (url, body, headers = {}) => fetch(base + url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});
const sendEvent = (type, object) => {
  const raw = JSON.stringify({ id: 'evt_1', type, data: { object } });
  return post('/api/stripe/webhook', raw, { 'Stripe-Signature': signWebhook(raw, WEBHOOK_SECRET) });
};
const available = async () => (await (await fetch(`${base}/api/products`)).json()).map((p) => p.id);

test('reports Stripe mode and the market fee', async () => {
  const meta = await (await fetch(`${base}/api/meta`)).json();
  assert.equal(meta.payments, 'stripe');
  assert.equal(meta.feePercent, 10);
});

test('checkout creates a Stripe session and holds the items', async () => {
  const res = await post('/api/orders', { items: ['p1', 'p4'], customer });
  assert.equal(res.status, 201);
  const { orderId, checkoutUrl } = await res.json();
  assert.match(checkoutUrl, /^https:\/\/checkout\.stripe\.test\//);

  const session = stripe.calls.findLast((c) => c.name === 'createCheckoutSession').args[0];
  assert.deepEqual(session.line_items.map((l) => l.price_data.unit_amount), [2800, 3500]);
  assert.equal(session.metadata.order_id, orderId);
  assert.deepEqual(session.payment_method_types, ['card']);

  // Held items are off the tables and can't be bought by someone else.
  const ids = await available();
  assert.ok(!ids.includes('p1') && !ids.includes('p4'));
  const clash = await post('/api/orders', { items: ['p1'], customer });
  assert.equal(clash.status, 409);

  // Held items don't leak the order id that holds them.
  const p1 = await (await fetch(`${base}/api/products/p1`)).json();
  assert.equal(p1.heldBy, undefined);

  const order = await (await fetch(`${base}/api/orders/${orderId}`)).json();
  assert.equal(order.status, 'pending');
  assert.equal(order.customer, undefined);
});

test('a paid checkout sells the items and pays booths that set up payouts', async () => {
  // A seller opens a booth and connects Stripe.
  const listed = await (await post('/api/products', {
    title: 'Corduroy Jacket', category: 'Clothing', condition: 'Good', price: 50, seller: 'Sam’s Stand',
  })).json();
  assert.ok(listed.boothKey);
  const onboard = await post('/api/booths/payouts', { booth: 'Sam’s Stand', boothKey: listed.boothKey });
  assert.equal((await onboard.json()).url, 'https://connect.stripe.test/onboard');

  const { orderId } = await (await post('/api/orders', { items: [listed.id, 'p2'], customer })).json();
  const event = { id: 'cs_x', payment_status: 'paid', payment_intent: 'pi_1', metadata: { order_id: orderId } };
  assert.equal((await sendEvent('checkout.session.completed', event)).status, 200);

  const order = store.getOrder(orderId);
  assert.equal(order.status, 'paid');
  assert.equal(order.chargeId, 'ch_123');
  assert.ok(store.getProduct(listed.id).sold && store.getProduct('p2').sold);

  // $50 item minus 10% → $45 to Sam; the market-run booth's share stays with the market.
  const transfers = stripe.calls.filter((c) => c.name === 'createTransfer');
  assert.equal(transfers.length, 1);
  assert.deepEqual(transfers[0].args[0], {
    amount: 4500, currency: 'usd', destination: 'acct_booth', transfer_group: orderId, source_transaction: 'ch_123',
  });
  assert.deepEqual(order.payouts.map((p) => p.status).sort(), ['market', 'transferred']);

  // Stripe retries webhooks; a repeat must not pay out twice.
  await sendEvent('checkout.session.completed', event);
  assert.equal(stripe.calls.filter((c) => c.name === 'createTransfer').length, 1);
});

test('booths without payouts set up are recorded as owed', async () => {
  const listed = await (await post('/api/products', {
    title: 'Linen Shirt', category: 'Clothing', condition: 'Good', price: 20, seller: 'New Booth',
  })).json();
  const { orderId } = await (await post('/api/orders', { items: [listed.id], customer })).json();
  await sendEvent('checkout.session.completed', { payment_status: 'paid', payment_intent: 'pi_2', metadata: { order_id: orderId } });
  assert.deepEqual(store.getOrder(orderId).payouts, [{ booth: 'New Booth', amountCents: 1800, status: 'owed' }]);
});

test('an expired checkout puts the items back out', async () => {
  const { orderId } = await (await post('/api/orders', { items: ['p3'], customer })).json();
  assert.ok(!(await available()).includes('p3'));
  await sendEvent('checkout.session.expired', { metadata: { order_id: orderId } });
  assert.ok((await available()).includes('p3'));
  assert.equal(store.getOrder(orderId).status, 'expired');
});

test('cancelling releases the items, unless Stripe says the session cannot be expired', async () => {
  const { orderId } = await (await post('/api/orders', { items: ['p5'], customer })).json();
  fakeStripe.fail = { expireCheckoutSession: true };
  assert.equal((await post(`/api/orders/${orderId}/cancel`, {})).status, 409);
  assert.ok(!(await available()).includes('p5'));

  fakeStripe.fail = {};
  const res = await post(`/api/orders/${orderId}/cancel`, {});
  assert.equal((await res.json()).status, 'cancelled');
  assert.ok((await available()).includes('p5'));
});

test('a failed Stripe call releases the hold', async () => {
  fakeStripe.fail = { createCheckoutSession: true };
  const res = await post('/api/orders', { items: ['p6'], customer });
  assert.equal(res.status, 502);
  assert.ok((await available()).includes('p6'));
});

test('rejects webhooks with a bad signature', async () => {
  const raw = JSON.stringify({ type: 'checkout.session.completed', data: { object: {} } });
  const res = await post('/api/stripe/webhook', raw, { 'Stripe-Signature': signWebhook(raw, 'whsec_wrong') });
  assert.equal(res.status, 400);
  assert.equal((await post('/api/stripe/webhook', raw)).status, 400);
});

test('payouts can only be set up with the booth key', async () => {
  assert.equal((await post('/api/booths/payouts', { booth: 'Sam’s Stand', boothKey: 'nope' })).status, 403);
  assert.equal((await post('/api/booths/payouts', { booth: 'The Shoe Crate', boothKey: 'x' })).status, 403);
});

test('webhook signatures expire and form encoding nests like Stripe expects', () => {
  const raw = '{"type":"x"}';
  const old = signWebhook(raw, WEBHOOK_SECRET, Math.floor(Date.now() / 1000) - 3600);
  assert.throws(() => verifyWebhook(raw, old, WEBHOOK_SECRET), /Stale/);
  assert.equal(
    decodeURIComponent(encodeForm({ line_items: [{ price_data: { unit_amount: 100 } }], a: undefined }).toString()),
    'line_items[0][price_data][unit_amount]=100',
  );
});
