# Kajabi GTM Ecommerce Tracker

Full GA4 ecommerce tracking for Kajabi checkouts in Google Tag Manager.

Kajabi's native GA4 integration sends a purchase through gtag and pushes nothing to the dataLayer, so GTM users get no ecommerce data at all. This tracker reads Kajabi's own checkout responses and pushes the full GA4 ecommerce funnel to the dataLayer, with real prices, discounts and order IDs, plus Enhanced Conversions and Meta Advanced Matching data and an optional server-side backup.

Docs and payload examples: [iyrexmedia.com/gtm-form-listeners/kajabi-checkout](https://iyrexmedia.com/gtm-form-listeners/kajabi-checkout/)

## Why this exists

Published Kajabi tracking guides fire `purchase` on a thank-you page view with a hardcoded or URL-parameter value. That gives you no items, no coupon, no checkout steps, and a duplicate every time the thank-you page is refreshed. Kajabi's thank-you pages carry no order data, and Kajabi redirects within milliseconds of a successful payment, too fast for tags to send.

This tracker listens to the same API calls Kajabi's checkout makes, so the data comes from Kajabi itself, not from page text. Theme edits and price display overrides cannot break it.

## Files

| File | Use case |
|---|---|
| `kajabi-ecommerce-tracker.gtm.html` | GTM Custom HTML paste-ready version, with the `<script>` wrapper and config block. |
| `kajabi-ecommerce-tracker.js` | Raw JavaScript for self-hosting. Set `window.KJB_ECOM_CONFIG` before it loads to override the config. |
| `kajabi-ecommerce-gtm-container.json` | GTM container import: tracker tag, GA4 ecommerce tag, health tag, triggers and variables. |
| `server/` | Optional Cloudflare Worker for the server-side backup (Meta CAPI + GA4 Measurement Protocol). See `server/README.md`. |

## Events

| Event | When |
|---|---|
| `view_item_list` | A page links to one or more Kajabi offers (e.g. a pricing page) |
| `select_item` | A visitor clicks an offer link |
| `view_item` | A checkout loads (standalone or embedded) |
| `begin_checkout` | Standalone checkout loads, or first interaction with an embedded checkout |
| `apply_coupon` | A coupon is accepted (custom event, GA4 ecommerce format) |
| `add_payment_info` | The Pay / Submit button is pressed |
| `purchase` | Kajabi reports the order as `succeeded` |
| `kajabi_ecom_error` | Health event: Kajabi's checkout no longer looks the way the tracker expects |

## Payload example

```js
{
  event: "purchase",
  event_id: "5359ef9a-c001-11f1-bf0c-cf9d5af86868",   // use as Meta eventID
  ecommerce: {
    transaction_id: "5359ef9a-c001-11f1-bf0c-cf9d5af86868",
    currency: "USD",
    value: 87.3,
    coupon: "SAVE10",
    payment_type: "card",
    items: [{
      item_id: "AbC123xy",              // Kajabi offer token (from the checkout URL)
      item_name: "Premium Pass",
      item_brand: "Your Kajabi site title",
      item_category: "Kajabi Offer",
      item_variant: "one_time",
      price: 87.3,
      discount: 9.7,
      coupon: "SAVE10",
      quantity: 1,
      kajabi_offer_id: "2151270217",
      item_list_name: "Pricing",
      index: 1
    }]
  },
  user_data: { email: "jane@example.com", phone_number: "+15125550134", address: { ... } },  // userData: 'plain' | 'hashed'
  meta_user_data: { em: "jane@example.com", ph: "15125550134", fn: "jane", ... }
}
```

## Quick start in GTM

**Option A: import the container**

1. GTM > Admin > Import Container > choose `kajabi-ecommerce-gtm-container.json`, a new or existing workspace, and **Merge** (rename conflicting items).
2. Set the variable `Kajabi - GA4 Measurement ID` to your GA4 ID.
3. Preview, run a test checkout with a 100% coupon, then publish.

**Option B: manual**

1. Create a **Custom HTML** tag, paste `kajabi-ecommerce-tracker.gtm.html`, trigger **Initialization - All Pages**.
2. Create a **Custom Event** trigger, regex on: `^(view_item_list|select_item|view_item|begin_checkout|apply_coupon|add_payment_info|purchase)$`
3. Create a **GA4 Event** tag: event name `{{Event}}`, More Settings > Ecommerce > **Send Ecommerce data** on, source Data Layer.
4. Preview, test, publish.

**Disconnect Kajabi's native GA4 integration** (Settings > Third Party Integrations), otherwise purchases count twice.

## Configuration

Edit the config block at the top of the tag, or define `window.KJB_ECOM_CONFIG` before the raw `.js` loads.

| Option | Default | What it does |
|---|---|---|
| `debug` | `false` | Console logs. Testing only |
| `userData` | `'off'` | `'plain'` or `'hashed'` adds `user_data` (Google Enhanced Conversions) and `meta_user_data` (Meta Advanced Matching) to `purchase` |
| `healthEvents` | `true` | Push `kajabi_ecom_error` when Kajabi's API changes |
| `serverUrl` | `''` | Base URL of the optional server Worker. Empty = off |
| `ga4MeasurementId` | `''` | Lets the server hit join the buyer's GA4 session |
| `trackOfferLinks` | `true` | `view_item_list` and `select_item` on pages that link to offers |
| `maxListItems` | `12` | Max offers fetched for `view_item_list` |
| `brand` | `''` | `item_brand`. Empty = Kajabi site title |
| `category` | `'Kajabi Offer'` | `item_category` |
| `pendingTtlMin` | `120` | How long an unconfirmed order is kept for recovery |

## Enhanced Conversions and Meta

- **Google Ads:** User-Provided Data variable, type Code, pointing at a Data Layer Variable for `user_data`. Tick "Include user-provided data" on the conversion tag.
- **Meta Pixel:** advanced matching goes in `fbq('init', PIXEL_ID, {{DLV - meta_user_data}})`, and the purchase needs `{ eventID: {{DLV - event_id}} }` so Pixel and CAPI deduplicate.
- **GA4:** do not send `user_data` to GA4 event tags. GA4's terms prohibit PII in event parameters.

`plain` sends normalized values (the Google tag and Pixel hash them). `hashed` puts only SHA-256 values in the dataLayer. Customer data is held in `sessionStorage` for the checkout tab only and removed once used.

## Health events

`kajabi_ecom_error` carries `error_type`, `error_detail` and `kajabi_ecom_version`. Types: `offer_api_failed`, `offer_api_shape`, `submit_no_id`, `status_unknown`, `purchase_no_record`, `hash_unavailable`, `server_beacon_failed`, `script_exception`. Send it to GA4 and set a custom alert, so you hear about a Kajabi change before your reports go quiet.

## Server-side backup (optional)

Set `serverUrl` and the tracker `sendBeacon`s each purchase (hashed customer data, GA client and session IDs, `_fbp`, `_fbc`, `gclid`) to your own Cloudflare Worker, which sends Meta CAPI and, when the browser hit is missing, GA4 Measurement Protocol, deduplicated by `event_id` / `transaction_id`. Webhook mode also matches Kajabi purchase webhooks to the browser order. Setup: `server/README.md`.

## Debugging

```js
window.__kjbEcom.status()
```

Returns version, config, offers seen, pending orders, health errors and the last 10 events.

## Known limitations

- Uses Kajabi's internal checkout API (`/api/offers/{token}/checkout`, `/api/order_checkout/{id}/status`). It is undocumented and can change; the health event exists for that reason.
- Covers Kajabi offer checkouts (`/offers/{token}/checkout`) and embedded checkout blocks. Kajabi Cart (multi-offer orders), order bumps, payment plans, quantity and one-click upsells are handled defensively but not yet verified on a live store.
- `value` is the amount due now. Subscription renewals, payment-plan installments and refunds are not tracked in the browser (use the server Worker's webhook mode for renewals).
- `transaction_id` is Kajabi's checkout ID, not the order number shown in Kajabi's admin.
- `purchase` usually fires on the page after checkout (Kajabi redirects too fast to send from the checkout page). If the buyer closes the tab before any page loads, it fires on their next visit within `pendingTtlMin`, or via the server backup.
- Needs a Custom HTML tag. Containers with a tag allowlist that blocks Custom HTML cannot use it.
- Consent is not handled inside the script. Use GTM consent settings on the tags that send data.

## Version

Current version: 1.3.0. See [CHANGELOG.md](CHANGELOG.md).

## License

MIT. See [LICENSE](LICENSE).

## Author

Iyke Abel
LinkedIn: https://www.linkedin.com/in/iykeabel/
Email: abeliyke05@gmail.com
