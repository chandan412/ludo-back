const express = require('express');
const router = express.Router();

const User     = require('../models/User');
const Referral = require('../models/Referral');
const { auth, adminAuth } = require('../middleware/auth');
const {
  getReferralSettings,
  saveReferralSettings,
  LIMITS,
} = require('../utils/referral');

// ============================================================================
// GET /api/referral/me — the player's own referral dashboard.
//
// Returns the live RULES alongside the player's PROGRESS, because the rules are
// admin-configurable and can change. Hard-coding "₹50 for every friend" in the
// frontend was fine when it was true forever; now that the admin can move the
// numbers, the UI must read them from here or it will lie to players the first
// time you change anything.
// ============================================================================
router.get('/me', auth, async (req, res) => {
  try {
    const settings = await getReferralSettings();

    const me = await User.findById(req.user._id)
      .select('referralCode referralCount referralEarnings referralRewardCount')
      .lean();
    if (!me) return res.status(404).json({ message: 'Account not found' });

    const rewardsUsed = me.referralRewardCount || 0;
    const rewardsLeft = Math.max(0, settings.maxRewards - rewardsUsed);

    // Newest first, capped — a player with 200 signups doesn't need all of them
    // shipped to a phone on a 3G connection.
    const referrals = await Referral.find({ referrer: req.user._id })
      .sort({ createdAt: -1 })
      .limit(50)
      .populate('referred', 'username createdAt')
      .lean();

    const list = referrals.map(r => ({
      id:       String(r._id),
      username: r.referred?.username || 'Deleted user',
      joinedAt: r.referred?.createdAt || r.createdAt,
      status:   r.status,
      progress: r.qualifyingGames || 0,
      // Grandfathered rows predate the requirement, so showing "0/3" against
      // them would look like a bug. They report as already complete.
      required: r.grandfathered ? 0 : settings.requiredGames,
      reward:   r.rewardAmount || 0,
      grandfathered: !!r.grandfathered,
    }));

    const pendingCount = list.filter(r => r.status === 'pending').length;

    res.json({
      enabled:       settings.enabled,
      code:          me.referralCode || null,
      rewardAmount:  settings.rewardAmount,
      requiredGames: settings.requiredGames,
      maxRewards:    settings.maxRewards,
      rewardsUsed,
      rewardsLeft,
      totalSignups:  me.referralCount || 0,
      totalEarned:   me.referralEarnings || 0,
      pendingCount,
      distinctOpponents: LIMITS.DISTINCT_OPPONENTS,
      referrals: list,
    });
  } catch (err) {
    console.error('referral/me error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================================
// GET /api/referral/config — rules only, no auth.
// Lets the signup page show what entering a code actually does.
// ============================================================================
router.get('/config', async (req, res) => {
  try {
    const s = await getReferralSettings();
    res.json({
      enabled:       s.enabled,
      rewardAmount:  s.rewardAmount,
      requiredGames: s.requiredGames,
      maxRewards:    s.maxRewards,
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================================
// ADMIN — read / write the two numbers that govern the whole system.
// ============================================================================
router.get('/admin/settings', adminAuth, async (req, res) => {
  try {
    const s = await getReferralSettings(true);
    res.json({ ...s, limits: LIMITS });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.put('/admin/settings', adminAuth, async (req, res) => {
  try {
    const { enabled, rewardAmount, requiredGames, maxRewards } = req.body;

    // Validate before writing. These values gate money, and a stray empty
    // string reaching parseInt would land as NaN → 0 → every referral instantly
    // qualifies for nothing, silently.
    const checks = [
      ['rewardAmount',  rewardAmount],
      ['requiredGames', requiredGames],
      ['maxRewards',    maxRewards],
    ];
    for (const [name, val] of checks) {
      if (val === undefined) continue;
      const n = Number(val);
      if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n))
        return res.status(400).json({ message: `${name} must be a whole number of 0 or more` });
      if (n > 100000)
        return res.status(400).json({ message: `${name} is unrealistically large` });
    }

    const updated = await saveReferralSettings({ enabled, rewardAmount, requiredGames, maxRewards });
    res.json({ message: 'Referral settings updated', ...updated });
  } catch (err) {
    console.error('referral settings save error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================================
// ADMIN — referral ledger, paginated and filterable.
// This is the view that tells you whether the fake-account problem is actually
// shrinking: a healthy system has most rows moving pending → rewarded, while a
// farm shows a large pile of 'pending' rows that never progress.
// ============================================================================
router.get('/admin/list', adminAuth, async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page || 1, 10));
    const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit || 25, 10)));
    const status = (req.query.status || '').trim();

    const filter = {};
    if (['pending', 'processing', 'rewarded', 'capped', 'blocked'].includes(status)) {
      filter.status = status;
    }

    const [rows, total] = await Promise.all([
      Referral.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('referrer', 'username phone')
        .populate('referred', 'username phone gamesPlayed createdAt')
        .lean(),
      Referral.countDocuments(filter),
    ]);

    res.json({
      referrals: rows.map(r => ({
        id: String(r._id),
        referrer: r.referrer ? { username: r.referrer.username, phone: r.referrer.phone } : null,
        referred: r.referred ? {
          username: r.referred.username,
          phone: r.referred.phone,
          gamesPlayed: r.referred.gamesPlayed || 0,
        } : null,
        status: r.status,
        qualifyingGames: r.qualifyingGames || 0,
        rewardAmount: r.rewardAmount || 0,
        grandfathered: !!r.grandfathered,
        createdAt: r.createdAt,
        rewardedAt: r.rewardedAt,
      })),
      total,
      page,
      pages: Math.ceil(total / limit) || 1,
    });
  } catch (err) {
    console.error('referral/admin/list error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================================
// ADMIN — summary counters for the settings card.
// ============================================================================
router.get('/admin/stats', adminAuth, async (req, res) => {
  try {
    const rows = await Referral.aggregate([
      { $group: { _id: '$status', count: { $sum: 1 }, paid: { $sum: '$rewardAmount' } } },
    ]);
    const out = { pending: 0, processing: 0, rewarded: 0, capped: 0, blocked: 0, totalPaid: 0 };
    for (const r of rows) {
      if (out[r._id] !== undefined) out[r._id] = r.count;
      if (r._id === 'rewarded') out.totalPaid += r.paid || 0;
    }
    res.json(out);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
