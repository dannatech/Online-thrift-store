# Second Chance Thrift Market 🧺

An online thrift market styled like a farmers market: vendors run their own booths, and shoppers wander from table to table.
Built with Node.js and vanilla JavaScript, no dependencies.

## Features

- **Visit a booth**: each seller has a striped-awning booth. Click one to see only that vendor's table
- **Browse** one-of-a-kind secondhand items with search, category/condition/price filters and sorting
- **Item details** in a modal with size, condition, description and seller
- **Basket** that persists in the browser, with a checkout form (name, email, shipping address)
- **Unique stock**: each item can only be sold once — if someone buys it first, checkout tells you and removes it from your cart
- **Rent a booth**: anyone can list items under their booth name. A new name opens a new booth
- Responsive layout with light and dark mode

## Getting started

Requires Node.js 18+. No `npm install` needed.

```bash
npm start          # http://localhost:3000
npm test           # run the API tests
```

Set `PORT` to change the port and `DB_FILE` to change where data is stored
(defaults to `data/db.json`, created from `data/seed.json` on first change).
Delete `data/db.json` to reset the market.

## API

| Method | Path                  | Description |
|--------|-----------------------|-------------|
| GET    | `/api/meta`           | Categories and conditions |
| GET    | `/api/booths`         | Vendor booths with how many items each has out |
| GET    | `/api/products`       | Available items. Query: `q`, `category`, `size`, `condition`, `seller` (booth), `maxPrice`, `sort` (`newest`, `price-asc`, `price-desc`) |
| GET    | `/api/products/:id`   | One item |
| POST   | `/api/products`       | List an item: `{ title, description, category, condition, size, price, seller }` |
| POST   | `/api/orders`         | Check out: `{ items: [id, ...], customer: { name, email, address } }` |

## Project layout

```
server.js        HTTP server: JSON API + static files
src/store.js     Data layer (JSON file storage, validation, orders)
data/seed.json   Starting inventory
public/          Storefront (HTML, CSS, JS)
test/            API tests (node:test)
```

## Next steps

Ideas for growing this: real product photos (uploads), user accounts, payments (e.g. Stripe),
an admin dashboard for orders, and a real database.
