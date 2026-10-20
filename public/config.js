// Storefront settings.
//
// apiBase: where the market server (server.js) runs.
//   ''  → the same site that served this page. When nothing answers there
//         (e.g. on GitHub Pages) the store runs as an in-browser preview.
//   'https://your-market.onrender.com' → a server hosted elsewhere; this is
//         what turns on real Stripe payments for the GitHub Pages storefront.
window.MARKET_CONFIG = {
  apiBase: '',
};
