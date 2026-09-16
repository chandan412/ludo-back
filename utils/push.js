// ============================================================================
// PUSH NOTIFICATIONS (Firebase Cloud Messaging)
//
// The sending half of the pipeline. public/firebase-messaging-sw.js already
// handles receiving and displaying; models/User.js now stores the token; this
// is what actually talks to Google.
//
// CREDENTIALS
// firebase-admin needs a service account key (Firebase Console → Project
// Settings → Service Accounts → Generate new private key). Put the whole JSON
// into a Railway variable. Two forms are accepted because Railway's UI mangles
// multi-line values — the base64 form avoids that entirely and is the one to
// prefer:
//
//   FIREBASE_SERVICE_ACCOUNT_BASE64   base64 of the whole JSON file  ← preferred
//   FIREBASE_SERVICE_ACCOUNT          the raw JSON as one line
//
// To produce the base64 form:
//   macOS/Linux:  base64 -i serviceAccount.json | tr -d '\n'
//   Windows PS:   [Convert]::ToBase64String([IO.File]::ReadAllBytes("serviceAccount.json"))
//
// WITHOUT EITHER VARIABLE this module does nothing and reports enabled:false.
// It never throws at require time — a missing key must not stop the server
// booting, because push is the least important thing this backend does and the
// games are the most important.
// ============================================================================

let admin = null;
let messaging = null;
let initError = null;

// require() is inside the try as well: if firebase-admin isn't installed yet
// (deploy order, a rolled-back package.json), the whole server must still boot.
try {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64
    ? Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8')
    : process.env.FIREBASE_SERVICE_ACCOUNT || '';

  if (raw.trim()) {
    admin = require('firebase-admin');
    const creds = JSON.parse(raw);

    // A key pasted through a web form often arrives with the newlines in
    // private_key turned into the two characters \ and n. Left alone, the
    // signature fails with an opaque error that says nothing about newlines.
    if (creds.private_key && creds.private_key.includes('\\n')) {
      creds.private_key = creds.private_key.replace(/\\n/g, '\n');
    }

    if (!admin.apps.length) {
      admin.initializeApp({ credential: admin.credential.cert(creds) });
    }
    messaging = admin.messaging();
    console.log('✅ Push notifications ready (project: ' + (creds.project_id || 'unknown') + ')');
  } else {
    console.log('ℹ️ Push notifications disabled — no FIREBASE_SERVICE_ACCOUNT set');
  }
} catch (e) {
  initError = e.message;
  console.error('❌ Push notifications failed to initialise:', e.message);
}

function isEnabled() {
  return Boolean(messaging);
}

function statusMessage() {
  if (messaging) return 'ready';
  if (initError) return 'error: ' + initError;
  return 'no service account configured';
}

// FCM's hard limit for one sendEachForMulticast call.
const BATCH_SIZE = 500;

// Errors that mean the token is dead — the app was uninstalled, the browser
// data was cleared, the token was rotated. These are pruned from the database
// rather than retried: a store full of dead tokens is how a sender ends up
// rate-limited by FCM, and it makes every "sent to N players" figure a lie.
const DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);

/**
 * Send one notification to many tokens.
 *
 * @returns {{sent:number, failed:number, deadTokens:string[], errors:string[]}}
 *
 * NEVER THROWS. A push failure must not turn an admin action into a 500 — the
 * caller gets counts and decides what to say.
 *
 * NOTE ON sendEachForMulticast: the older sendMulticast() was REMOVED in
 * firebase-admin v13. sendEachForMulticast sends one HTTP/2 request per token
 * under the hood and settles them all, so unlike the old batch endpoint a total
 * failure comes back as a response full of errors rather than a thrown
 * exception. That is why every result is inspected below instead of relying on
 * try/catch alone.
 */
async function sendToTokens(tokens, { title, body, url, icon } = {}) {
  const out = { sent: 0, failed: 0, deadTokens: [], errors: [] };

  if (!messaging) {
    out.errors.push('Push is not configured on the server');
    return out;
  }

  const clean = [...new Set((tokens || []).filter(Boolean).map(String))];
  if (clean.length === 0) return out;

  for (let i = 0; i < clean.length; i += BATCH_SIZE) {
    const batch = clean.slice(i, i + BATCH_SIZE);

    try {
      const res = await messaging.sendEachForMulticast({
        tokens: batch,
        notification: {
          title: String(title || 'Ludo King'),
          body: String(body || ''),
        },
        // Data travels alongside and is what the service worker reads for the
        // click target — see the notificationclick handler in
        // public/firebase-messaging-sw.js, which looks for data.url.
        data: {
          url: String(url || '/dashboard'),
        },
        webpush: {
          notification: {
            icon: icon || '/logo192.png',
            badge: '/logo192.png',
            vibrate: [200, 100, 200],
          },
          fcmOptions: {
            link: String(url || '/dashboard'),
          },
        },
        android: {
          priority: 'high',
        },
      });

      out.sent += res.successCount;
      out.failed += res.failureCount;

      res.responses.forEach((r, idx) => {
        if (r.success) return;
        const code = r.error?.code || '';
        if (DEAD_TOKEN_CODES.has(code)) {
          out.deadTokens.push(batch[idx]);
        } else if (out.errors.length < 5) {
          // Cap the collected errors — 3,000 identical messages help nobody,
          // and the first few are all you need to diagnose.
          out.errors.push(code || r.error?.message || 'unknown error');
        }
      });
    } catch (e) {
      // A whole batch failed before it was even attempted (auth problem,
      // network). Count it and carry on with the next batch rather than
      // abandoning the send.
      out.failed += batch.length;
      if (out.errors.length < 5) out.errors.push(e.message);
      console.error('push batch error:', e.message);
    }
  }

  return out;
}

module.exports = { isEnabled, statusMessage, sendToTokens, BATCH_SIZE };
