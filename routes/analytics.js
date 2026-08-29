const express = require('express');
const router = express.Router();
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const Game = require('../models/Game');
const { adminAuth } = require('../middleware/auth');

// ============================================================================
// ✅ DAILY SUMMARY — one day's numbers, against the day before.
//
// READ-ONLY. This file never writes to any collection. It exists in its own
// route rather than inside routes/admin.js so that a reporting feature can
// never touch the file that moves money.
//
// ── WHY THE TIMEZONE MATTERS MORE THAN IT LOOKS ─────────────────────────────
// Railway runs in UTC. A naive "today" would therefore start at 05:30 IST and
// end at 05:30 the next morning — so every evening's deposits, which is when
// your players are actually playing, would land in the WRONG day. The numbers
// would look plausible and be quietly wrong, which is the worst kind of wrong
// for a figure you're using to make decisions.
//
// So the day boundaries are computed in IST explicitly: IST midnight is UTC
// 18:30 the previous day.
// ============================================================================

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

// Today's calendar date in IST, as 'YYYY-MM-DD'.
function istToday() {
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

// The UTC instants that bound an IST calendar day.
function istDayRange(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0) - IST_OFFSET_MS);
  const end   = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

function shiftDate(dateStr, days) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}

// ============================================================================
// Growth as a percentage, with the zero case handled explicitly.
//
// (today - prev) / prev blows up when prev is 0: JavaScript returns Infinity,
// which serialises to null in JSON and renders as "null%" or "Infinity%" on
// screen. Returning null and letting the UI say "first activity" is honest —
// there is genuinely no percentage to quote when yesterday was zero.
// ============================================================================
function growth(today, prev) {
  if (prev === 0) return today === 0 ? 0 : null;   // null = "no basis to compare"
  return Number((((today - prev) / prev) * 100).toFixed(1));
}

const PAID = ['approved', 'completed'];

router.get('/daily-summary', adminAuth, async (req, res) => {
  try {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '')
      ? req.query.date
      : istToday();
    const prevDate = shiftDate(date, -1);

    const cur  = istDayRange(date);
    const prev = istDayRange(prevDate);

    // ── ONE aggregation covering BOTH days ───────────────────────────────────
    // Bucketing by day inside the pipeline rather than running the whole thing
    // twice halves the database work, and it uses the existing
    // { type, createdAt } index on Transaction.
    const txRows = await Transaction.aggregate([
      {
        $match: {
          createdAt: { $gte: prev.start, $lt: cur.end },
          type: { $in: ['recharge', 'withdraw', 'platform_fee', 'referral', 'signup_bonus'] },
        },
      },
      {
        $group: {
          _id: {
            day:    { $cond: [{ $gte: ['$createdAt', cur.start] }, 'cur', 'prev'] },
            type:   '$type',
            status: '$status',
          },
          total: { $sum: '$amount' },
          count: { $sum: 1 },
        },
      },
    ]);

    const blank = () => ({
      deposits: 0, depositCount: 0,
      withdrawals: 0, withdrawCount: 0,
      platformFees: 0,
      bonusesGiven: 0,
      newPlayers: 0,
      gamesPlayed: 0,
    });
    const out = { cur: blank(), prev: blank() };

    for (const r of txRows) {
      const bucket = out[r._id.day];
      if (!bucket) continue;
      const { type, status } = r._id;

      if (type === 'recharge' && PAID.includes(status)) {
        bucket.deposits += r.total;
        bucket.depositCount += r.count;
      } else if (type === 'withdraw' && PAID.includes(status)) {
        // Only withdrawals you actually PAID. Pending ones haven't left yet and
        // rejected/cancelled ones never will — counting them would overstate
        // what went out the door.
        bucket.withdrawals += r.total;
        bucket.withdrawCount += r.count;
      } else if (type === 'platform_fee' && status === 'completed') {
        bucket.platformFees += r.total;
      } else if ((type === 'referral' || type === 'signup_bonus') && status === 'completed') {
        bucket.bonusesGiven += r.total;
      }
    }

    // ── Signups and finished games ───────────────────────────────────────────
    // NOTE: the User query filters on createdAt, which has no index. Fine at
    // your current size; if the players collection grows into six figures, add
    // `userSchema.index({ createdAt: -1 })` and this stays instant.
    const [curPlayers, prevPlayers, curGames, prevGames] = await Promise.all([
      User.countDocuments({ role: 'player', createdAt: { $gte: cur.start,  $lt: cur.end } }),
      User.countDocuments({ role: 'player', createdAt: { $gte: prev.start, $lt: prev.end } }),
      Game.countDocuments({ status: 'finished', finishedAt: { $gte: cur.start,  $lt: cur.end } }),
      Game.countDocuments({ status: 'finished', finishedAt: { $gte: prev.start, $lt: prev.end } }),
    ]);

    out.cur.newPlayers   = curPlayers;
    out.prev.newPlayers  = prevPlayers;
    out.cur.gamesPlayed  = curGames;
    out.prev.gamesPlayed = prevGames;

    // Net flow = money in minus money out. The single number that says whether
    // the day put cash into the business or took it out.
    out.cur.netFlow  = out.cur.deposits  - out.cur.withdrawals;
    out.prev.netFlow = out.prev.deposits - out.prev.withdrawals;

    const keys = [
      'deposits', 'depositCount', 'withdrawals', 'withdrawCount',
      'platformFees', 'bonusesGiven', 'newPlayers', 'gamesPlayed', 'netFlow',
    ];
    const growthOut = {};
    for (const k of keys) growthOut[k] = growth(out.cur[k], out.prev[k]);

    res.json({
      date,
      prevDate,
      timezone: 'Asia/Kolkata (IST)',
      today: out.cur,
      previous: out.prev,
      growth: growthOut,
    });
  } catch (err) {
    console.error('daily-summary error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================================
// GET /api/analytics/recent-days?days=7
// A short trend so a single bad or good day can be read in context — one
// unusually big withdrawal makes a day look alarming until you see the week.
// ============================================================================
router.get('/recent-days', adminAuth, async (req, res) => {
  try {
    const days = Math.min(30, Math.max(2, parseInt(req.query.days || 7, 10)));
    const end  = istDayRange(istToday()).end;
    const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);

    const rows = await Transaction.aggregate([
      {
        $match: {
          createdAt: { $gte: start, $lt: end },
          type: { $in: ['recharge', 'withdraw', 'platform_fee'] },
          status: { $in: PAID },
        },
      },
      {
        $group: {
          _id: {
            // Bucket by IST calendar day by shifting the timestamp before
            // formatting — same reasoning as the day boundaries above.
            day: { $dateToString: { format: '%Y-%m-%d', date: { $add: ['$createdAt', IST_OFFSET_MS] } } },
            type: '$type',
          },
          total: { $sum: '$amount' },
        },
      },
    ]);

    const byDay = {};
    for (const r of rows) {
      const d = r._id.day;
      byDay[d] = byDay[d] || { date: d, deposits: 0, withdrawals: 0, platformFees: 0 };
      if (r._id.type === 'recharge')     byDay[d].deposits += r.total;
      if (r._id.type === 'withdraw')     byDay[d].withdrawals += r.total;
      if (r._id.type === 'platform_fee') byDay[d].platformFees += r.total;
    }

    // Fill missing days with zeroes so the list has no gaps to misread.
    const series = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = shiftDate(istToday(), -i);
      series.push(byDay[d] || { date: d, deposits: 0, withdrawals: 0, platformFees: 0 });
    }

    res.json({ days, series });
  } catch (err) {
    console.error('recent-days error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
