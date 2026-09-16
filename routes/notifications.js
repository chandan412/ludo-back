// ============================================================================
// ADMIN PUSH NOTIFICATIONS
//
// Two endpoints: one that says who you could reach, one that sends.
//
// WHY A SEPARATE ROUTE FILE AND NOT routes/admin.js
// admin.js holds add-balance, deduct-balance and process-withdrawal — every
// path that moves real money. Notifications have nothing to do with any of it,
// and keeping them out means a mistake here can never land in a file where a
// mistake costs rupees.
// ============================================================================

const express = require('express');
const router = express.Router();
const User = require('../models/User');
const { adminAuth } = require('../middleware/auth');
const push = require('../utils/push');

// ============================================================================
// AUDIENCES
//
// Each is a Mongo filter, defined once and shared by the count endpoint and the
// send endpoint. That sharing is the point: if the preview said 1,200 players
// and the send used a different filter, the number on screen would be fiction.
//
// Every audience carries `role: 'player'` (never notify admin accounts in a
// broadcast), `isBanned: false` (a banned player should not be invited back)
// and a non-null fcmToken (no token, no reachable device).
// ============================================================================
const BASE = { role: 'player', isBanned: false, fcmToken: { $ne: null } };

const AUDIENCES = {
  all: {
    label: 'Everyone with notifications on',
    filter: () => ({ ...BASE }),
  },
  players: {
    label: 'Played at least one game',
    filter: () => ({ ...BASE, gamesPlayed: { $gte: 1 } }),
  },
  never_played: {
    label: 'Signed up but never played',
    filter: () => ({ ...BASE, gamesPlayed: { $lt: 1 } }),
  },
  has_balance: {
    label: 'Has money in their wallet',
    filter: () => ({ ...BASE, balance: { $gt: 0 } }),
  },
  empty_wallet: {
    label: 'Wallet is empty',
    filter: () => ({ ...BASE, balance: { $lte: 0 } }),
  },
};

// ============================================================================
// GET /api/notifications/admin/stats
//
// What the panel shows BEFORE you write anything: whether push works at all,
// and how many players each audience would actually reach.
//
// The reachable-vs-total gap is the useful number here. If 3,000 players exist
// and 40 are reachable, the problem is that nobody has granted permission —
// and no amount of writing a better message fixes that.
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
        audiences[key] = {
          label: a.label,
          count: await User.countDocuments(a.filter()),
        };
      })
    );

    res.json({
      pushReady: push.isEnabled(),
      pushStatus: push.statusMessage(),
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
// testOnly sends ONLY to the admin making the request, ignoring the audience.
// It exists because a broadcast cannot be recalled: once 3,000 phones have
// buzzed with a typo, the only fix is another notification apologising for the
// first. Send to yourself, look at it on your own phone, then send for real.
// ============================================================================
router.post('/admin/send', adminAuth, async (req, res) => {
  try {
    if (!push.isEnabled()) {
      return res.status(503).json({
        message: 'Push is not configured on the server — no service account key is set.',
        pushStatus: push.statusMessage(),
      });
    }

    const title = String(req.body?.title || '').trim();
    const body = String(req.body?.body || '').trim();
    const url = String(req.body?.url || '/dashboard').trim() || '/dashboard';
    const audience = String(req.body?.audience || 'all');
    const testOnly = Boolean(req.body?.testOnly);

    if (!title) return res.status(400).json({ message: 'Title is required' });
    if (!body) return res.status(400).json({ message: 'Message is required' });

    // Android collapses a notification to roughly two lines. Longer than this
    // and the end is simply not read, so the limit is about being read rather
    // than about the protocol.
    if (title.length > 65) return res.status(400).json({ message: 'Title must be 65 characters or less' });
    if (body.length > 240) return res.status(400).json({ message: 'Message must be 240 characters or less' });

    if (!testOnly && !AUDIENCES[audience]) {
      return res.status(400).json({ message: 'Unknown audience' });
    }

    // ── Gather tokens ────────────────────────────────────────────────────────
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
      recipients = await User.find(AUDIENCES[audience].filter())
        .select('fcmToken')
        .lean();
    }

    const tokens = recipients.map(u => u.fcmToken).filter(Boolean);

    if (tokens.length === 0) {
      return res.status(400).json({
        message: 'Nobody in that audience has notifications turned on, so there is nothing to send.',
        targeted: 0,
      });
    }

    const result = await push.sendToTokens(tokens, { title, body, url });

    // ── Prune dead tokens ────────────────────────────────────────────────────
    // Uninstalled apps and cleared browsers leave tokens behind that can never
    // receive anything. Clearing them keeps every future audience count honest
    // and stops the sender being throttled for repeatedly pushing to nothing.
    //
    // Non-fatal: the send already happened and its result is what the admin
    // needs to see. A failed cleanup is tomorrow's problem, not this response's.
    if (result.deadTokens.length > 0) {
      User.updateMany(
        { fcmToken: { $in: result.deadTokens } },
        { $set: { fcmToken: null } }
      ).catch(e => console.error('token prune failed (non-fatal):', e.message));
    }

    console.log(
      `Push sent by ${req.user.username}: "${title}" → targeted ${tokens.length}, ` +
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

module.exports = router;
