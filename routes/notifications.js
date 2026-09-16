// routes/notifications.js — backend
//
// ============================================================================
// MERGED FILE
//
// The original POST /send is kept BELOW, unchanged, still using ../utils/fcm.
// Anything already calling it keeps working exactly as before.
//
// Added: GET /admin/stats and POST /admin/send, which the admin panel's 🔔
// Notify tab calls. Those two do NOT go through utils/fcm — they talk to
// firebase-admin directly in this file, because they need per-token results to
// report accurate delivered/failed counts and to clear out dead tokens, and
// utils/fcm's helpers don't hand that back.
//
// WHY THE PANEL WAS ERRORING: this router only had /send. A request to
// /api/notifications/admin/stats matched nothing, Express returned its 404 HTML
// page, and the frontend fell back to its generic "Failed to load notification
// stats" message.
// ============================================================================

const express = require('express');
const router  = express.Router();
const { auth, adminAuth } = require('../middleware/auth');
const User = require('../models/User');

// ── utils/fcm, loaded defensively ───────────────────────────────────────────
// Wrapped so a problem inside utils/fcm (a missing package, a bad key) can
// never stop this whole file from loading — which would take the server down
// with it at boot, since server.js requires this at startup. The legacy /send
// route checks for the helpers before using them.
let fcmUtils = {};
try {
  fcmUtils = require('../utils/fcm') || {};
} catch (e) {
  console.error('utils/fcm failed to load (legacy /send disabled):', e.message);
}
const { sendNotification, sendNotificationToAll } = fcmUtils;

// ============================================================================
// FIREBASE ADMIN — for the new admin endpoints
//
// Reads the service account from either env var. Base64 is preferred because
// Railway's UI mangles the newlines inside private_key, which fails later with
// an opaque signature error that says nothing about newlines.
//
//   FIREBASE_SERVICE_ACCOUNT_BASE64   base64 of the whole JSON   ← preferred
//   FIREBASE_SERVICE_ACCOUNT          raw JSON on one line
//
// Everything here is wrapped: a missing or broken key must report itself in the
// panel, never crash the server. Push is the least important thing this backend
// does; the games are the most important.
// ============================================================================
let messaging = null;
let pushError = null;

try {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64
    ? Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8')
    : process.env.FIREBASE_SERVICE_ACCOUNT || '';

  if (raw.trim()) {
    const admin = require('firebase-admin');
    const creds = JSON.parse(raw);

    // A key pasted through a web form often arrives with real newlines turned
    // into the two characters \ and n.
    if (creds.private_key && creds.private_key.includes('\\n')) {
      creds.private_key = creds.private_key.replace(/\\n/g, '\n');
    }

    // Reuse the existing app if utils/fcm already called initializeApp —
    // calling it twice throws.
    if (!admin.apps.length) {
      admin.initializeApp({ credential: admin.credential.cert(creds) });
    }
    messaging = admin.messaging();
    console.log('✅ Push ready (project: ' + (creds.project_id || 'unknown') + ')');
  } else {
    pushError = 'no service account configured';
    console.log('ℹ️ Push disabled — no FIREBASE_SERVICE_ACCOUNT set');
  }
} catch (e) {
  pushError = e.message;
  console.error('❌ Push failed to initialise:', e.message);
}

function pushStatus() {
  if (messaging) return 'ready';
  return pushError || 'not configured';
}

// FCM's hard limit per sendEachForMulticast call.
const BATCH_SIZE = 500;

// Errors meaning the token is dead — app uninstalled, browser data cleared,
// token rotated. Pruned rather than retried: a store full of dead tokens is how
// a sender gets throttled, and it makes every reach figure a lie.
const DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);

// NOTE: sendMulticast() was REMOVED in firebase-admin v13. sendEachForMulticast
// sends one request per token and settles them all, so a total failure comes
// back as a response full of errors rather than a thrown exception — which is
// why every individual result is inspected below.
async function pushToTokens(tokens, { title, body, url }) {
  const out = { sent: 0, failed: 0, deadTokens: [], errors: [] };
  if (!messaging) { out.errors.push('Push is not configured'); return out; }

  const clean = [...new Set((tokens || []).filter(Boolean).map(String))];
  if (clean.length === 0) return out;

  for (let i = 0; i < clean.length; i += BATCH_SIZE) {
    const batch = clean.slice(i, i + BATCH_SIZE);
    try {
      const res = await messaging.sendEachForMulticast({
        tokens: batch,
        notification: { title: String(title), body: String(body) },
        // The service worker's notificationclick handler reads data.url.
        data: { url: String(url || '/dashboard') },
        webpush: {
          notification: {
            icon: '/logo192.png',
            badge: '/logo192.png',
            vibrate: [200, 100, 200],
          },
          fcmOptions: { link: String(url || '/dashboard') },
        },
        android: { priority: 'high' },
      });

      out.sent   += res.successCount;
      out.failed += res.failureCount;

      res.responses.forEach((r, idx) => {
        if (r.success) return;
        const code = r.error?.code || '';
        if (DEAD_TOKEN_CODES.has(code)) out.deadTokens.push(batch[idx]);
        else if (out.errors.length < 5) out.errors.push(code || r.error?.message || 'unknown');
      });
    } catch (e) {
      // One batch died before it was attempted. Count it, carry on with the
      // rest rather than abandoning the whole send.
      out.failed += batch.length;
      if (out.errors.length < 5) out.errors.push(e.message);
      console.error('push batch error:', e.message);
    }
  }
  return out;
}

// ============================================================================
// AUDIENCES
//
// Defined once and shared by the stats endpoint and the send endpoint. That
// sharing is the point: if the panel previewed 1,200 players and the send used
// a different filter, the number on screen would be fiction.
//
// Every audience excludes admins, banned accounts, and anyone without a token.
// ============================================================================
const BASE = { role: 'player', isBanned: false, fcmToken: { $ne: null } };

const AUDIENCES = {
  all:          { label: 'Everyone with notifications on', filter: () => ({ ...BASE }) },
  players:      { label: 'Played at least one game',       filter: () => ({ ...BASE, gamesPlayed: { $gte: 1 } }) },
  never_played: { label: 'Signed up but never played',     filter: () => ({ ...BASE, gamesPlayed: { $lt: 1 } }) },
  has_balance:  { label: 'Has money in their wallet',      filter: () => ({ ...BASE, balance: { $gt: 0 } }) },
  empty_wallet: { label: 'Wallet is empty',                filter: () => ({ ...BASE, balance: { $lte: 0 } }) },
};

// ============================================================================
// GET /api/notifications/admin/stats
//
// What the panel shows before you write anything. Returns 200 even when push is
// unconfigured — pushReady:false is information the admin needs, not an error.
// ============================================================================
router.get('/admin/stats', adminAuth, async (req, res) => {
  try {
    const [totalPlayers, withToken] = await Promise.all([
      User.countDocuments({ role: 'player', isBanned: false }),
      User.countDocuments(BASE),
    ]);

    const audiences = {};
    await Promise.all(
      Object.entries(AUDIENCES).map(async ([key, a]) => {
        audiences[key] = { label: a.label, count: await User.countDocuments(a.filter()) };
      })
    );

    res.json({
      pushReady: Boolean(messaging),
      pushStatus: pushStatus(),
      totalPlayers,
      withToken,
      audiences,
    });
  } catch (err) {
    console.error('notification stats error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================================
// POST /api/notifications/admin/send
//
// Body: { title, body, url, audience, testOnly }
//
// testOnly sends only to the admin making the request and ignores the audience.
// It exists because a broadcast cannot be recalled: once every phone has buzzed
// with a typo, the only remedy is a second notification apologising for the
// first.
// ============================================================================
router.post('/admin/send', adminAuth, async (req, res) => {
  try {
    if (!messaging) {
      return res.status(503).json({
        message: 'Push is not configured on the server — no service account key is set.',
        pushStatus: pushStatus(),
      });
    }

    const title    = String(req.body?.title || '').trim();
    const body     = String(req.body?.body  || '').trim();
    const url      = String(req.body?.url   || '/dashboard').trim() || '/dashboard';
    const audience = String(req.body?.audience || 'all');
    const testOnly = Boolean(req.body?.testOnly);

    if (!title) return res.status(400).json({ message: 'Title is required' });
    if (!body)  return res.status(400).json({ message: 'Message is required' });

    // Android collapses a notification to roughly two lines. These limits are
    // about being read, not about the protocol.
    if (title.length > 65)  return res.status(400).json({ message: 'Title must be 65 characters or less' });
    if (body.length  > 240) return res.status(400).json({ message: 'Message must be 240 characters or less' });

    if (!testOnly && !AUDIENCES[audience]) {
      return res.status(400).json({ message: 'Unknown audience' });
    }

    let recipients;
    if (testOnly) {
      const me = await User.findById(req.user._id).select('fcmToken username').lean();
      if (!me?.fcmToken) {
        return res.status(400).json({
          message: 'Your own admin account has no notification token. Open the site in Chrome, allow notifications, then try the test again.',
        });
      }
      recipients = [me];
    } else {
      // Only the token field — the audience can be thousands of users and
      // nothing else on the document is needed to send.
      recipients = await User.find(AUDIENCES[audience].filter()).select('fcmToken').lean();
    }

    const tokens = recipients.map(u => u.fcmToken).filter(Boolean);

    if (tokens.length === 0) {
      return res.status(400).json({
        message: 'Nobody in that audience has notifications turned on, so there is nothing to send.',
        targeted: 0,
      });
    }

    const result = await pushToTokens(tokens, { title, body, url });

    // Clear dead tokens so future reach figures stay honest. Non-fatal: the
    // send already happened, and a failed cleanup is tomorrow's problem.
    if (result.deadTokens.length > 0) {
      User.updateMany(
        { fcmToken: { $in: result.deadTokens } },
        { $set: { fcmToken: null } }
      ).catch(e => console.error('token prune failed (non-fatal):', e.message));
    }

    console.log(
      `Push by ${req.user.username}: "${title}" → targeted ${tokens.length}, ` +
      `delivered ${result.sent}, failed ${result.failed}, pruned ${result.deadTokens.length}`
    );

    res.json({
      message: testOnly
        ? 'Test notification sent to your device'
        : `Sent to ${result.sent} of ${tokens.length}`,
      testOnly,
      targeted: tokens.length,
      sent: result.sent,
      failed: result.failed,
      pruned: result.deadTokens.length,
      errors: result.errors,
    });
  } catch (err) {
    console.error('notification send error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================================
// POST /api/notifications/send — ORIGINAL ROUTE, UNCHANGED
//
// Kept exactly as it was so anything already calling it keeps working. The only
// addition is a guard for the case where utils/fcm failed to load above.
// ============================================================================
router.post('/send', adminAuth, async (req, res) => {
  try {
    if (!sendNotification || !sendNotificationToAll) {
      return res.status(503).json({ message: 'Notification helper unavailable' });
    }

    const { title, body, userId, url } = req.body;
    if (!title || !body) return res.status(400).json({ message: 'Title and body required' });

    if (userId) {
      // Send to specific user
      const user = await User.findById(userId);
      if (!user?.fcmToken) return res.status(400).json({ message: 'User has no notification token' });
      await sendNotification(user.fcmToken, title, body, { url: url || '/dashboard' });
      res.json({ message: `Notification sent to ${user.username}` });
    } else {
      // Send to ALL players
      const users = await User.find({ fcmToken: { $exists: true, $ne: null }, role: 'player' });
      if (users.length === 0) return res.status(400).json({ message: 'No players with notifications enabled' });

      const tokens = users.map(u => u.fcmToken);
      await sendNotificationToAll(tokens, title, body, { url: url || '/dashboard' });
      res.json({ message: `Notification sent to ${users.length} players` });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to send notification' });
  }
});

module.exports = router;
