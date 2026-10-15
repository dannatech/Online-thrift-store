'use strict';

const crypto = require('node:crypto');

const API = 'https://api.stripe.com/v1';

/** Flatten { a: { b: [1] } } into Stripe's form encoding: a[b][0]=1. */
function encodeForm(obj, prefix, out = new URLSearchParams()) {
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (typeof value === 'object') encodeForm(value, name, out);
    else out.append(name, String(value));
  }
  return out;
}

/**
 * Minimal Stripe REST client covering what the market uses: Checkout for
 * buyers, Connect Express accounts and transfers for booth payouts.
 */
function createStripeClient({ secretKey, fetchImpl = fetch }) {
  async function request(method, path, params, { idempotencyKey } = {}) {
    const headers = { Authorization: `Bearer ${secretKey}` };
    let body;
    if (params) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = encodeForm(params).toString();
    }
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    const res = await fetchImpl(`${API}${path}`, { method, headers, body });
    const data = await res.json();
    if (!res.ok) {
      throw Object.assign(new Error(data.error?.message || `Stripe request failed (${res.status})`), {
        status: 502,
        stripe: data.error,
      });
    }
    return data;
  }

  return {
    createCheckoutSession: (params) => request('POST', '/checkout/sessions', params),
    expireCheckoutSession: (id) => request('POST', `/checkout/sessions/${encodeURIComponent(id)}/expire`, {}),
    retrievePaymentIntent: (id) => request('GET', `/payment_intents/${encodeURIComponent(id)}`),
    createAccount: (params) => request('POST', '/accounts', params),
    createAccountLink: (params) => request('POST', '/account_links', params),
    createTransfer: (params, opts) => request('POST', '/transfers', params, opts),
  };
}

/**
 * Verify a Stripe-Signature header (t=timestamp,v1=hmac) against the raw body
 * and return the parsed event. Throws if the signature is missing, wrong or stale.
 */
function verifyWebhook(rawBody, header, secret, { toleranceSec = 300, now = Date.now() } = {}) {
  let timestamp;
  const signatures = [];
  for (const part of String(header || '').split(',')) {
    const [key, value] = part.split('=', 2);
    if (key === 't') timestamp = value;
    if (key === 'v1' && value) signatures.push(value);
  }
  if (!timestamp || !signatures.length) throw Object.assign(new Error('Missing Stripe signature.'), { status: 400 });

  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  const match = signatures.some((sig) => sig.length === expected.length
    && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)));
  if (!match) throw Object.assign(new Error('Invalid Stripe signature.'), { status: 400 });
  if (Math.abs(now / 1000 - Number(timestamp)) > toleranceSec) {
    throw Object.assign(new Error('Stale Stripe webhook.'), { status: 400 });
  }
  return JSON.parse(rawBody);
}

/** Build a valid Stripe-Signature header; used by tests and local tooling. */
function signWebhook(rawBody, secret, timestamp = Math.floor(Date.now() / 1000)) {
  const sig = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  return `t=${timestamp},v1=${sig}`;
}

module.exports = { createStripeClient, verifyWebhook, signWebhook, encodeForm };
