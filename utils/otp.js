// utils/otp.js — signup phone verification. WE own the code; the provider only
// delivers it.
//
// This is the piece that was missing with LineVerify: the entire verification
// flow lived inside a vendor's script, so when that script wouldn't load,
// signups stopped and there was nothing to fall back to. Here the provider is a
// single function that takes a string and a number. Everything that decides
// whether an account gets created stays on your server.
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const OtpRequest = require('../models/OtpRequest');

const PROVIDER = String(process.env.PHONE_VERIFICATION_PROVIDER || 'off').toLowerCase();

// ── Tunables (all Railway env vars — these govern spend, so they must be
//    changeable without a deploy) ────────────────────────────────────────────
const CODE_LENGTH      = 6;
const CODE_TTL_MS      = parseInt(process.env.OTP_TTL_MS      || 10 * 60 * 1000, 10); // 10 min
const RESEND_COOLDOWN  = parseInt(process.env.OTP_RESEND_MS   || 60 * 1000, 10);      // 60 s
const MAX_SENDS_PER_HR = parseInt(process.env.OTP_MAX_SENDS   || 3, 10);
const MAX_ATTEMPTS     = parseInt(process.env.OTP_MAX_ATTEMPTS|| 5, 10);
const MAX_IP_PER_HR    = parseInt(process.env.OTP_MAX_IP_HR   || 12, 10);
const DAILY_CAP        = parseInt(process.env.OTP_DAILY_CAP   || 2000, 10);
const WINDOW_MS        = 60 * 60 * 1000;

function isEnabled() {
  return PROVIDER !== 'off' && PROVIDER !== 'false';
}

// Canonical form for storage and comparison. '9876543210', '+91 98765 43210'
// and '919876543210' are the same number, and treating them as different would
// let one person hold three concurrent OTPs and burn three SMS.
function toE164(phone) {
  const s = String(phone || '').trim();
  if (s.startsWith('+')) return s.replace(/\s/g, '');
  const d = s.replace(/\D/g, '');
  if (d.length === 10) return '+91' + d;
  if (d.length === 12 && d.startsWith('91')) return '+' + d;
  return '+' + d;
}
const to10 = (e164) => String(e164).replace(/\D/g, '').slice(-10);

// crypto.randomInt, not Math.random. A predictable OTP is not an OTP — and
// Math.random is seeded per process, so codes would be guessable in bulk by
// anyone who could observe a few of them.
function generateCode() {
  const max = 10 ** CODE_LENGTH;
  return String(crypto.randomInt(0, max)).padStart(CODE_LENGTH, '0');
}

// SHA-256 with a server secret. Not bcrypt: these are 6-digit codes with a
// 10-minute life, verified on a hot path, and bcrypt's cost would add real
// latency to every signup for no meaningful gain at that entropy. The secret is
// what stops a leaked database from being brute-forced offline in seconds.
function hashCode(code, phone) {
  return crypto.createHmac('sha256', process.env.JWT_SECRET || 'otp-fallback')
    .update(`${phone}:${code}`)
    .digest('hex');
}

function getSender() {
  if (PROVIDER === 'fast2sms') return require('./sms/fast2sms');
  // MSG91 slots in here as ./sms/msg91 once your DLT template clears — same
  // two-function shape, so nothing above this line changes.
  return null;
}

// ============================================================================
// ✅ SHARED INTERNAL IMPLEMENTATION — startSignupOtp/verifySignupOtp and
// startPasswordResetOtp/verifyPasswordResetOtp are thin wrappers around these
// two functions, parameterized by `purpose`. This is what makes the two flows
// share the SAME daily cap, per-IP cap, resend-cooldown and attempt-limit
// logic without copy-pasting it — a fix or a tuned limit here covers both
// purposes automatically, and there is only one place this logic can drift.
//
// signup's public behavior is UNCHANGED: startSignupOtp/verifySignupOtp call
// these with purpose='signup', identical to what they did inline before.
// ============================================================================

/**
 * Start (or resend) an OTP for the given purpose ('signup' | 'password_reset').
 * Returns { ok, reason?, message?, resendAfter?, alreadySent? }
 */
async function _startOtp(phoneRaw, ip, purpose) {
  const phone = toE164(phoneRaw);
  const now = Date.now();

  const sender = getSender();
  if (!sender || !sender.isConfigured()) {
    return { ok: false, reason: 'not_configured', message: 'Verification is not configured.' };
  }

  // ── Daily platform ceiling (shared across ALL purposes, deliberately) ────
  const since = new Date(now - 24 * 60 * 60 * 1000);
  const todaySends = await OtpRequest.countDocuments({ createdAt: { $gte: since } });
  if (todaySends >= DAILY_CAP) {
    console.error(`OTP DAILY CAP HIT (${todaySends}/${DAILY_CAP}) — refusing further sends`);
    return { ok: false, reason: 'daily_cap', message: 'Verification is temporarily unavailable. Please try again later.' };
  }

  // ── Per-IP ceiling (also shared across purposes) ─────────────────────────
  if (ip) {
    const ipSends = await OtpRequest.countDocuments({ ip, createdAt: { $gte: new Date(now - WINDOW_MS) } });
    if (ipSends >= MAX_IP_PER_HR) {
      return { ok: false, reason: 'ip_limit', message: 'Too many verification requests. Please try again in an hour.' };
    }
  }

  const existing = await OtpRequest.findOne({ phone, purpose, consumedAt: null })
    .sort({ createdAt: -1 });

  if (existing) {
    // ── Resend cooldown — the cheapest saving available ─────────────────────
    const sinceSent = now - new Date(existing.lastSentAt).getTime();
    if (sinceSent < RESEND_COOLDOWN) {
      return {
        ok: true,
        alreadySent: true,
        resendAfter: Math.ceil((RESEND_COOLDOWN - sinceSent) / 1000),
        message: 'Code already sent. Check your messages.',
      };
    }

    // ── Per-number hourly cap ───────────────────────────────────────────────
    const windowStart = new Date(now - WINDOW_MS);
    if (new Date(existing.createdAt) > windowStart && existing.sends >= MAX_SENDS_PER_HR) {
      return {
        ok: false,
        reason: 'send_limit',
        message: `Too many codes requested for this number. Please try again in an hour.`,
      };
    }
  }

  const code = generateCode();
  const codeHash = hashCode(code, phone);
  const expiresAt = new Date(now + WINDOW_MS); // row lives an hour so the send counter survives

  if (existing) {
    existing.codeHash   = codeHash;
    existing.attempts   = 0;      // new code, fresh attempts
    existing.sends     += 1;
    existing.lastSentAt = new Date(now);
    existing.verifiedAt = null;
    existing.expiresAt  = expiresAt;
    if (ip) existing.ip = ip;
    await existing.save();
  } else {
    await OtpRequest.create({ phone, purpose, codeHash, ip, expiresAt, sends: 1 });
  }

  const sent = await sender.sendOtp(to10(phone), code);
  if (!sent.ok) {
    return { ok: false, reason: 'send_failed', message: 'Could not send the code. Please try again.' };
  }

  return { ok: true, resendAfter: Math.ceil(RESEND_COOLDOWN / 1000) };
}

/**
 * Check a submitted code for the given purpose. On success returns a
 * short-lived signed token proving this phone was verified FOR THAT PURPOSE —
 * `tokenPurpose` is embedded in the JWT so a token minted for signup can never
 * be replayed to verify a password reset, or vice versa (readPhoneToken only
 * accepts 'signup_phone'; readPasswordResetPhoneToken only accepts
 * 'password_reset_phone').
 */
async function _verifyOtp(phoneRaw, code, purpose, tokenPurpose) {
  const phone = toE164(phoneRaw);
  const row = await OtpRequest.findOne({ phone, purpose, consumedAt: null })
    .sort({ createdAt: -1 });

  if (!row) return { ok: false, message: 'No code found. Please request a new one.' };

  if (Date.now() - new Date(row.lastSentAt).getTime() > CODE_TTL_MS) {
    return { ok: false, message: 'Code expired. Please request a new one.' };
  }

  if (row.attempts >= MAX_ATTEMPTS) {
    return { ok: false, message: 'Too many incorrect attempts. Please request a new code.' };
  }

  const supplied = String(code || '').replace(/\D/g, '');
  const expected = row.codeHash;
  const actual = hashCode(supplied, phone);

  // timingSafeEqual, so response time can't be used to narrow the code down.
  const match = supplied.length === CODE_LENGTH &&
    crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));

  if (!match) {
    row.attempts += 1;
    await row.save();
    const left = Math.max(0, MAX_ATTEMPTS - row.attempts);
    return {
      ok: false,
      message: left > 0 ? `Incorrect code. ${left} attempt${left === 1 ? '' : 's'} left.`
                        : 'Too many incorrect attempts. Please request a new code.',
    };
  }

  row.verifiedAt = new Date();
  await row.save();

  const phoneToken = jwt.sign(
    { phone, purpose: tokenPurpose },
    process.env.JWT_SECRET,
    { expiresIn: '15m' }
  );

  return { ok: true, phoneToken };
}

// Burn a row once its purpose's job is done, so the same verification can't be
// replayed. Generic over purpose — consumeSignupOtp below is a thin wrapper.
async function _consumeOtp(phoneRaw, purpose) {
  try {
    await OtpRequest.updateOne(
      { phone: toE164(phoneRaw), purpose, consumedAt: null },
      { $set: { consumedAt: new Date() } }
    );
  } catch (e) {
    console.error(`consumeOtp(${purpose}) failed (non-fatal):`, e.message);
  }
}

// ============================================================================
// PUBLIC API — SIGNUP (unchanged behavior; now thin wrappers over the shared
// internals above instead of duplicating the logic inline)
// ============================================================================

async function startSignupOtp(phoneRaw, ip = '') {
  return _startOtp(phoneRaw, ip, 'signup');
}

async function verifySignupOtp(phoneRaw, code) {
  return _verifyOtp(phoneRaw, code, 'signup', 'signup_phone');
}

/**
 * Called by /register. Returns the verified E.164 number, or null.
 */
function readPhoneToken(token) {
  try {
    const d = jwt.verify(token, process.env.JWT_SECRET);
    if (d.purpose !== 'signup_phone' || !d.phone) return null;
    return d.phone;
  } catch {
    return null;
  }
}

async function consumeSignupOtp(phoneRaw) {
  return _consumeOtp(phoneRaw, 'signup');
}

// ============================================================================
// ✅ PUBLIC API — PASSWORD RESET (new)
//
// Mirrors the signup functions exactly, scoped to purpose='password_reset', so
// it never shares a row, resend-cooldown, or attempt counter with a signup OTP
// on the same number — while still counting against the same daily/IP caps
// (see _startOtp above).
//
// otp.js deliberately does NOT know about the User model or the password-reset
// JWT shape ({id, pwReset, pwHash}) that routes/auth.js's existing, UNCHANGED
// /forgot-reset endpoint expects. This module only proves "this phone answered
// the code sent to it" — readPasswordResetPhoneToken hands the caller back the
// verified phone number, and routes/auth.js is responsible for looking up the
// matching User and minting the actual reset token. Keeping that boundary here
// is what let /forgot-reset stay completely untouched by this feature.
// ============================================================================

async function startPasswordResetOtp(phoneRaw, ip = '') {
  return _startOtp(phoneRaw, ip, 'password_reset');
}

async function verifyPasswordResetOtp(phoneRaw, code) {
  return _verifyOtp(phoneRaw, code, 'password_reset', 'password_reset_phone');
}

/**
 * Called by the forgot-password verify-otp route. Returns the verified E.164
 * number, or null. Mirrors readPhoneToken but scoped to the password-reset
 * token purpose, so the two token types can never be used interchangeably.
 */
function readPasswordResetPhoneToken(token) {
  try {
    const d = jwt.verify(token, process.env.JWT_SECRET);
    if (d.purpose !== 'password_reset_phone' || !d.phone) return null;
    return d.phone;
  } catch {
    return null;
  }
}

async function consumePasswordResetOtp(phoneRaw) {
  return _consumeOtp(phoneRaw, 'password_reset');
}

module.exports = {
  isEnabled,
  provider: PROVIDER,
  toE164,
  // signup (unchanged)
  startSignupOtp,
  verifySignupOtp,
  readPhoneToken,
  consumeSignupOtp,
  // password reset (new)
  startPasswordResetOtp,
  verifyPasswordResetOtp,
  readPasswordResetPhoneToken,
  consumePasswordResetOtp,
  LIMITS: { CODE_LENGTH, CODE_TTL_MS, RESEND_COOLDOWN, MAX_SENDS_PER_HR, MAX_ATTEMPTS, MAX_IP_PER_HR, DAILY_CAP },
};
