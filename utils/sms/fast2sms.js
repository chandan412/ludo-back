// utils/sms/fast2sms.js — SMS delivery via Fast2SMS. SERVER-SIDE ONLY.
//
// This module's ONLY job is to hand a string to a phone number. It does not
// generate codes, does not store them, does not verify them. That separation is
// deliberate: it means swapping to MSG91 when your DLT registration clears is a
// new file in this folder plus one env var, not a rewrite of the auth flow.
//
// Fast2SMS also offers /dev/otp/verify and /dev/otp/resend — we deliberately do
// NOT use them. Letting the provider hold the OTP state would put the security
// boundary of your signup flow inside a vendor you can switch away from, and
// would make that switch a rewrite instead of a config change.
//
// Env vars (Railway):
//   FAST2SMS_API_KEY   — from Dev API → API Key tab. Never reaches the browser.
//   FAST2SMS_OTP_ID    — the approved template's OTP ID (e.g. 47988ca08b)
const https = require('https');

const API_KEY = process.env.FAST2SMS_API_KEY || '';
const OTP_ID  = process.env.FAST2SMS_OTP_ID || '';
const ENDPOINT = 'https://www.fast2sms.com/dev/otp/send';

function isConfigured() {
  return !!API_KEY && !!OTP_ID;
}

function httpsPostJson(url, headers, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'accept': 'application/json',
        ...headers,
        'Content-Length': Buffer.byteLength(data),
      },
      // Without a timeout a hung provider request holds the signup handler open
      // until Node's default socket timeout — the player sees a spinner that
      // never resolves and taps again, costing a second SMS.
      timeout: 12000,
    }, (res) => {
      let raw = '';
      res.on('data', c => (raw += c));
      res.on('end', () => {
        let json;
        try { json = raw ? JSON.parse(raw) : {}; } catch { json = { raw }; }
        resolve({ ok: res.statusCode < 300, status: res.statusCode, json });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('fast2sms timeout')); });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/**
 * Deliver `code` to a 10-digit Indian mobile number.
 * Returns { ok, requestId?, error? } — never throws, so a provider outage
 * surfaces as a clean "couldn't send" rather than a 500 on signup.
 */
async function sendOtp(phone10, code) {
  if (!isConfigured()) {
    return { ok: false, error: 'FAST2SMS_API_KEY or FAST2SMS_OTP_ID not set' };
  }
  try {
    const res = await httpsPostJson(ENDPOINT, { Authorization: API_KEY }, {
      mobile: String(phone10),
      otp_id: OTP_ID,
      // We supply the code — Fast2SMS's own generator is not used, because the
      // code has to be verified against OUR hash, not their state.
      otp: String(code),
    });

    if (res.ok && (res.json?.return === true || res.json?.status === 'success' || res.status === 200)) {
      return { ok: true, requestId: res.json?.request_id || res.json?.data?.request_id || null };
    }

    // Log the full body. Fast2SMS returns specific, actionable messages
    // (insufficient balance, invalid otp_id, blocked number) and losing them
    // would turn every delivery problem into guesswork.
    const msg = res.json?.message || res.json?.error || `HTTP ${res.status}`;
    console.error('fast2sms send failed:', res.status, JSON.stringify(res.json));
    return { ok: false, error: typeof msg === 'string' ? msg : JSON.stringify(msg) };
  } catch (e) {
    console.error('fast2sms transport error:', e.message);
    return { ok: false, error: e.message };
  }
}

module.exports = { sendOtp, isConfigured, provider: 'fast2sms' };
