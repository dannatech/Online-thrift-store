# Second Chance Market

An online thrift market organized like a farmers market: independent sellers each run their own booth, and shoppers browse one booth or the whole market.
Built with Node.js and vanilla JavaScript, no dependencies.

## Features

- **Booths**: each seller has a booth. Pick one to see only that seller's items
- **Browse** one-of-a-kind secondhand items with search, category chips, condition/price filters and sorting
- **Item details** in a two-column view with size, condition, description and a link to the seller's booth
- **Quick add**: hover a card to drop it straight into your basket
- **Payments with Stripe**: shoppers pay on Stripe's secure checkout (cards, Apple Pay, Google Pay); each booth gets its share automatically through Stripe Connect, minus the market's commission
- **Basket** that persists in the browser, with a checkout form (name, email, shipping address)
- **Unique stock**: each item can only be sold once. Items are held while someone is paying, and only marked sold once Stripe confirms payment
- **Sell an item**: a new booth name opens a booth and gives the seller a **booth key**, needed to add more items and to set up payouts
- Clean black-and-white design that works from phone to desktop

## Getting started

Requires Node.js 18+. No `npm install` needed.

```bash
npm start          # http://localhost:3000
npm test           # run the API tests
```

Set `PORT` to change the port and `DB_FILE` to change where data is stored
(defaults to `data/db.json`, created from `data/seed.json` on first change).
Delete `data/db.json` to reset the market.

## Payments (Stripe)

Without Stripe keys the market runs in **demo mode**: orders complete instantly and no money moves.
To take real payments:

1. Create a [Stripe](https://dashboard.stripe.com/register) account and turn on **Connect**
   (Dashboard → Connect → Get started, choose *Marketplace*).
2. Copy `.env.example` and fill in your **test** secret key (`sk_test_…`).
3. Forward webhooks to your machine with the [Stripe CLI](https://docs.stripe.com/stripe-cli):
   ```bash
   stripe listen --forward-to localhost:3000/api/stripe/webhook
   ```
   It prints a `whsec_…` signing secret: that's `STRIPE_WEBHOOK_SECRET`.
4. Start the market with those variables set:
   ```bash
   STRIPE_SECRET_KEY=sk_test_... STRIPE_WEBHOOK_SECRET=whsec_... npm start
   ```
5. Buy something with test card `4242 4242 4242 4242`, any future date and any CVC.

**How the money flows:**
- The market charges the shopper for the whole basket.
- When Stripe confirms the payment (`checkout.session.completed` webhook), the items are marked sold and each booth that has set up payouts is sent its share. That's the price minus `MARKET_FEE_PERCENT`, sent as a Stripe transfer.
- Booths that haven't set up payouts yet are recorded as **owed** on the order.
- The seed booths are run by the market, so their sales stay with the market.

**Sellers** set up payouts with **Sellers: get paid** in the footer, or right after opening a booth.
They enter their booth name and key, then finish on Stripe's hosted onboarding page (identity and bank account).

**Going live:**
- Switch to your live keys.
- Add a webhook endpoint `https://your-domain/api/stripe/webhook` in the Stripe Dashboard for `checkout.session.completed` and `checkout.session.expired`.
- Set `PUBLIC_URL` to your domain. Stripe requires HTTPS for live payments.

## API

| Method | Path                  | Description |
|--------|-----------------------|-------------|
| GET    | `/api/meta`           | Categories and conditions |
| GET    | `/api/booths`         | Vendor booths with how many items each has out |
| GET    | `/api/products`       | Available items. Query: `q`, `category`, `size`, `condition`, `seller` (booth), `maxPrice`, `sort` (`newest`, `price-asc`, `price-desc`) |
| GET    | `/api/products/:id`   | One item |
| POST   | `/api/products`       | List an item: `{ title, description, category, condition, size, price, seller, boothKey? }`. A new booth gets a `boothKey` back |
| POST   | `/api/booths/payouts` | `{ booth, boothKey }` → Stripe onboarding link for the booth's payouts |
| POST   | `/api/orders`         | Check out: `{ items: [id, ...], customer: { name, email, address } }`. With Stripe returns `{ orderId, checkoutUrl }` |
| GET    | `/api/orders/:id`     | Order status (`pending`, `paid`, `expired`, `cancelled`) and items |
| POST   | `/api/orders/:id/cancel` | Abandon a pending checkout and release its items |
| POST   | `/api/stripe/webhook` | Stripe events (signature-checked) |

## Project layout

```
server.js        HTTP server: JSON API + static files
src/store.js     Data layer (JSON file storage, validation, booths, orders)
src/stripe.js    Stripe REST client and webhook signature check (no SDK needed)
data/seed.json   Starting inventory
public/          Storefront (HTML, CSS, JS)
test/            API and payment tests (node:test, with a fake Stripe)
```

## Next steps

Ideas for growing this: real product photos (uploads), seller accounts with login (replacing booth keys),
an admin dashboard for orders and owed payouts, and a real database.
