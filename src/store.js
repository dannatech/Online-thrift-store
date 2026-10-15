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

/**
 * JSON-file backed store. Every thrift item is one-of-a-kind, so an item is
 * either available or sold; there is no stock quantity.
 */
class Store {
  constructor({ dbFile, seedFile }) {
    this.dbFile = dbFile;
    this.seedFile = seedFile;
    this.data = this.#load();
  }

  #load() {
    if (this.dbFile && fs.existsSync(this.dbFile)) {
      return JSON.parse(fs.readFileSync(this.dbFile, 'utf8'));
    }
    const seed = JSON.parse(fs.readFileSync(this.seedFile, 'utf8'));
    const now = new Date().toISOString();
    return {
      products: seed.map((p) => ({ ...p, sold: false, createdAt: now })),
      orders: [],
    };
  }

  #save() {
    if (!this.dbFile) return;
    fs.mkdirSync(path.dirname(this.dbFile), { recursive: true });
    const tmp = `${this.dbFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.dbFile);
  }

  listProducts({ q, category, size, condition, seller, maxPrice, sort, includeSold } = {}) {
    let items = this.data.products.slice();
    if (!includeSold) items = items.filter((p) => !p.sold);
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
    for (const p of this.data.products) {
      const booth = booths.get(p.seller) || { name: p.seller, available: 0, emoji: p.emoji };
      if (!p.sold) booth.available += 1;
      booths.set(p.seller, booth);
    }
    return [...booths.values()]
      .filter((b) => b.available > 0)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  getProduct(id) {
    return this.data.products.find((p) => p.id === id) || null;
  }

  addProduct(input) {
    const title = String(input.title || '').trim();
    const description = String(input.description || '').trim();
    const seller = String(input.seller || '').trim();
    const size = String(input.size || 'One Size').trim() || 'One Size';
    const price = Number(input.price);

    if (title.length < 3 || title.length > 80) throw new ValidationError('Title must be 3–80 characters.');
    if (description.length > 500) throw new ValidationError('Description must be at most 500 characters.');
    if (!seller || seller.length > 50) throw new ValidationError('Seller name is required (max 50 characters).');
    if (!CATEGORIES.includes(input.category)) throw new ValidationError(`Category must be one of: ${CATEGORIES.join(', ')}.`);
    if (!CONDITIONS.includes(input.condition)) throw new ValidationError(`Condition must be one of: ${CONDITIONS.join(', ')}.`);
    if (!Number.isFinite(price) || price <= 0 || price > 10000) throw new ValidationError('Price must be between 0 and 10,000.');
    if (size.length > 20) throw new ValidationError('Size must be at most 20 characters.');

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
    return product;
  }

  createOrder({ items, customer }) {
    if (!Array.isArray(items) || items.length === 0) throw new ValidationError('Cart is empty.');
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
    const sold = products.filter((p) => p.sold);
    if (sold.length) {
      const err = new ValidationError(`Sorry, already sold: ${sold.map((p) => p.title).join(', ')}`, 409);
      err.soldIds = sold.map((p) => p.id);
      throw err;
    }

    for (const p of products) p.sold = true;
    const total = Math.round(products.reduce((sum, p) => sum + p.price, 0) * 100) / 100;
    const order = {
      id: crypto.randomUUID(),
      items: products.map((p) => ({ id: p.id, title: p.title, price: p.price })),
      total,
      customer: { name, email, address },
      createdAt: new Date().toISOString(),
    };
    this.data.orders.push(order);
    this.#save();
    return order;
  }
}

module.exports = { Store, ValidationError, CATEGORIES, CONDITIONS };
