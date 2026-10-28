# Server-side backup (Cloudflare Worker)

Server-side backup for the Kajabi GTM Ecommerce Tracker (v1.3.0+). Runs free on Cloudflare Workers + D1.

## What it does

| Destination | Sent when | Dedup with browser |
|---|---|---|
| Meta Conversions API (Purchase) | Every purchase | Same `event_id` as the Pixel. Pixel must send `eventID: {{DLV - event_id}}` |
| GA4 Measurement Protocol (purchase) | `GA4_SEND=fallback` (default): only when the browser never reported the order. `always`: every order, relying on GA4's transaction_id dedup | Same `transaction_id` + `client_id` |
| Google Ads | Not sent server-side (needs the Ads API). Keep the browser tag with Enhanced Conversions | |

## Modes

- **`MODE=beacon`** (default, any Kajabi plan). The browser script `sendBeacon`s each purchase to `/browser`. Survives Kajabi's instant redirect and most ad blockers when the Worker is on your own subdomain.
- **`MODE=webhook`** (Kajabi Growth/Pro, or Zapier). Kajabi's webhook triggers the send; beacons only add click ids and the browser `event_id`. Matching is by hashed email + offer id within 6 hours. Also catches orders where the browser never reported (closed tab, blocked script). Unmatched subscription/payment-plan payments are treated as renewals and skipped unless `SEND_RENEWALS=true`.

## Setup (about 15 minutes)

```bash
cd server
npm i -D wrangler
npx wrangler login
npx wrangler d1 create kajabi-capi            # copy database_id into wrangler.toml
npx wrangler d1 execute kajabi-capi --remote --file=schema.sql
npx wrangler secret put WEBHOOK_SECRET        # long random string, also protects /debug
npx wrangler secret put META_ACCESS_TOKEN     # Events Manager > Settings > Conversions API > Generate token
npx wrangler secret put GA4_API_SECRET        # GA4 Admin > Data streams > Measurement Protocol API secrets
# set META_PIXEL_ID, GA4_MEASUREMENT_ID, ALLOWED_ORIGINS in wrangler.toml [vars]
npx wrangler deploy
```

1. Add a custom domain (Workers > your worker > Settings > Domains), e.g. `track.yourdomain.com`. A first-party subdomain is blocked far less than `*.workers.dev`.
2. In the GTM tag CONFIG set `serverUrl: 'https://track.yourdomain.com'` and `ga4MeasurementId: 'G-XXXXXXX'`.
3. In your Meta Pixel purchase tag, send `{ eventID: {{DLV - event_id}} }`.
4. Webhook mode only: Kajabi Settings > Webhooks (or Zapier) > POST to `https://track.yourdomain.com/kajabi?key=YOUR_WEBHOOK_SECRET`, events Purchase and/or Payment Succeeded. Set `MODE = "webhook"`.

## Testing

1. Set `DEBUG = "true"` and the `META_TEST_EVENT_CODE` secret (Events Manager > Test events). Optionally set `GA4_DEBUG = "true"` to validate GA4 payloads without recording them.
2. Place a test order and open `https://track.yourdomain.com/debug?key=YOUR_WEBHOOK_SECRET` for the last 30 payloads and send results.
3. **Webhook mode:** check the first real webhook in `/debug`. The parser handles Kajabi's documented formats and Zapier flat fields, but Kajabi doesn't publish a full sample, so confirm `email`, `offer.id` and `amount_paid` are picked up.
4. Turn `DEBUG`, `META_TEST_EVENT_CODE` and `GA4_DEBUG` off when done. Failures are always logged.

Kajabi preview/test checkouts are ignored unless `ALLOW_TEST = "true"`.

## Privacy

Only SHA-256 hashed customer data reaches the Worker from the browser. Webhook PII is hashed in the Worker before sending and never stored: `/debug` shows payload shape with names, emails, phones, addresses and IPs redacted. Matching rows (hashed email, offer, click ids, IP) are deleted after 7 days, debug rows after 7 days. Your consent banner should cover server-side sharing with Meta and Google.
