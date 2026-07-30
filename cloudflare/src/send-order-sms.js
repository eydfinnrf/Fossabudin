/**
 * Fossábúðin — order SMS Worker (Cloudflare)
 *
 * Drop-in replacement for the old Netlify function `send-order-sms`.
 * Receives an order from the website and sends two SMS via Twilio:
 *   1. a confirmation to the customer
 *   2. a notification to the shop owner
 *
 * Twilio credentials come from Worker secrets (never hard-coded):
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE, SHOP_OWNER_PHONE
 */

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    // Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405, cors);
    }

    try {
      const { customerPhone, orderDetails } = await request.json();
      const ownerPhone = env.SHOP_OWNER_PHONE;

      if (!customerPhone || !orderDetails) {
        return json({ error: 'Missing customerPhone or orderDetails' }, 400, cors);
      }

      // SMS to customer
      await sendSms(
        env,
        customerPhone,
        `Takk fyri tína bílegging!\n\n${orderDetails}\n\nTú fært víðari upplýsingar innan stuttum.`
      );

      // SMS to shop owner
      await sendSms(
        env,
        ownerPhone,
        `Ný bílegging frá: ${customerPhone}\n\n${orderDetails}`
      );

      return json({ success: true, message: 'SMS sent successfully' }, 200, cors);
    } catch (error) {
      console.error('Error:', error);
      return json({ error: error.message }, 500, cors);
    }
  },
};

/** Send one SMS through the Twilio REST API. */
async function sendSms(env, to, body) {
  const accountSid = env.TWILIO_ACCOUNT_SID;
  const from = env.TWILIO_PHONE;
  // Prefer a revocable Twilio API Key if provided; otherwise fall back to the
  // account Auth Token. The request URL always uses the Account SID.
  const authUser = env.TWILIO_API_KEY_SID || accountSid;
  const authPass = env.TWILIO_API_KEY_SECRET || env.TWILIO_AUTH_TOKEN;

  if (!accountSid || !authPass || !from) {
    throw new Error('Twilio secrets are not configured yet');
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const form = new URLSearchParams({ To: to, From: from, Body: body });

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa(`${authUser}:${authPass}`),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
  });

  if (!resp.ok) {
    const detail = await resp.text();
    throw new Error(`Twilio ${resp.status}: ${detail}`);
  }
  return resp.json();
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}
