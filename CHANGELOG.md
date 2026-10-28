# Changelog

## 1.3.0 (2026-10-28)

First public release.

- Full GA4 ecommerce funnel from Kajabi's checkout API: `view_item_list`, `select_item`, `view_item`, `begin_checkout`, `apply_coupon`, `add_payment_info`, `purchase`.
- `purchase` uses Kajabi's `order_checkout_id` as `transaction_id`, survives Kajabi's instant redirect, and is deduplicated across reloads.
- Coupons and discounts from Kajabi's coupon endpoint, including codes auto-applied by URL.
- `userData` option: Google Enhanced Conversions (`user_data`) and Meta Advanced Matching (`meta_user_data`), plain or SHA-256 hashed.
- `kajabi_ecom_error` health event.
- Optional server-side backup (`serverUrl`) with the Cloudflare Worker in `server/`.
- `window.KJB_ECOM_CONFIG` override and `window.__kjbEcom.status()` debug API.
- GTM container import file.
- Tested end to end on a live Kajabi site: coupon checkouts, a real card purchase and a logged-out guest checkout.
