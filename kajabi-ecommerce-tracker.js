/*!
 * Kajabi GTM Ecommerce Tracker v1.3.0 (Kajabi -> GA4 ecommerce dataLayer)
 * https://github.com/Iyke76/kajabi-gtm-ecommerce-tracker  |  Docs: https://iyrexmedia.com/gtm-form-listeners/kajabi-checkout/
 * MIT License (c) 2026 Iyke Abel
 * Pushes GA4-format ecommerce events to window.dataLayer for any Kajabi offer checkout.
 *
 * Events: view_item_list, select_item (pages linking to offers)
 *         view_item, begin_checkout, apply_coupon, add_payment_info, purchase (checkouts)
 *
 * How it works: reads Kajabi's own checkout API responses (same-origin), not the page text.
 *   GET  /api/offers/{token}/checkout                 -> offer, price, currency, bumps
 *   GET  /api/offers/{token}/checkout/coupon/{code}   -> discount, due now
 *   POST /api/offers/{token}/checkout                 -> order_checkout_id (transaction_id)
 *   GET  /api/order_checkout/{id}/status              -> "succeeded" = purchase
 *
 * Health: pushes 'kajabi_ecom_error' if Kajabi's API stops looking the way this script expects.
 * Server backup (optional): set serverUrl to send each purchase to kajabi-capi-worker.js.
 *
 * Install: GTM Custom HTML tag, trigger "Initialization - All Pages" (or All Pages).
 * Written in ES5 so GTM's Custom HTML validator accepts it.
 */
(function (w, d) {
  'use strict';
  if (w.__kjbEcom) return;
  var VERSION = '1.3.0';
  w.__kjbEcom = { version: VERSION };

  /* ---------------- CONFIG ---------------- */
  var CFG = {
    debug: false,            // true = log every push to the console
    brand: '',               // item_brand; empty = Kajabi site title
    category: 'Kajabi Offer',// item_category
    trackOfferLinks: true,   // view_item_list + select_item on pages that link to offers
    maxListItems: 12,        // max offers fetched for view_item_list
    // Customer data on purchase, for Google Ads Enhanced Conversions + Meta Advanced Matching.
    //   'off'    = no PII in the dataLayer
    //   'plain'  = normalized values (Google tag + Meta Pixel hash them before sending)
    //   'hashed' = SHA-256 in the dataLayer (raw PII never enters the dataLayer; use for CAPI / sGTM)
    userData: 'off',
    pendingTtlMin: 120,      // how long an unconfirmed order is kept for recovery
    healthEvents: true,      // push 'kajabi_ecom_error' when Kajabi's API looks different than expected
    // Server-side backup (optional). Base URL of your kajabi-capi-worker, e.g. 'https://track.yourdomain.com'.
    // Empty = off. Sends hashed customer data + click ids to YOUR server only, never to a third party.
    serverUrl: '',
    ga4MeasurementId: ''     // e.g. 'G-XXXXXXX'; lets the server hit join the buyer's GA4 session
  };
  // Optional override: define window.KJB_ECOM_CONFIG = { ... } before this script loads.
  (function (o) { if (o && typeof o === 'object') for (var k in o) if (o.hasOwnProperty(k) && CFG.hasOwnProperty(k)) CFG[k] = o[k]; })(w.KJB_ECOM_CONFIG);

  var dl = w.dataLayer = w.dataLayer || [];
  var K_DONE = 'kjb_ecom_done', K_PEND = 'kjb_ecom_pending', K_LIST = 'kjb_ecom_list', K_UD = 'kjb_ecom_ud_',
    K_SRV = 'kjb_ecom_srv_', K_BEACON = 'kjb_ecom_beacon';
  var RX_PAGE = /\/offers\/([A-Za-z0-9]+)\/checkout/;
  var RX_LINK = /\/(?:resource_redirect\/)?offers\/([A-Za-z0-9]+)/;
  var RX_API_OFFER = /\/api\/offers\/([A-Za-z0-9]+)\/checkout(?:\/coupon\/([^\/?#]+))?\/?(?:[?#]|$)/;
  var RX_API_STATUS = /\/api\/order_checkout\/([^\/?#]+)\/status/;

  var offers = {};   // token -> Promise(data|null)
  var st = {};       // token -> { coupon, viewed, began }
  var subs = {};     // order_checkout_id -> Promise(record)

  /* ---------------- helpers ---------------- */
  function log() { if (CFG.debug && w.console) console.log.apply(console, ['[kjb-ecom]'].concat([].slice.call(arguments))); }
  function json(s) { try { return typeof s === 'string' ? JSON.parse(s) : s; } catch (e) { return null; } }
  function ls(k, v) {
    try {
      if (arguments.length === 1) return JSON.parse(w.localStorage.getItem(k) || 'null');
      if (v === null) w.localStorage.removeItem(k); else w.localStorage.setItem(k, JSON.stringify(v));
    } catch (e) { return null; }
  }
  function ss(k, v) {
    try {
      if (arguments.length === 1) return JSON.parse(w.sessionStorage.getItem(k) || 'null');
      w.sessionStorage.setItem(k, JSON.stringify(v));
    } catch (e) { return null; }
  }
  function amt(cents, exp) { return Math.round(Number(cents || 0)) / Math.pow(10, exp == null ? 2 : exp); }
  function trim(s) { return s ? String(s).replace(/\s+/g, ' ').replace(/^\s|\s$/g, '') : ''; }
  function state(t) { return st[t] || (st[t] = {}); }
  function now() { return new Date().getTime(); }

  /* ---------------- health events ---------------- */
  var reported = {};
  function health(type, detail, token) {
    if (!CFG.healthEvents || reported[type]) return;   // once per type per page
    reported[type] = 1;
    dl.push({ event: 'kajabi_ecom_error', error_type: type, error_detail: String(detail || '').slice(0, 150),
      kajabi_offer_token: token || undefined, kajabi_ecom_version: VERSION, page_path: location.pathname });
    log('health', type, detail);
  }

  var lastEvents = [];
  function push(event, ecommerce, extra) {
    dl.push({ ecommerce: null });
    var o = { event: event, ecommerce: ecommerce };
    if (extra) for (var k in extra) if (extra.hasOwnProperty(k)) o[k] = extra[k];
    dl.push(o);
    lastEvents.push(event + (ecommerce && ecommerce.value != null ? ' (' + ecommerce.value + ' ' + (ecommerce.currency || '') + ')' : ''));
    if (lastEvents.length > 10) lastEvents.shift();
    log(event, o);
  }

  // Debug API: window.__kjbEcom.status() in the browser console
  w.__kjbEcom.status = function () {
    return { version: VERSION, config: { userData: CFG.userData, serverUrl: CFG.serverUrl, healthEvents: CFG.healthEvents,
        trackOfferLinks: CFG.trackOfferLinks, debug: CFG.debug },
      checkoutPage: RX_PAGE.test(location.pathname), offersSeen: Object.keys(offers),
      pendingOrders: Object.keys(ls(K_PEND) || {}).length, healthErrors: Object.keys(reported), lastEvents: lastEvents.slice() };
  };

  function xget(url) {
    return new Promise(function (res) {
      var x = new XMLHttpRequest();
      x.__kjbSkip = true;
      x.open('GET', url, true);
      x.setRequestHeader('Accept', 'application/json');
      x.onload = function () { var j = json(x.responseText); res(x.status < 300 && j ? j.data : null); };
      x.onerror = function () { res(null); };
      x.send();
    });
  }

  function getOffer(token) {
    if (!offers[token]) offers[token] = xget('/api/offers/' + token + '/checkout').then(function (data) {
      if (!data) health('offer_api_failed', 'GET /api/offers/' + token + '/checkout returned no data', token);
      else if (!data.price || data.price.amount == null || !data.offer)
        health('offer_api_shape', 'unexpected offer data; keys: ' + Object.keys(data).join(','), token);
      return data;
    });
    return offers[token];
  }

  /* ---------------- item / ecommerce builders ---------------- */
  function listCtx(token) {
    var l = ss(K_LIST);
    return l && l.token === token ? l : null;
  }

  function offerItem(token, data, qty) {
    var p = data.price || {}, o = data.offer || {};
    var it = {
      item_id: token,
      item_name: trim(o.title) || token,
      item_brand: CFG.brand || (data.site && data.site.title) || undefined,
      item_category: CFG.category,
      item_variant: p.price_type || undefined,
      price: amt(p.amount, p.exponent),
      quantity: qty || 1,
      kajabi_offer_id: o.id != null ? String(o.id) : undefined
    };
    var l = listCtx(token);
    if (l) { it.item_list_name = l.name; it.index = l.index; }
    return it;
  }

  function bumpItems(data, selected) {
    var out = [], ids = {};
    (selected || []).forEach(function (s) {
      var id = s && typeof s === 'object' ? (s.id || s.order_bump_id || s.offer_id) : s;
      if (id != null) ids[String(id)] = 1;
    });
    (data.order_bumps || []).forEach(function (b) {
      if (!ids[String(b.id)] && !(b.offer && ids[String(b.offer.id)])) return;
      var p = b.price || (b.offer && b.offer.price) || {};
      var cents = p.amount != null ? p.amount : (b.amount != null ? b.amount : b.price_in_cents);
      out.push({
        item_id: String(b.offer_token || (b.offer && b.offer.token) || b.id),
        item_name: trim(b.title || b.offer_title || (b.offer && b.offer.title)) || 'Order bump',
        item_category: CFG.category,
        item_variant: 'order_bump',
        price: amt(cents, p.exponent),
        quantity: 1,
        _cents: Number(cents || 0)
      });
    });
    return out;
  }

  // ctx: { qty, coupon (Kajabi coupon object), bumps (selected ids) }
  function buildEcom(token, data, ctx) {
    ctx = ctx || {};
    var p = data.price || {}, exp = p.exponent, qty = Number(ctx.qty) || 1;
    var item = offerItem(token, data, qty);
    var gross = Number(p.amount || 0) * qty, due = gross, c = ctx.coupon;

    if (c && c.coupon_code) {
      var disc = Number(c.discount_amount || 0);
      item.coupon = c.coupon_code;
      if (disc) {
        item.discount = amt(disc / qty, exp);
        item.price = amt((gross - disc) / qty, exp);
      }
      due = c.due_now_amount != null ? Number(c.due_now_amount) : Math.max(gross - disc, 0);
    }
    if (p.free) { due = 0; item.price = 0; }

    var items = [item];
    bumpItems(data, ctx.bumps).forEach(function (b) { due += b._cents; delete b._cents; items.push(b); });

    var e = { currency: p.currency || 'USD', value: amt(due, exp), items: items };
    if (c && c.coupon_code) e.coupon = c.coupon_code;
    return e;
  }

  /* ---------------- customer data (Enhanced Conversions / Advanced Matching) ---------------- */
  var CC = { US: '1', CA: '1', JM: '1', BS: '1', BB: '1', TT: '1', PR: '1', GB: '44', IE: '353', NG: '234', GH: '233',
    KE: '254', ZA: '27', AU: '61', NZ: '64', DE: '49', FR: '33', NL: '31', IN: '91', AE: '971' };
  function norm(s) { return s == null ? '' : String(s).replace(/^\s+|\s+$/g, '').toLowerCase(); }
  function e164(phone, country) {
    var raw = String(phone || '').replace(/^\s+|\s+$/g, ''), dg = raw.replace(/\D/g, '');
    if (!dg) return '';
    if (raw.charAt(0) === '+') return '+' + dg;
    if (raw.indexOf('00') === 0) return '+' + dg.slice(2);
    var cc = CC[String(country || '').toUpperCase()];
    if (!cc) return '';                         // can't know the country code: don't guess
    if (dg.charAt(0) === '0') dg = dg.slice(1); // drop national trunk 0
    if (!(dg.indexOf(cc) === 0 && dg.length > 10)) dg = cc + dg;
    return '+' + dg;
  }
  function sha256(s) {
    if (!s) return Promise.resolve('');
    if (!(w.crypto && w.crypto.subtle && w.TextEncoder)) return Promise.resolve('');
    return w.crypto.subtle.digest('SHA-256', new w.TextEncoder().encode(s)).then(function (b) {
      var a = new Uint8Array(b), h = '';
      for (var i = 0; i < a.length; i++) h += ('0' + a[i].toString(16)).slice(-2);
      return h;
    });
  }
  function clean(o) {
    for (var k in o) if (o.hasOwnProperty(k)) {
      if (o[k] && typeof o[k] === 'object') { clean(o[k]); if (!Object.keys(o[k]).length) delete o[k]; }
      else if (o[k] === '' || o[k] == null) delete o[k];
    }
    return o;
  }

  // Pull PII from the checkout POST body (falls back to the logged-in member).
  function collectPII(body, data) {
    var m = body.member || {}, x = body.extra_contact_information || {}, mem = (data && data.member) || {};
    var full = trim(m.name || body.name || x.name || mem.name);
    var sp = full ? full.split(' ') : [];
    var country = String(x.address_country || m.address_country || '').toUpperCase();
    var zip = norm(x.address_zip).replace(/\s+/g, '');
    return {
      email: norm(m.email || body.email || mem.email),
      phone: e164(m.phone_number || x.phone_number || body.phone_number || x.phone || m.phone, country),
      first: norm(sp[0]),
      last: norm(sp.slice(1).join(' ')),
      street: norm(x.address_line_1),
      city: norm(x.address_city),
      region: norm(x.address_state),
      zip: country === 'US' ? zip.slice(0, 5) : zip,
      country: country.toLowerCase(),
      external_id: mem.id != null ? String(mem.id) : ''
    };
  }

  // -> Promise({ google: {...}, meta: {...} })
  function buildUserData(p, mode) {
    var metaPhone = p.phone.replace(/\D/g, '');
    if (mode !== 'hashed') {
      return Promise.resolve({
        google: clean({ email: p.email, phone_number: p.phone,
          address: { first_name: p.first, last_name: p.last, street: p.street, city: p.city,
            region: p.region, postal_code: p.zip, country: p.country } }),
        meta: clean({ em: p.email, ph: metaPhone, fn: p.first, ln: p.last, ct: p.city.replace(/\s+/g, ''),
          st: p.region, zp: p.zip, country: p.country, external_id: p.external_id })
      });
    }
    // Google: gmail/googlemail dots before @ are removed before hashing
    var gEmail = p.email.replace(/^([^@]+)@(gmail|googlemail)\.com$/, function (a, u, dom) { return u.replace(/\./g, '') + '@' + dom + '.com'; });
    return Promise.all([gEmail, p.phone, p.first, p.last, p.street,
      p.email, metaPhone, p.city.replace(/\s+/g, ''), p.region, p.zip, p.country, p.external_id].map(sha256))
      .then(function (h) {
        return {
          google: clean({ sha256_email_address: h[0], sha256_phone_number: h[1],
            address: { sha256_first_name: h[2], sha256_last_name: h[3], sha256_street: h[4],
              city: p.city, region: p.region, postal_code: p.zip, country: p.country } }),
          meta: clean({ em: h[5], ph: h[6], fn: h[2], ln: h[3], ct: h[7], st: h[8], zp: h[9], country: h[10], external_id: h[11] })
        };
      });
  }

  function testFlag(data) { return data && data.test_mode ? { kajabi_test_mode: true } : undefined; }

  /* ---------------- checkout events ---------------- */
  function viewCheckout(token, beginNow) {
    getOffer(token).then(function (data) {
      if (!data || !data.price) return;
      var s = state(token);
      if (!s.viewed) { s.viewed = 1; push('view_item', buildEcom(token, data), testFlag(data)); }
      if (beginNow) begin(token);
    });
  }

  function begin(token) {
    var s = state(token);
    if (s.began) return;
    s.began = 1;
    getOffer(token).then(function (data) {
      if (data && data.price) push('begin_checkout', buildEcom(token, data, { coupon: s.coupon }), testFlag(data));
    });
  }

  function onCoupon(token, coupon) {
    state(token).coupon = coupon;
    getOffer(token).then(function (data) {
      if (!data || !data.price) return;
      push('apply_coupon', buildEcom(token, data, { coupon: coupon }), testFlag(data));
    });
  }

  function onSubmit(token, body, resp) {
    body = body || {};
    var id = resp && (resp.order_checkout_id || resp.id);
    if (!id) health('submit_no_id', 'checkout POST response keys: ' + (resp ? Object.keys(resp).join(',') : 'none'), token);
    var s = state(token);
    var code = body.coupon_code;
    var couponP = !code ? Promise.resolve(null)
      : (s.coupon && s.coupon.coupon_code === code) ? Promise.resolve(s.coupon)
      : xget('/api/offers/' + token + '/checkout/coupon/' + encodeURIComponent(code)).then(function (r) { return r && r.coupon; });

    var p = Promise.all([getOffer(token), couponP]).then(function (r) {
      var data = r[0];
      if (!data || !data.price) return null;
      var ecom = buildEcom(token, data, { qty: body.quantity, coupon: r[1], bumps: body.selected_order_bumps });
      if (!s.began) { s.began = 1; push('begin_checkout', JSON.parse(JSON.stringify(ecom)), testFlag(data)); }
      ecom.payment_type = ecom.value > 0 ? 'card' : 'free';
      push('add_payment_info', JSON.parse(JSON.stringify(ecom)), testFlag(data));
      var rec = { id: id, token: token, ecom: ecom, ts: now(), test: !!data.test_mode, status: 'pending' };
      if (id) savePending(rec);
      if (!id) return rec;
      // PII lives in sessionStorage only (same tab, cleared once used), never localStorage
      var pii = collectPII(body, data), tasks = [];
      if (CFG.userData !== 'off') tasks.push(buildUserData(pii, CFG.userData).then(function (ud) { ss(K_UD + id, ud); }));
      if (CFG.serverUrl) tasks.push(buildUserData(pii, 'hashed').then(function (ud) { ss(K_SRV + id, ud); }));
      if ((CFG.userData === 'hashed' || CFG.serverUrl) && !(w.crypto && w.crypto.subtle))
        health('hash_unavailable', 'crypto.subtle missing; hashed user data skipped', token);
      return Promise.all(tasks).then(function () { return rec; }, function () { return rec; });
    });
    if (id) subs[id] = p;
  }

  /* ---------------- purchase (deduped, survives the redirect) ---------------- */
  function pendings() { return ls(K_PEND) || {}; }
  function savePending(rec) { var p = pendings(); p[rec.id] = rec; ls(K_PEND, p); }
  function dropPending(id) { var p = pendings(); delete p[id]; ls(K_PEND, p); }
  function isDone(id) { return (ls(K_DONE) || []).indexOf(id) > -1; }
  function markDone(id) { var a = ls(K_DONE) || []; a.push(id); ls(K_DONE, a.slice(-50)); }

  function firePurchase(rec) {
    if (!rec || !rec.id || isDone(rec.id)) return;
    beacon(rec);                                 // no-op if already sent or serverUrl empty
    markDone(rec.id);
    dropPending(rec.id);
    var e = rec.ecom;
    e.transaction_id = rec.id;
    var extra = { event_id: rec.id };            // use as Meta eventID for Pixel/CAPI dedup
    if (rec.test) extra.kajabi_test_mode = true;
    if (CFG.userData === 'off') { push('purchase', e, extra); return; }
    var saved = ss(K_UD + rec.id);
    try { w.sessionStorage.removeItem(K_UD + rec.id); } catch (x) {}

    // Fallback: buyer is logged in after checkout, so Kajabi's API returns their email/name
    var udP = saved ? Promise.resolve(saved) : getOffer(rec.token).then(function (data) {
      var p = data && data.member ? collectPII({}, data) : null;
      return p && p.email ? buildUserData(p, CFG.userData) : null;
    }, function () { return null; });

    udP.then(function (ud) {
      if (!ud) { log('purchase: no user data found'); push('purchase', e, extra); return; }
      var cu = w.Kajabi && w.Kajabi.currentSiteUser;
      var ext = ud.meta.external_id ? Promise.resolve(ud.meta.external_id)
        : cu && (cu.id || cu.contactId) ? (CFG.userData === 'hashed' ? sha256(String(cu.id || cu.contactId)) : Promise.resolve(String(cu.id || cu.contactId)))
        : Promise.resolve('');
      return ext.then(function (id) {
        if (id) ud.meta.external_id = id;
        extra.user_data = ud.google;
        extra.meta_user_data = ud.meta;
        push('purchase', e, extra);
      });
    })['catch'](function () { push('purchase', e, extra); });
  }

  // Kajabi redirects ~milliseconds after "succeeded", too fast for tags to send.
  // So: mark it succeeded, fire on this page only if we are still here after 1.5s,
  // otherwise the next page load (thank-you page) fires it.
  function onStatus(id, data) {
    var status = data && data.status;
    if (status === 'succeeded') {
      (subs[id] || Promise.resolve(pendings()[id])).then(function (rec) {
        if (!rec) { health('purchase_no_record', 'order ' + id + ' succeeded but checkout data was not captured'); return; }
        rec.status = 'succeeded';
        savePending(rec);
        beacon(rec);                             // sendBeacon survives Kajabi's instant redirect
        var leaving = false;
        w.addEventListener('pagehide', function () { leaving = true; });
        setTimeout(function () { if (!leaving) firePurchase(pendings()[id]); }, 1500);
      });
    } else if (status === 'failed' || status === 'error' || status === 'canceled') {
      dropPending(id);
    } else if (!/^(pending|processing|requires_action|requires_payment_method|created)$/.test(status || '')) {
      health('status_unknown', 'order status: ' + status);
    }
  }

  /* ---------------- server-side backup beacon ---------------- */
  function cookie(n) {
    var m = d.cookie.match(new RegExp('(?:^|; )' + n.replace(/([.$?*|{}()\[\]\\\/+^])/g, '\\$1') + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : '';
  }
  function gaIds() {
    var ga = cookie('_ga').split('.'), sc = '', sid = '';
    if (CFG.ga4MeasurementId) sc = cookie('_ga_' + CFG.ga4MeasurementId.replace(/^G-/, ''));
    else { var mm = d.cookie.match(/(?:^|; )_ga_[A-Z0-9]+=([^;]*)/); sc = mm ? mm[1] : ''; }
    if (/^GS1\./.test(sc)) sid = sc.split('.')[2] || '';
    else if (/^GS2\./.test(sc)) { var mt = (sc.split('.')[2] || '').match(/(?:^|\$)s(\d+)/); sid = mt ? mt[1] : ''; }
    return { client_id: ga.length >= 4 ? ga[2] + '.' + ga[3] : '', session_id: sid };
  }
  function beacon(rec) {
    if (!CFG.serverUrl || !rec || !rec.id) return;
    var sent = ls(K_BEACON) || [];
    if (sent.indexOf(rec.id) > -1) return;
    var srv = ss(K_SRV + rec.id) || {}, ids = gaIds(), aw = cookie('_gcl_aw').split('.');
    var ecom = JSON.parse(JSON.stringify(rec.ecom));
    ecom.transaction_id = rec.id;
    var body = JSON.stringify({
      v: VERSION, event_id: rec.id, offer_token: rec.token,
      offer_id: ecom.items && ecom.items[0] ? ecom.items[0].kajabi_offer_id : '',
      ecommerce: ecom, test: !!rec.test, ts: now(),
      user_meta: srv.meta || {}, user_google: srv.google || {},     // SHA-256 hashed only
      client_id: ids.client_id, session_id: ids.session_id,
      fbp: cookie('_fbp'), fbc: cookie('_fbc'), gclid: aw.length > 2 ? aw.slice(2).join('.') : '',
      user_agent: navigator.userAgent, page_location: location.origin + location.pathname
    });
    var url = CFG.serverUrl.replace(/\/$/, '') + '/browser', ok = false;
    try { ok = !!(navigator.sendBeacon && navigator.sendBeacon(url, new Blob([body], { type: 'text/plain' }))); } catch (e) {}
    if (!ok && w.fetch) {
      try { w.fetch(url, { method: 'POST', body: body, keepalive: true, mode: 'no-cors', headers: { 'Content-Type': 'text/plain' } }); ok = true; } catch (e) {}
    }
    if (ok) { sent.push(rec.id); ls(K_BEACON, sent.slice(-50)); try { w.sessionStorage.removeItem(K_SRV + rec.id); } catch (x) {} }
    else health('server_beacon_failed', url);
  }

  function recover() {
    var p = pendings(), ttl = CFG.pendingTtlMin * 60000;
    Object.keys(p).forEach(function (id) {
      var rec = p[id];
      if (!rec || isDone(id) || now() - rec.ts > ttl) { dropPending(id); return; }
      if (rec.status === 'succeeded') { firePurchase(rec); return; }
      xget('/api/order_checkout/' + encodeURIComponent(id) + '/status').then(function (s) {
        if (s && s.status === 'succeeded') firePurchase(pendings()[id]);
        else if (s && /failed|error|canceled/.test(s.status)) dropPending(id);
      });
    });
  }

  /* ---------------- network hooks (XHR + fetch) ---------------- */
  function onNet(method, url, body, status, text) {
    if (!url || status < 200 || status >= 300) return;
    var m = url.match(RX_API_OFFER), j;
    method = String(method || 'GET').toUpperCase();
    if (m) {
      if (m[2] && method === 'GET') {
        j = json(text);
        if (j && j.data && j.data.coupon) onCoupon(m[1], j.data.coupon);
      } else if (!m[2] && method === 'POST') {
        j = json(text);
        onSubmit(m[1], json(body), j && j.data);
      }
      return;
    }
    var s = url.match(RX_API_STATUS);
    if (s) { j = json(text); if (j && j.data) onStatus(s[1], j.data); }
  }

  var XO = XMLHttpRequest.prototype.open, XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__kjbM = m; this.__kjbU = String(u); return XO.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (b) {
    var x = this;
    if (!x.__kjbSkip && /\/api\/(offers|order_checkout)\//.test(x.__kjbU || '')) {
      x.addEventListener('load', function () {
        try { onNet(x.__kjbM, x.__kjbU, b, x.status, x.responseText); } catch (e) { log(e); health('script_exception', e && e.message); }
      });
    }
    return XS.apply(this, arguments);
  };

  if (w.fetch) {
    var F = w.fetch;
    w.fetch = function (input, init) {
      var url = String(typeof input === 'string' ? input : (input && input.url) || '');
      var method = (init && init.method) || (input && input.method) || 'GET';
      var body = init && init.body;
      var r = F.apply(this, arguments);
      if (/\/api\/(offers|order_checkout)\//.test(url)) {
        r.then(function (res) {
          res.clone().text().then(function (t) {
            try { onNet(method, url, typeof body === 'string' ? body : null, res.status, t); } catch (e) { log(e); health('script_exception', e && e.message); }
          });
        })['catch'](function () {});
      }
      return r;
    };
  }

  /* ---------------- page scanning ---------------- */
  function embeddedTokens() {
    var out = [];
    var els = d.querySelectorAll('[data-pages-embedded-checkout-react-mounter-props-value]');
    for (var i = 0; i < els.length; i++) {
      var props = json(els[i].getAttribute('data-pages-embedded-checkout-react-mounter-props-value'));
      if (props && props.offer) out.push({ token: props.offer, el: els[i] });
    }
    return out;
  }

  function scanCheckouts() {
    var pm = location.pathname.match(RX_PAGE);
    if (pm) viewCheckout(pm[1], true); // dedicated checkout page: begin_checkout on load

    embeddedTokens().forEach(function (e) {
      if (pm && e.token === pm[1]) return;
      if (e.el.__kjbBound) return;
      e.el.__kjbBound = true;
      viewCheckout(e.token, false);   // embedded on a sales page: begin on first interaction
      var go = function () { begin(e.token); };
      e.el.addEventListener('focusin', go, true);
      e.el.addEventListener('click', go, true);
    });
  }

  function scanLinks() {
    if (!CFG.trackOfferLinks || RX_PAGE.test(location.pathname)) return;
    var links = d.querySelectorAll('a[href*="/offers/"]'), seen = {}, order = [];
    for (var i = 0; i < links.length; i++) {
      var m = (links[i].getAttribute('href') || '').match(RX_LINK);
      if (m && !seen[m[1]]) { seen[m[1]] = 1; order.push(m[1]); }
    }
    order = order.slice(0, CFG.maxListItems);
    if (!order.length) return;
    var listName = trim(d.title) || location.pathname;

    Promise.all(order.map(getOffer)).then(function (all) {
      var items = [], cur = 'USD';
      all.forEach(function (data, i) {
        if (!data || !data.price) return;
        var it = offerItem(order[i], data, 1);
        it.index = i; it.item_list_name = listName;
        cur = data.price.currency || cur;
        items.push(it);
      });
      if (items.length) push('view_item_list', { item_list_id: location.pathname, item_list_name: listName, currency: cur, items: items });
    });

    d.addEventListener('click', function (ev) {
      var a = ev.target && ev.target.closest ? ev.target.closest('a[href*="/offers/"]') : null;
      if (!a) return;
      var m = (a.getAttribute('href') || '').match(RX_LINK);
      if (!m) return;
      var idx = order.indexOf(m[1]);
      ss(K_LIST, { token: m[1], name: listName, index: idx > -1 ? idx : undefined });
      var p = offers[m[1]];
      var send = function (data) {
        var it = data && data.price ? offerItem(m[1], data, 1) : { item_id: m[1], item_name: trim(a.innerText) || m[1] };
        it.item_list_name = listName; if (idx > -1) it.index = idx;
        var e = { item_list_id: location.pathname, item_list_name: listName, items: [it] };
        if (data && data.price) { e.currency = data.price.currency; e.value = it.price; }
        push('select_item', e);
      };
      if (p) p.then(send); else send(null);
    }, true);
  }

  function init() {
    recover();
    scanCheckouts();
    scanLinks();
    if (w.MutationObserver) {
      var t;
      new MutationObserver(function () { clearTimeout(t); t = setTimeout(scanCheckouts, 300); })
        .observe(d.documentElement, { childList: true, subtree: true });
    }
  }

  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', init); else init();
})(window, document);
