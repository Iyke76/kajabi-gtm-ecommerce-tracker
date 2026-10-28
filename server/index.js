/**
 * kajabi-capi-worker v1.3.0 (part of kajabi-gtm-ecommerce-tracker, MIT)
 * Server-side backup for the Kajabi -> GA4 dataLayer bridge (v1.3+).
 *
 * Receives:
 *   POST /browser            sendBeacon from the browser script (event_id, hashed user data, click ids)
 *   POST /kajabi?key=SECRET  Kajabi outbound webhook (Purchase / Payment Succeeded), or a Zapier POST
 * Sends:
 *   Meta Conversions API  Purchase, same event_id as the Pixel -> Meta deduplicates
 *   GA4 Measurement Protocol purchase, same transaction_id + client_id as the browser hit
 *
 * MODE (env):
 *   beacon  (default)  every browser beacon is forwarded server-side. Works on any Kajabi plan.
 *   webhook            Kajabi's webhook is the trigger; beacons only enrich it (click ids, event_id).
 *                      Catches purchases where the browser never reported (closed tab, blocked script).
 *                      Needs Kajabi Growth/Pro (webhooks) or Zapier.
 */

const META_DEFAULT_VERSION = 'v22.0';
const KNOWN_OK_STATUSES = new Set([200, 201, 202, 204]);

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    try {
      if (req.method === 'OPTIONS') return cors(env, new Response(null, { status: 204 }));
      if (req.method === 'POST' && url.pathname === '/browser') return cors(env, await onBrowser(req, env, ctx));
      if (req.method === 'POST' && url.pathname === '/kajabi') return await onWebhook(req, env, ctx, url);
      if (req.method === 'GET' && url.pathname === '/debug') return await onDebug(env, url);
      if (req.method === 'GET' && url.pathname === '/health') return json({ ok: true, mode: mode(env) });
      return new Response('not found', { status: 404 });
    } catch (e) {
      await debugLog(env, 'error', { path: url.pathname, message: String(e && e.stack || e) });
      return new Response('error', { status: 500 });
    }
  }
};

/* ------------------------------------------------------------------ */
/* Browser beacon                                                      */
/* ------------------------------------------------------------------ */
async function onBrowser(req, env, ctx) {
  const origin = req.headers.get('Origin') || '';
  if (!allowedOrigin(env, origin)) return new Response('forbidden', { status: 403 });

  const raw = await req.text();
  if (raw.length > 20000) return new Response('too large', { status: 413 });
  const b = safeJson(raw);
  if (!b || !b.event_id || !b.ecommerce) return new Response('bad request', { status: 400 });

  b.ip = req.headers.get('CF-Connecting-IP') || '';
  b.user_agent = b.user_agent || req.headers.get('User-Agent') || '';
  const em = (b.user_meta && b.user_meta.em) || '';

  await env.DB.prepare(
    'INSERT OR IGNORE INTO browser_events (event_id, em, offer_id, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5)'
  ).bind(String(b.event_id), em, String(b.offer_id || ''), JSON.stringify(b), now()).run();
  await debugLog(env, 'browser', b);
  // retention: matching data 7 days, send-dedup keys 30 days
  await env.DB.batch([
    env.DB.prepare('DELETE FROM browser_events WHERE created_at < ?1').bind(now() - 7 * 86400),
    env.DB.prepare('DELETE FROM sent WHERE created_at < ?1').bind(now() - 30 * 86400)
  ]);

  if (b.test && env.ALLOW_TEST !== 'true') return new Response(null, { status: 204 });
  if (mode(env) === 'beacon') ctx.waitUntil(sendAll(env, fromBrowser(b), { browserSeen: true }));
  return new Response(null, { status: 204 });
}

/* ------------------------------------------------------------------ */
/* Kajabi webhook                                                      */
/* ------------------------------------------------------------------ */
async function onWebhook(req, env, ctx, url) {
  const key = url.searchParams.get('key') || req.headers.get('X-Webhook-Key') || '';
  if (!env.WEBHOOK_SECRET || !timingSafeEqual(key, env.WEBHOOK_SECRET)) return new Response('forbidden', { status: 403 });

  const raw = await req.text();
  const body = safeJson(raw);
  await debugLog(env, 'webhook', body || raw);
  if (!body) return new Response('bad request', { status: 400 });
  if (mode(env) !== 'webhook') return json({ ok: true, note: 'MODE is not webhook; stored for debug only' });

  const p = parseKajabi(body);
  if (!p.email) { await debugLog(env, 'webhook_unparsed', body); return json({ ok: true, note: 'no member email found' }); }

  // Kajabi's webhook can beat the browser beacon; wait before matching.
  const waitMs = Math.min(25, Number(env.MATCH_WAIT_SEC || 15)) * 1000;
  ctx.waitUntil(sleep(waitMs).then(() => processWebhook(env, p)));
  return json({ ok: true });
}

async function processWebhook(env, p) {
  const em = await sha256(norm(p.email));
  const since = now() - 6 * 3600;
  let row = null;
  if (p.offer_id) {
    row = await env.DB.prepare(
      'SELECT payload FROM browser_events WHERE em = ?1 AND offer_id = ?2 AND created_at > ?3 ORDER BY created_at DESC LIMIT 1'
    ).bind(em, String(p.offer_id), since).first();
  }
  if (!row) {
    row = await env.DB.prepare(
      'SELECT payload FROM browser_events WHERE em = ?1 AND created_at > ?2 ORDER BY created_at DESC LIMIT 1'
    ).bind(em, now() - 1800).first();
  }
  const b = row ? safeJson(row.payload) : null;
  if (b && b.test && env.ALLOW_TEST !== 'true') return;

  // Recurring payments with no checkout in the browser = renewals/installments, not new purchases.
  const recurring = /subscription|payment[ _]?plan|recurring/i.test(p.offer_type || '');
  if (!b && recurring && env.SEND_RENEWALS !== 'true') { await debugLog(env, 'skip_renewal', p); return; }

  const order = await mergeOrder(p, b, em);
  await sendAll(env, order, { browserSeen: !!b });
}

/* Tolerant parser: Kajabi outbound webhooks, wrapped {payload}, JSON:API arrays, or Zapier flat fields. */
function parseKajabi(body) {
  let o = body;
  if (o && o.payload) o = o.payload;
  if (Array.isArray(o)) {                       // JSON:API style
    const tx = o.find(x => x.type === 'transactions') || {};
    const cu = o.find(x => x.type === 'customers') || {};
    const a = tx.attributes || {}, c = cu.attributes || {};
    return {
      id: tx.id || cu.id, event: body.event || 'payment_succeeded',
      email: c.email, name: c.name, member_id: cu.id,
      offer_id: tx.relationships && tx.relationships.offer && tx.relationships.offer.data && tx.relationships.offer.data.id,
      amount: a.amount_in_cents != null ? a.amount_in_cents / 100 : null, currency: a.currency
    };
  }
  const m = o.member || o.customer || {}, off = o.offer || {}, tx = o.payment_transaction || o.transaction || {};
  const x = o.extra_contact_information || m.extra_contact_information || o;
  const pick = (...v) => v.find(z => z != null && z !== '');
  const money = (v, dec) => v == null || v === '' ? null : (dec != null ? Number(dec) : Number(v) / 100);
  return {
    id: pick(o.id, tx.id, o.purchase_id),
    event: pick(body.event, o.event, o.type),
    email: pick(m.email, o.email, o.member_email),
    name: pick(m.name, o.name, o.member_name),
    first: pick(m.first_name, o.first_name), last: pick(m.last_name, o.last_name),
    member_id: pick(m.id, o.member_id),
    offer_id: pick(off.id, o.offer_id), offer_title: pick(off.title, off.internal_title, o.offer_title),
    offer_type: pick(off.type, o.offer_type),
    amount: pick(money(tx.amount_paid, tx.amount_paid_decimal), money(o.amount_in_cents), o.amount != null ? Number(o.amount) : null),
    currency: pick(tx.currency, o.currency),
    coupon: pick(tx.coupon_code, o.coupon_code),
    discount: money(tx.discount_amount, tx.discount_amount_decimal),
    phone: pick(x.phone_number, m.phone_number), street: x.address_line_1, city: x.address_city,
    region: x.address_state, zip: x.address_zip, country: x.address_country
  };
}

async function mergeOrder(p, b, emHash) {
  const sp = String(p.name || '').trim().split(/\s+/);
  const first = norm(p.first || sp[0] || ''), last = norm(p.last || sp.slice(1).join(' '));
  const country = norm(p.country);
  let zip = norm(p.zip).replace(/\s+/g, '');
  if (country === 'us') zip = zip.slice(0, 5);
  const phone = e164(p.phone, country);
  const h = await Promise.all([phone.replace(/\D/g, ''), first, last, norm(p.city).replace(/\s+/g, ''),
    norm(p.region), zip, country, p.member_id ? String(p.member_id) : '', norm(p.street), gEmail(norm(p.email)), phone].map(sha256));

  const meta = clean({ em: emHash, ph: h[0], fn: h[1], ln: h[2], ct: h[3], st: h[4], zp: h[5], country: h[6], external_id: h[7] });
  const google = clean({ sha256_email_address: h[9], sha256_phone_number: h[10],
    address: { sha256_first_name: h[1], sha256_last_name: h[2], sha256_street: h[8], city: norm(p.city), region: norm(p.region), postal_code: zip, country } });

  const bo = b ? fromBrowser(b) : null;
  const value = p.amount != null ? p.amount : bo ? bo.value : 0;
  return {
    event_id: bo ? bo.event_id : 'kajabi_' + (p.member_id || emHash.slice(0, 12)) + '_' + (p.offer_id || 'x') + '_' + p.id,
    dedupe_key: bo ? null : 'u:' + emHash + ':' + (p.offer_id || ''),
    value, currency: p.currency || (bo && bo.currency) || 'USD',
    coupon: p.coupon || (bo && bo.coupon) || undefined,
    items: bo ? bo.items : [{ item_id: String(p.offer_id || 'kajabi_offer'), item_name: p.offer_title || 'Kajabi offer', price: value, quantity: 1 }],
    meta: Object.assign({}, bo ? bo.meta : {}, meta),            // webhook PII wins, browser fills gaps
    google: bo && Object.keys(bo.google).length ? Object.assign({}, bo.google, google) : google,
    client_id: bo ? bo.client_id : '', session_id: bo ? bo.session_id : '',
    fbp: bo ? bo.fbp : '', fbc: bo ? bo.fbc : '', ip: bo ? bo.ip : '', user_agent: bo ? bo.user_agent : '',
    page_location: bo ? bo.page_location : '', source: bo ? 'webhook+browser' : 'webhook'
  };
}

function fromBrowser(b) {
  const e = b.ecommerce || {};
  return {
    event_id: String(b.event_id), value: Number(e.value || 0), currency: e.currency || 'USD', coupon: e.coupon,
    items: e.items || [], meta: b.user_meta || {}, google: b.user_google || {},
    client_id: b.client_id || '', session_id: b.session_id || '', fbp: b.fbp || '', fbc: b.fbc || '',
    ip: b.ip || '', user_agent: b.user_agent || '', page_location: b.page_location || '', source: 'browser'
  };
}

/* ------------------------------------------------------------------ */
/* Senders                                                             */
/* ------------------------------------------------------------------ */
async function sendAll(env, o, { browserSeen }) {
  // Unmatched webhooks: Purchase + Payment Succeeded can both arrive for one order -> send once per hour
  if (o.dedupe_key && !(await claim(env, o.dedupe_key, 3600))) return;

  const jobs = [];
  if (env.META_PIXEL_ID && env.META_ACCESS_TOKEN && (await claim(env, 'meta:' + o.event_id))) jobs.push(sendMeta(env, o));
  const ga4Mode = env.GA4_SEND || 'fallback';     // always | fallback | off
  const ga4Wanted = ga4Mode === 'always' || (ga4Mode === 'fallback' && !browserSeen);
  if (ga4Wanted && env.GA4_MEASUREMENT_ID && env.GA4_API_SECRET && (await claim(env, 'ga4:' + o.event_id))) jobs.push(sendGA4(env, o));
  await Promise.all(jobs);
}

async function sendMeta(env, o) {
  const ud = {};
  for (const k of ['em', 'ph', 'fn', 'ln', 'ct', 'st', 'zp', 'country', 'external_id']) if (o.meta[k]) ud[k] = [o.meta[k]];
  if (o.ip) ud.client_ip_address = o.ip;
  if (o.user_agent) ud.client_user_agent = o.user_agent;
  if (o.fbp) ud.fbp = o.fbp;
  if (o.fbc) ud.fbc = o.fbc;
  const body = {
    data: [{
      event_name: 'Purchase', event_time: now(), event_id: o.event_id, action_source: 'website',
      event_source_url: o.page_location || env.SITE_URL || undefined, user_data: ud,
      custom_data: {
        currency: o.currency, value: o.value, order_id: o.event_id, content_type: 'product',
        content_ids: o.items.map(i => String(i.item_id)),
        contents: o.items.map(i => ({ id: String(i.item_id), quantity: i.quantity || 1, item_price: i.price }))
      }
    }]
  };
  if (env.META_TEST_EVENT_CODE) body.test_event_code = env.META_TEST_EVENT_CODE;
  const v = env.META_API_VERSION || META_DEFAULT_VERSION;
  return post(env, 'meta', `https://graph.facebook.com/${v}/${env.META_PIXEL_ID}/events?access_token=${encodeURIComponent(env.META_ACCESS_TOKEN)}`, body);
}

async function sendGA4(env, o) {
  const params = {
    transaction_id: o.event_id, value: o.value, currency: o.currency, coupon: o.coupon,
    items: o.items, engagement_time_msec: 1, server_backup: o.source
  };
  if (o.session_id) params.session_id = o.session_id;
  const body = {
    client_id: o.client_id || `${rand()}.${now()}`,      // no browser = new anonymous client
    events: [{ name: 'purchase', params }]
  };
  if (o.ip) body.ip_override = o.ip;
  if (env.GA4_USER_DATA === 'true' && Object.keys(o.google).length) {
    const g = o.google, ud = {};
    if (g.sha256_email_address) ud.sha256_email_address = [g.sha256_email_address];
    if (g.sha256_phone_number) ud.sha256_phone_number = [g.sha256_phone_number];
    if (g.address) ud.address = [g.address];
    body.user_data = ud;
  }
  const host = env.GA4_DEBUG === 'true' ? 'https://www.google-analytics.com/debug/mp/collect' : 'https://www.google-analytics.com/mp/collect';
  return post(env, 'ga4', `${host}?measurement_id=${env.GA4_MEASUREMENT_ID}&api_secret=${encodeURIComponent(env.GA4_API_SECRET)}`, body);
}

async function post(env, kind, url, body) {
  if (env.DRY_RUN === 'true') { await debugLog(env, 'dry_' + kind, body); return; }
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const t = await r.text();
  await debugLog(env, (KNOWN_OK_STATUSES.has(r.status) ? 'sent_' : 'fail_') + kind, { status: r.status, response: t.slice(0, 500), event_id: body.data ? body.data[0].event_id : body.events[0].params.transaction_id });
}

/* ------------------------------------------------------------------ */
/* Debug                                                               */
/* ------------------------------------------------------------------ */
async function onDebug(env, url) {
  if (!env.WEBHOOK_SECRET || !timingSafeEqual(url.searchParams.get('key') || '', env.WEBHOOK_SECRET)) return new Response('forbidden', { status: 403 });
  const rows = await env.DB.prepare('SELECT kind, body, created_at FROM debug ORDER BY id DESC LIMIT 30').all();
  return json(rows.results.map(r => ({ kind: r.kind, at: new Date(r.created_at * 1000).toISOString(), body: safeJson(r.body) || r.body })));
}
async function debugLog(env, kind, body) {
  if (env.DEBUG !== 'true' && !/^fail_|error|webhook_unparsed/.test(kind)) return;   // failures always logged
  const safe = typeof body === 'string' ? '[raw body hidden]' : JSON.stringify(redact(body)).slice(0, 20000);
  await env.DB.prepare('INSERT INTO debug (kind, body, created_at) VALUES (?1, ?2, ?3)').bind(kind, safe, now()).run();
  await env.DB.prepare('DELETE FROM debug WHERE created_at < ?1').bind(now() - 7 * 86400).run();
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
// Debug rows keep the payload SHAPE but never readable PII (hashes are fine).
const PII_KEY = /^(email|member_email|name|member_name|first_name|last_name|phone|phone_number|mobile_phone_number|address_line_1|address_line_2|street|city|address_city|zip|address_zip|postal_code|state|address_state|region|ip|client_ip_address)$/i;
function redact(o) {
  if (Array.isArray(o)) return o.map(redact);
  if (!o || typeof o !== 'object') return o;
  const r = {};
  for (const k of Object.keys(o)) {
    const v = o[k];
    r[k] = v && typeof v === 'object' ? redact(v)
      : PII_KEY.test(k) && !(k === 'name' && o.params) && typeof v === 'string' && v && !/^[a-f0-9]{64}$/.test(v) ? '[redacted]' : v;
  }
  return r;
}
async function claim(env, key, ttlSec) {
  if (ttlSec) await env.DB.prepare('DELETE FROM sent WHERE key = ?1 AND created_at < ?2').bind(key, now() - ttlSec).run();
  const r = await env.DB.prepare('INSERT OR IGNORE INTO sent (key, created_at) VALUES (?1, ?2)').bind(key, now()).run();
  return r.meta.changes > 0;
}
function mode(env) { return env.MODE === 'webhook' ? 'webhook' : 'beacon'; }
function allowedOrigin(env, origin) {
  const list = String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  return list.length ? list.includes(origin) : false;
}
function cors(env, res) {
  const h = new Headers(res.headers);
  h.set('Access-Control-Allow-Origin', String(env.ALLOWED_ORIGINS || '').split(',')[0].trim() || 'null');
  h.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Content-Type');
  return new Response(res.body, { status: res.status, headers: h });
}
function json(o, status = 200) { return new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } }); }
function safeJson(s) { try { return typeof s === 'string' ? JSON.parse(s) : s; } catch { return null; } }
function now() { return Math.floor(Date.now() / 1000); }
function rand() { return Math.floor(Math.random() * 2147483647); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function norm(s) { return s == null ? '' : String(s).trim().toLowerCase(); }
function gEmail(e) { return e.replace(/^([^@]+)@(gmail|googlemail)\.com$/, (a, u, d) => u.replace(/\./g, '') + '@' + d + '.com'); }
function clean(o) {
  for (const k of Object.keys(o)) {
    if (o[k] && typeof o[k] === 'object') { clean(o[k]); if (!Object.keys(o[k]).length) delete o[k]; }
    else if (o[k] === '' || o[k] == null) delete o[k];
  }
  return o;
}
const CC = { us: '1', ca: '1', jm: '1', bs: '1', bb: '1', tt: '1', pr: '1', gb: '44', ie: '353', ng: '234', gh: '233',
  ke: '254', za: '27', au: '61', nz: '64', de: '49', fr: '33', nl: '31', in: '91', ae: '971' };
function e164(phone, country) {
  const raw = String(phone || '').trim(); let dg = raw.replace(/\D/g, '');
  if (!dg) return '';
  if (raw[0] === '+') return '+' + dg;
  if (raw.startsWith('00')) return '+' + dg.slice(2);
  const cc = CC[country]; if (!cc) return '';
  if (dg[0] === '0') dg = dg.slice(1);
  if (!(dg.startsWith(cc) && dg.length > 10)) dg = cc + dg;
  return '+' + dg;
}
async function sha256(s) {
  if (!s) return '';
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
