'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Store, ValidationError, CATEGORIES, CONDITIONS, toCents } = require('./src/store');
const { createStripeClient, verifyWebhook } = require('./src/stripe');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};
const MAX_BODY = 100 * 1024;
// Stripe Checkout sessions stay open 30 minutes (Stripe's minimum). Items are
// held longer as a safety net: the checkout.session.expired webhook releases
// them as soon as the session closes, so the cap only matters if webhooks fail.
const CHECKOUT_MINUTES = 30;
const HOLD_MS = 2 * 60 * 60 * 1000;

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': MIME['.json'] });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Request body too large.'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw Object.assign(new Error('Invalid JSON body.'), { status: 400 });
  }
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

/** Products without internal checkout bookkeeping (heldBy is an order id). */
const publicProduct = ({ heldBy, heldUntil, ...p }) => p;

/** What a shopper may see about an order: no customer details or payment ids. */
const publicOrder = (o) => ({
  id: o.id,
  status: o.status,
  total: o.total,
  items: o.items.map(({ id, title, price }) => ({ id, title, price })),
});

/**
 * @param {Store} store
 * @param {object} [payments] Omit for demo mode (orders complete without payment).
 * @param {object} payments.stripe Client from createStripeClient().
 * @param {string} payments.webhookSecret Signing secret for /api/stripe/webhook.
 * @param {string} payments.publicUrl Base URL Stripe redirects shoppers and sellers back to.
 * @param {number} payments.feePercent The market's commission on each sale.
 */
function createServer(store, payments = null) {
  const feePercent = payments?.feePercent ?? 0;

  async function startCheckout(body) {
    const order = store.createOrder(body, { holdMs: HOLD_MS });
    try {
      const session = await payments.stripe.createCheckoutSession({
        mode: 'payment',
        payment_method_types: ['card'], // includes Apple Pay / Google Pay; settles instantly
        customer_email: order.customer.email,
        client_reference_id: order.id,
        metadata: { order_id: order.id },
        payment_intent_data: { transfer_group: order.id, metadata: { order_id: order.id } },
        expires_at: Math.floor(Date.now() / 1000) + CHECKOUT_MINUTES * 60,
        line_items: order.items.map((item) => ({
          quantity: 1,
          price_data: {
            currency: 'usd',
            unit_amount: toCents(item.price),
            product_data: { name: item.title, description: `From ${item.seller}` },
          },
        })),
        success_url: `${payments.publicUrl}/?order=${order.id}&checkout=success`,
        cancel_url: `${payments.publicUrl}/?order=${order.id}&checkout=cancelled`,
      });
      store.attachCheckoutSession(order.id, session.id);
      return { orderId: order.id, checkoutUrl: session.url };
    } catch (err) {
      store.releaseOrder(order.id, 'failed');
      throw err;
    }
  }

  async function cancelCheckout(order) {
    if (order.status !== 'pending') return;
    if (order.checkoutSessionId) {
      // Expiring fails if the shopper already paid; then the items must stay held.
      try {
        await payments.stripe.expireCheckoutSession(order.checkoutSessionId);
      } catch {
        throw new ValidationError('This checkout may already be paid. Refresh in a moment.', 409);
      }
    }
    store.releaseOrder(order.id, 'cancelled');
  }

  async function fulfil(session) {
    const orderId = session.metadata?.order_id;
    if (!orderId || session.payment_status !== 'paid') return;
    const intent = await payments.stripe.retrievePaymentIntent(session.payment_intent);
    const chargeId = intent.latest_charge;
    if (!store.markOrderPaid(orderId, { paymentIntentId: intent.id, chargeId })) return;

    // Separate charges and transfers: the market took the payment, now send each booth its share.
    const order = store.getOrder(orderId);
    const payouts = [];
    for (const plan of store.payoutPlan(order, feePercent)) {
      const entry = { booth: plan.booth, amountCents: plan.amountCents };
      if (plan.marketRun) {
        entry.status = 'market';
      } else if (!plan.stripeAccountId) {
        entry.status = 'owed'; // booth hasn't set up payouts yet
      } else {
        try {
          const transfer = await payments.stripe.createTransfer({
            amount: plan.amountCents,
            currency: 'usd',
            destination: plan.stripeAccountId,
            transfer_group: orderId,
            source_transaction: chargeId,
          }, { idempotencyKey: `payout-${orderId}-${plan.stripeAccountId}` });
          Object.assign(entry, { status: 'transferred', transferId: transfer.id });
        } catch (err) {
          Object.assign(entry, { status: 'failed', error: err.message });
        }
      }
      payouts.push(entry);
    }
    store.recordPayouts(orderId, payouts);
  }

  async function handleWebhook(req, res) {
    const raw = await readBody(req);
    const event = verifyWebhook(raw, req.headers['stripe-signature'], payments.webhookSecret);
    const session = event.data?.object || {};
    if (event.type === 'checkout.session.completed') await fulfil(session);
    if (event.type === 'checkout.session.expired' && session.metadata?.order_id) {
      store.releaseOrder(session.metadata.order_id, 'expired');
    }
    sendJson(res, 200, { received: true });
  }

  async function setUpPayouts(body) {
    const name = String(body.booth || '').trim();
    const booth = store.verifyBoothKey(name, body.boothKey);
    let accountId = booth.stripeAccountId;
    if (!accountId) {
      const account = await payments.stripe.createAccount({
        type: 'express',
        country: 'US',
        capabilities: { transfers: { requested: true } },
        metadata: { booth: name },
      });
      accountId = account.id;
      store.setBoothStripeAccount(name, accountId);
    }
    const link = await payments.stripe.createAccountLink({
      account: accountId,
      type: 'account_onboarding',
      refresh_url: `${payments.publicUrl}/?payouts=retry`,
      return_url: `${payments.publicUrl}/?payouts=done`,
    });
    return { url: link.url };
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;
    try {
      if (pathname === '/api/meta' && req.method === 'GET') {
        return sendJson(res, 200, {
          categories: CATEGORIES,
          conditions: CONDITIONS,
          payments: payments ? 'stripe' : 'demo',
          feePercent,
        });
      }
      if (pathname === '/api/booths' && req.method === 'GET') {
        return sendJson(res, 200, store.listBooths());
      }
      if (pathname === '/api/booths/payouts' && req.method === 'POST') {
        if (!payments) throw new ValidationError('Payouts need Stripe. The market is in demo mode.');
        return sendJson(res, 200, await setUpPayouts(await readJson(req)));
      }
      if (pathname === '/api/products' && req.method === 'GET') {
        const q = Object.fromEntries(url.searchParams);
        return sendJson(res, 200, store.listProducts(q).map(publicProduct));
      }
      if (pathname === '/api/products' && req.method === 'POST') {
        const { product, boothKey } = store.addProduct(await readJson(req));
        return sendJson(res, 201, { ...product, ...(boothKey ? { boothKey } : {}) });
      }
      const productMatch = pathname.match(/^\/api\/products\/([\w-]+)$/);
      if (productMatch && req.method === 'GET') {
        const product = store.getProduct(productMatch[1]);
        return product ? sendJson(res, 200, publicProduct(product)) : sendJson(res, 404, { error: 'Item not found.' });
      }
      if (pathname === '/api/orders' && req.method === 'POST') {
        const body = await readJson(req);
        if (payments) return sendJson(res, 201, await startCheckout(body));
        return sendJson(res, 201, publicOrder(store.createOrder(body)));
      }
      const orderMatch = pathname.match(/^\/api\/orders\/([\w-]+)(\/cancel)?$/);
      if (orderMatch) {
        const order = store.getOrder(orderMatch[1]);
        if (!order) return sendJson(res, 404, { error: 'Order not found.' });
        if (!orderMatch[2] && req.method === 'GET') return sendJson(res, 200, publicOrder(order));
        if (orderMatch[2] && req.method === 'POST' && payments) {
          await cancelCheckout(order);
          return sendJson(res, 200, publicOrder(order));
        }
      }
      if (pathname === '/api/stripe/webhook' && req.method === 'POST' && payments) {
        return await handleWebhook(req, res);
      }
      if (pathname.startsWith('/api/')) {
        return sendJson(res, 404, { error: 'Not found.' });
      }
      if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, pathname);
      res.writeHead(405).end();
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error(err);
      sendJson(res, status, {
        error: status === 500 ? 'Something went wrong.' : err.message,
        ...(err.soldIds ? { soldIds: err.soldIds } : {}),
      });
    }
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const store = new Store({
    dbFile: process.env.DB_FILE || path.join(__dirname, 'data', 'db.json'),
    seedFile: path.join(__dirname, 'data', 'seed.json'),
  });

  let payments = null;
  if (process.env.STRIPE_SECRET_KEY) {
    if (!process.env.STRIPE_WEBHOOK_SECRET) {
      console.error('STRIPE_WEBHOOK_SECRET is required when STRIPE_SECRET_KEY is set.');
      process.exit(1);
    }
    payments = {
      stripe: createStripeClient({ secretKey: process.env.STRIPE_SECRET_KEY }),
      webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
      publicUrl: (process.env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, ''),
      feePercent: Number(process.env.MARKET_FEE_PERCENT ?? 10),
    };
  }

  createServer(store, payments).listen(port, () => {
    console.log(`Second Chance Market running at http://localhost:${port}`);
    console.log(payments
      ? `Payments: Stripe (market fee ${payments.feePercent}%)`
      : 'Payments: demo mode (set STRIPE_SECRET_KEY to take real payments)');
  });
}

module.exports = { createServer, HOLD_MS };
