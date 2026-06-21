// utils/lineverify.js — phone-number verification via LineVerify (SERVER-SIDE ONLY).
// Mirrors the native-https pattern used in utils/fcm.js, so it adds no new dependency.
//
// SECURITY: the API key is read from env and used ONLY here on the server. It must never
// reach the browser. The frontend only ever receives the hosted `verify_url`; the
// trustworthy result always comes from confirmVerification() called with the API key.
//
// Required env vars (set these in Railway):
//   LINEVERIFY_API_KEY            — your API key (Bearer token). REQUIRED to enable.
//   PHONE_VERIFICATION_ENABLED    — 'false' to switch the whole feature off instantly.
//   LINEVERIFY_BASE_URL           — optional override of the base URL.
const https = require('https');

const BASE_URL = (process.env.LINEVERIFY_BASE_URL || 'https://b2b-validation-engine-production.up.railway.app').replace(/\/+$/, '');
const API_KEY  = process.env.LINEVERIFY_API_KEY || '';

// Master switch. Off when explicitly disabled OR when no API key is configured — in either
// case callers treat verification as "not required" so the app never hard-blocks players
// because of a missing key or an outage you've chosen to ride out.
function isEnabled() {
  const flag = String(process.env.PHONE_VERIFICATION_ENABLED ?? 'true').toLowerCase();
  return flag !== 'false' && !!API_KEY;
}

// Normalise an Indian mobile number to E.164 (+91XXXXXXXXXX) for both sending and matching.
function toE164(phone) {
  const s = String(phone || '').trim();
  if (s.startsWith('+')) return s.replace(/\s/g, '');
  const digits = s.replace(/\D/g, '');
  if (digits.length === 10) return '+91' + digits;
  if (digits.length === 12 && digits.startsWith('91')) return '+' + digits;
  return '+' + digits;
}

// Native https JSON request helper (mirrors utils/fcm.js httpsPost).
function httpsRequest(method, url, headers, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data   = body ? JSON.stringify(body) : null;
    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || 443,
      path:     parsed.pathname + parsed.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        let json;
        try { json = raw ? JSON.parse(raw) : {}; } catch { json = { raw }; }
        resolve({ ok: res.statusCode < 300, status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// Step 1 — start a verification for a phone number. Returns { id, verify_url, whatsapp_url, ... }.
async function startVerification(phone, metadata = {}) {
  if (!API_KEY) throw new Error('LINEVERIFY_API_KEY is not set');
  const res = await httpsRequest('POST', `${BASE_URL}/v1/verifications`,
    { Authorization: `Bearer ${API_KEY}` },
    { phone: toE164(phone), method: 'whatsapp', metadata });
  if (!res.ok) throw new Error((res.json && (res.json.message || res.json.error)) || `LineVerify start failed (${res.status})`);
  return res.json;
}

// Step 3 — confirm a verification (one-time, trustworthy). Returns { verified, phone, ... }.
async function confirmVerification(verificationId) {
  if (!API_KEY) throw new Error('LINEVERIFY_API_KEY is not set');
  const res = await httpsRequest('POST', `${BASE_URL}/v1/verifications/confirm`,
    { Authorization: `Bearer ${API_KEY}` },
    { verification_id: verificationId });
  if (!res.ok) throw new Error((res.json && (res.json.message || res.json.error)) || `LineVerify confirm failed (${res.status})`);
  return res.json;
}

module.exports = { isEnabled, toE164, startVerification, confirmVerification, BASE_URL };
