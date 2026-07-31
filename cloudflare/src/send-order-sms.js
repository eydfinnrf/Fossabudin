/**
 * Fossábúðin — order verification + SMS Worker (Cloudflare)
 *
 * Phone-verified ordering:
 *   POST /request-code  { phone, turnstileToken }
 *     -> Turnstile bot-check, validate +298 mobile, rate-limit, make a 6-digit
 *        code, store it (hashed, 10-min TTL) in KV, and SMS it to the customer.
 *   POST /verify-order  { phone, code, orderDetails }
 *     -> check the code; if correct, SMS the order to the shop owner. Done.
 *
 * Secrets/bindings (never hard-coded):
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN  (or TWILIO_API_KEY_SID/_SECRET),
 *   TWILIO_PHONE, SHOP_OWNER_PHONE, TURNSTILE_SECRET, KV: ORDER_CODES
 */

const CODE_TTL_MS = 10 * 60 * 1000; // codes valid 10 minutes
const MAX_TRIES = 5; // wrong-code attempts before a code is burned

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== 'POST') {
      return json({ error: 'method_not_allowed' }, 405, cors);
    }

    const path = new URL(request.url).pathname;
    try {
      if (path === '/request-code') return await handleRequestCode(request, env, cors);
      if (path === '/verify-order') return await handleVerifyOrder(request, env, cors);
      return json({ error: 'not_found' }, 404, cors);
    } catch (err) {
      console.error('Error:', err);
      return json({ error: err.message }, 500, cors);
    }
  },
};

/* ---------- endpoints ---------- */

async function handleRequestCode(request, env, cors) {
  const { phone, turnstileToken } = await request.json();
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const p = normalizePhone(phone);
  if (!validFaroeMobile(p)) return json({ error: 'invalid_phone' }, 400, cors);

  // 1) Bot check
  if (!(await verifyTurnstile(env, turnstileToken, ip))) {
    return json({ error: 'bot_check_failed' }, 403, cors);
  }

  const kv = env.ORDER_CODES;
  const now = Date.now();

  // 2) Rate limits — per phone (60s cooldown, 5/hour, 10/day) and per IP (20/hour)
  const phoneRl = await rateCheck(kv, 'rl:phone:' + p, now, {
    cooldownMs: 60 * 1000, hourMax: 5, dayMax: 10,
  });
  if (phoneRl) return json({ error: phoneRl }, 429, cors);
  if (ip) {
    const ipRl = await rateCheck(kv, 'rl:ip:' + ip, now, { cooldownMs: 0, hourMax: 20, dayMax: 60 });
    if (ipRl) return json({ error: 'ip_' + ipRl }, 429, cors);
  }

  // 3) Make + store the code (hashed), then SMS it to the customer
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const rec = { hash: await sha256(p + ':' + code), exp: now + CODE_TTL_MS, tries: 0 };
  await kv.put('code:' + p, JSON.stringify(rec), { expirationTtl: Math.ceil(CODE_TTL_MS / 1000) + 60 });

  await sendSms(env, p,
    `Fossábúðin: Tín váttanarkóði er ${code}. Koðin er galdandi í 10 minuttir.`);

  return json({ ok: true }, 200, cors);
}

async function handleVerifyOrder(request, env, cors) {
  const { phone, code, orderDetails } = await request.json();
  const p = normalizePhone(phone);
  if (!validFaroeMobile(p)) return json({ error: 'invalid_phone' }, 400, cors);
  if (!orderDetails) return json({ error: 'missing_order' }, 400, cors);

  const kv = env.ORDER_CODES;
  const raw = await kv.get('code:' + p);
  if (!raw) return json({ error: 'code_expired' }, 400, cors);

  const rec = JSON.parse(raw);
  if (Date.now() > rec.exp) {
    await kv.delete('code:' + p);
    return json({ error: 'code_expired' }, 400, cors);
  }
  if (rec.tries >= MAX_TRIES) {
    await kv.delete('code:' + p);
    return json({ error: 'too_many_tries' }, 429, cors);
  }
  if ((await sha256(p + ':' + String(code || '').trim())) !== rec.hash) {
    rec.tries += 1;
    await kv.put('code:' + p, JSON.stringify(rec), { expirationTtl: Math.ceil(CODE_TTL_MS / 1000) + 60 });
    return json({ error: 'wrong_code', triesLeft: MAX_TRIES - rec.tries }, 400, cors);
  }

  // Correct — burn the code, notify the shop owner, and confirm to the customer.
  await kv.delete('code:' + p);
  // Receipt to the shop owner (critical).
  await sendSms(env, env.SHOP_OWNER_PHONE, `Ný bílegging frá: ${p}\n\n${orderDetails}`);
  // Order confirmation to the customer (best-effort — don't fail the order on this).
  try {
    await sendSms(env, p, `Takk fyri bíleggingina!\n\nTín bílegging:\n${orderDetails}`);
  } catch (e) {
    console.warn('Customer confirmation SMS failed:', e);
  }
  return json({ ok: true }, 200, cors);
}

/* ---------- helpers ---------- */

// +298 mobile, exactly 6 digits, first digit 2/5/7/8
function normalizePhone(raw) {
  let p = String(raw || '').replace(/\s|-/g, '');
  if (!p.startsWith('+')) p = '+298' + p.replace(/\D/g, '');
  return p;
}
function validFaroeMobile(p) {
  return /^\+298[2578]\d{5}$/.test(p);
}

async function verifyTurnstile(env, token, ip) {
  if (!env.TURNSTILE_SECRET) throw new Error('Turnstile is not configured');
  const form = new URLSearchParams();
  form.set('secret', env.TURNSTILE_SECRET);
  form.set('response', token || '');
  if (ip) form.set('remoteip', ip);
  const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST', body: form,
  });
  const data = await resp.json().catch(() => ({}));
  return data.success === true;
}

// Returns null if allowed, or a reason string if rate-limited. Updates counters.
async function rateCheck(kv, key, now, { cooldownMs, hourMax, dayMax }) {
  const raw = await kv.get(key);
  const rl = raw ? JSON.parse(raw) : { last: 0, hour: [], day: 0, dayStart: now };
  if (cooldownMs && now - rl.last < cooldownMs) return 'too_soon';
  rl.hour = (rl.hour || []).filter((t) => now - t < 3600 * 1000);
  if (rl.hour.length >= hourMax) return 'hourly_limit';
  if (now - (rl.dayStart || 0) > 24 * 3600 * 1000) { rl.day = 0; rl.dayStart = now; }
  if ((rl.day || 0) >= dayMax) return 'daily_limit';
  rl.last = now; rl.hour.push(now); rl.day = (rl.day || 0) + 1;
  await kv.put(key, JSON.stringify(rl), { expirationTtl: 24 * 3600 });
  return null;
}

async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sendSms(env, to, body) {
  const accountSid = env.TWILIO_ACCOUNT_SID;
  const from = env.TWILIO_PHONE;
  const authUser = env.TWILIO_API_KEY_SID || accountSid;
  const authPass = env.TWILIO_API_KEY_SECRET || env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authPass || !from) throw new Error('Twilio secrets are not configured');

  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa(`${authUser}:${authPass}`),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: to, From: from, Body: body }).toString(),
  });
  if (!resp.ok) throw new Error(`Twilio ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}
