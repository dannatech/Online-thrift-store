'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const CATEGORIES = ['Clothing', 'Shoes', 'Accessories', 'Books', 'Home', 'Electronics', 'Other'];
const CONDITIONS = ['Like New', 'Good', 'Fair'];

class ValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const hashKey = (key) => crypto.createHash('sha256').update(String(key)).digest();
const toCents = (dollars) => Math.round(dollars * 100);

/**
 * JSON-file backed store. Every thrift item is one-of-a-kind, so an item is
 * available, held (someone is paying for it right now) or sold; there is no
 * stock quantity.
 */
class Store {
  constructor({ dbFile, seedFile }) {
    this.dbFile = dbFile;
    this.seedFile = seedFile;
    this.data = this.#load();
  }

  #load() {
    if (this.dbFile && fs.existsSync(this.dbFile)) {
      const data = JSON.parse(fs.readFileSync(this.dbFile, 'utf8'));
      data.booths ||= {};
      return data;
    }
    const seed = JSON.parse(fs.readFileSync(this.seedFile, 'utf8'));
    const now = new Date().toISOString();
    return {
      products: seed.map((p) => ({ ...p, sold: false, createdAt: now })),
      orders: [],
      // Booths opened through "Sell an item": { [name]: { keyHash, stripeAccountId } }.
      // Seed booths have no entry; they belong to the market itself.
      booths: {},
    };
  }

  #save() {
    if (!this.dbFile) return;
    fs.mkdirSync(path.dirname(this.dbFile), { recursive: true });
    const tmp = `${this.dbFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.dbFile);
  }

  /** Available means not sold and not held by a checkout that is still open. */
  #isAvailable(p, now = Date.now()) {
    return !p.sold && !(p.heldUntil && Date.parse(p.heldUntil) > now);
  }

  listProducts({ q, category, size, condition, seller, maxPrice, sort, includeSold } = {}) {
    let items = this.data.products.slice();
    if (!includeSold) items = items.filter((p) => this.#isAvailable(p));
    if (q) {
      const needle = q.toLowerCase();
      items = items.filter((p) =>
        `${p.title} ${p.description} ${p.category}`.toLowerCase().includes(needle));
    }
    if (category) items = items.filter((p) => p.category === category);
    if (size) items = items.filter((p) => p.size === size);
    if (condition) items = items.filter((p) => p.condition === condition);
    if (seller) items = items.filter((p) => p.seller === seller);
    if (maxPrice !== undefined && maxPrice !== '') {
      const max = Number(maxPrice);
      if (!Number.isNaN(max)) items = items.filter((p) => p.price <= max);
    }
    switch (sort) {
      case 'price-asc': items.sort((a, b) => a.price - b.price); break;
      case 'price-desc': items.sort((a, b) => b.price - a.price); break;
      case 'newest':
      default: items.sort((a, b) => b.createdAt.localeCompare(a.createdAt)); break;
    }
    return items;
  }

  /** Vendor booths (one per seller) with how many items each still has out. */
  listBooths() {
    const booths = new Map();
    const now = Date.now();
    for (const p of this.data.products) {
      const booth = booths.get(p.seller) || { name: p.seller, available: 0, emoji: p.emoji };
      if (this.#isAvailable(p, now)) booth.available += 1;
      booths.set(p.seller, booth);
    }
    return [...booths.values()]
      .filter((b) => b.available > 0)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  getProduct(id) {
    return this.data.products.find((p) => p.id === id) || null;
  }

  /* ---------- Booths ---------- */

  getBooth(name) {
    return Object.hasOwn(this.data.booths, name) ? this.data.booths[name] : null;
  }

  /** Check a booth owner's key; throws 403 if the booth isn't theirs. */
  verifyBoothKey(name, key) {
    const booth = this.getBooth(name);
    if (!booth) {
      const exists = this.data.products.some((p) => p.seller === name);
      throw new ValidationError(exists ? 'That booth is run by the market.' : 'No booth with that name.', exists ? 403 : 404);
    }
    const ok = key && crypto.timingSafeEqual(hashKey(key), Buffer.from(booth.keyHash, 'hex'));
    if (!ok) throw new ValidationError('Wrong booth key.', 403);
    return booth;
  }

  setBoothStripeAccount(name, accountId) {
    this.data.booths[name].stripeAccountId = accountId;
    this.#save();
  }

  /**
   * List an item. A new booth name opens a booth and returns its owner key
   * (shown once); adding to an existing booth requires that key.
   */
  addProduct(input) {
    const title = String(input.title || '').trim();
    const description = String(input.description || '').trim();
    const seller = String(input.seller || '').trim();
    const size = String(input.size || 'One Size').trim() || 'One Size';
    const price = Number(input.price);

    if (title.length < 3 || title.length > 80) throw new ValidationError('Title must be 3–80 characters.');
    if (description.length > 500) throw new ValidationError('Description must be at most 500 characters.');
    if (!seller || seller.length > 50) throw new ValidationError('Booth name is required (max 50 characters).');
    if (seller === '__proto__') throw new ValidationError('Please choose another booth name.');
    if (!CATEGORIES.includes(input.category)) throw new ValidationError(`Category must be one of: ${CATEGORIES.join(', ')}.`);
    if (!CONDITIONS.includes(input.condition)) throw new ValidationError(`Condition must be one of: ${CONDITIONS.join(', ')}.`);
    if (!Number.isFinite(price) || price <= 0 || price > 10000) throw new ValidationError('Price must be between 0 and 10,000.');
    if (size.length > 20) throw new ValidationError('Size must be at most 20 characters.');

    let boothKey;
    const isNewBooth = !this.getBooth(seller) && !this.data.products.some((p) => p.seller === seller);
    if (isNewBooth) {
      boothKey = crypto.randomBytes(12).toString('base64url');
      this.data.booths[seller] = { keyHash: hashKey(boothKey).toString('hex'), createdAt: new Date().toISOString() };
    } else {
      this.verifyBoothKey(seller, input.boothKey);
    }

    const product = {
      id: crypto.randomUUID(),
      title,
      description,
      category: input.category,
      size,
      condition: input.condition,
      price: Math.round(price * 100) / 100,
      emoji: '🏷️',
      seller,
      sold: false,
      createdAt: new Date().toISOString(),
    };
    this.data.products.push(product);
    this.#save();
    return { product, boothKey };
  }

  /* ---------- Orders ---------- */

  /**
   * Create an order. With `holdMs` (real payments) the items are held for
   * that long and the order stays pending until the payment is confirmed;
   * without it (demo mode) the items are sold immediately.
   */
  createOrder({ items, customer }, { holdMs } = {}) {
    if (!Array.isArray(items) || items.length === 0) throw new ValidationError('Your basket is empty.');
    const name = String(customer?.name || '').trim();
    const email = String(customer?.email || '').trim();
    const address = String(customer?.address || '').trim();
    if (!name) throw new ValidationError('Name is required.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ValidationError('A valid email is required.');
    if (!address) throw new ValidationError('Shipping address is required.');

    const ids = [...new Set(items.map(String))];
    const products = ids.map((id) => this.getProduct(id));
    const missing = ids.filter((id, i) => !products[i]);
    if (missing.length) throw new ValidationError(`Unknown item(s): ${missing.join(', ')}`, 404);
    const gone = products.filter((p) => !this.#isAvailable(p));
    if (gone.length) {
      const err = new ValidationError(`Sorry, no longer available: ${gone.map((p) => p.title).join(', ')}`, 409);
      err.soldIds = gone.map((p) => p.id);
      throw err;
    }

    const order = {
      id: crypto.randomUUID(),
      status: holdMs ? 'pending' : 'paid',
      payment: holdMs ? 'stripe' : 'demo',
      items: products.map((p) => ({ id: p.id, title: p.title, price: p.price, seller: p.seller })),
      total: toCents(products.reduce((sum, p) => sum + p.price, 0)) / 100,
      customer: { name, email, address },
      createdAt: new Date().toISOString(),
    };
    if (holdMs) {
      const heldUntil = new Date(Date.now() + holdMs).toISOString();
      for (const p of products) Object.assign(p, { heldUntil, heldBy: order.id });
    } else {
      for (const p of products) p.sold = true;
    }
    this.data.orders.push(order);
    this.#save();
    return order;
  }

  getOrder(id) {
    return this.data.orders.find((o) => o.id === id) || null;
  }

  attachCheckoutSession(orderId, sessionId) {
    this.getOrder(orderId).checkoutSessionId = sessionId;
    this.#save();
  }

  /** Payment confirmed: sell the held items. Returns false if already handled. */
  markOrderPaid(orderId, { paymentIntentId, chargeId } = {}) {
    const order = this.getOrder(orderId);
    if (!order || order.status === 'paid') return false;
    Object.assign(order, { status: 'paid', paymentIntentId, chargeId, paidAt: new Date().toISOString() });
    for (const item of order.items) {
      const p = this.getProduct(item.id);
      Object.assign(p, { sold: true, heldUntil: undefined, heldBy: undefined });
    }
    this.#save();
    return true;
  }

  /** Checkout abandoned or expired: put the held items back out. */
  releaseOrder(orderId, status = 'expired') {
    const order = this.getOrder(orderId);
    if (!order || order.status !== 'pending') return false;
    order.status = status;
    for (const item of order.items) {
      const p = this.getProduct(item.id);
      if (p.heldBy === orderId) Object.assign(p, { heldUntil: undefined, heldBy: undefined });
    }
    this.#save();
    return true;
  }

  /**
   * What each booth is owed for an order after the market's commission.
   * `marketRun` booths (the seed booths) have no owner, so their share stays with the market.
   */
  payoutPlan(order, feePercent) {
    const byBooth = new Map();
    for (const item of order.items) {
      const cents = toCents(item.price);
      const share = cents - Math.round((cents * feePercent) / 100);
      byBooth.set(item.seller, (byBooth.get(item.seller) || 0) + share);
    }
    return [...byBooth].map(([booth, amountCents]) => ({
      booth,
      amountCents,
      marketRun: !this.getBooth(booth),
      stripeAccountId: this.getBooth(booth)?.stripeAccountId || null,
    }));
  }

  recordPayouts(orderId, payouts) {
    this.getOrder(orderId).payouts = payouts;
    this.#save();
  }
}

module.exports = { Store, ValidationError, CATEGORIES, CONDITIONS, toCents };
