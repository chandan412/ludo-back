// routes/cricket.js
const express = require('express');
const router  = express.Router();
const mongoose = require('mongoose');
const https   = require('https');
const { auth, adminAuth } = require('../middleware/auth');
const User        = require('../models/User');
const Transaction = require('../models/Transaction');

// ─── API config ─────────────────────────────
const ODDS_API_KEY = process.env.ODDS_API_KEY || '9c744ddae751677ec1fe811355df33df';
const ODDS_URL = `https://api.the-odds-api.com/v4/sports/cricket/odds?apiKey=${ODDS_API_KEY}&regions=uk&markets=h2h&oddsFormat=decimal`;

// Simple fetch helper using built-in https
function fetchOddsAPI() {
  return new Promise((resolve, reject) => {
    https.get(ODDS_URL, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// ─── CricketMatch schema ─────────────────────
const cricketMatchSchema = new mongoose.Schema({
  // From Odds API
  oddsId:      { type: String, unique: true, required: true },
  sportTitle:  { type: String },
  team1:       { name: String },
  team2:       { name: String },
  startTime:   { type: Date, required: true },
  betCloseTime:{ type: Date, required: true }, // startTime - 30min
  oddsTeam1:   { type: Number, default: 1.9 }, // best odds from bookmakers
  oddsTeam2:   { type: Number, default: 1.9 },

  // Admin managed
  status:      { type: String, enum: ['upcoming','live','result_pending','settled','cancelled'], default: 'upcoming' },
  // tossWinner: 'team1' | 'team2' | null
  tossWinner:  { type: String, default: null },
  adminNote:   { type: String, default: '' },
  lastSynced:  { type: Date, default: Date.now },
  createdAt:   { type: Date, default: Date.now },
});

let CricketMatch;
try { CricketMatch = mongoose.model('CricketMatch'); }
catch { CricketMatch = mongoose.model('CricketMatch', cricketMatchSchema); }

// ─── CricketBet schema ───────────────────────
const cricketBetSchema = new mongoose.Schema({
  user:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  match:      { type: mongoose.Schema.Types.ObjectId, ref: 'CricketMatch', required: true },
  pickedTeam: { type: String, enum: ['team1','team2'], required: true },
  amount:     { type: Number, required: true, min: 10 },
  odds:       { type: Number, default: 1.9 },
  status:     { type: String, enum: ['pending','won','lost','refunded'], default: 'pending' },
  payout:     { type: Number, default: 0 },
  createdAt:  { type: Date, default: Date.now },
  settledAt:  { type: Date },
});

let CricketBet;
try { CricketBet = mongoose.model('CricketBet'); }
catch { CricketBet = mongoose.model('CricketBet', cricketBetSchema); }

// ─── helpers ────────────────────────────────
function isBetOpen(match) {
  return new Date() < new Date(match.betCloseTime)
    && ['upcoming','live'].includes(match.status);
}

// Parse API response → upsert matches into DB
async function syncMatchesFromAPI() {
  const data = await fetchOddsAPI();
  for (const m of data) {
    const start = new Date(m.commence_time);
    const betClose = new Date(start.getTime() - 30 * 60 * 1000); // -30 min

    // Get best h2h odds for each team
    let o1 = 1.9, o2 = 1.9;
    for (const bk of (m.bookmakers || [])) {
      const mkt = (bk.markets || []).find(mk => mk.key === 'h2h');
      if (!mkt) continue;
      for (const out of mkt.outcomes) {
        if (out.name === m.home_team && out.price > o1) o1 = out.price;
        if (out.name === m.away_team && out.price > o2) o2 = out.price;
      }
    }
    // Cap at 1.9x max (our platform limit)
    o1 = Math.min(parseFloat(o1.toFixed(2)), 1.9);
    o2 = Math.min(parseFloat(o2.toFixed(2)), 1.9);

    await CricketMatch.findOneAndUpdate(
      { oddsId: m.id },
      {
        oddsId:    m.id,
        sportTitle: m.sport_title,
        team1:     { name: m.home_team },
        team2:     { name: m.away_team },
        startTime: start,
        betCloseTime: betClose,
        oddsTeam1: o1,
        oddsTeam2: o2,
        lastSynced: new Date(),
        // only set status if not already managed by admin
        $setOnInsert: { status: 'upcoming', tossWinner: null },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  }
}

// Simple cache — sync at most once per 5 min
let lastSync = 0;
async function syncIfStale() {
  if (Date.now() - lastSync > 5 * 60 * 1000) {
    try { await syncMatchesFromAPI(); lastSync = Date.now(); }
    catch (e) { console.error('Odds API sync failed:', e.message); }
  }
}

// ─────────────────────────────────────────────
// GET /api/cricket/matches  — player facing
// ─────────────────────────────────────────────
router.get('/matches', auth, async (req, res) => {
  try {
    await syncIfStale();

    const now = new Date();
    const matches = await CricketMatch.find({
      status: { $in: ['upcoming','live','result_pending'] },
      startTime: { $gte: new Date(now.getTime() - 6 * 60 * 60 * 1000) },
    }).sort({ startTime: 1 });

    const result = matches.map(m => ({
      _id:          m._id,
      oddsId:       m.oddsId,
      sportTitle:   m.sportTitle,
      team1:        m.team1,
      team2:        m.team2,
      startTime:    m.startTime,
      betCloseTime: m.betCloseTime,
      oddsTeam1:    m.oddsTeam1,
      oddsTeam2:    m.oddsTeam2,
      status:       m.status,
      tossWinner:   m.tossWinner,
      betOpen:      isBetOpen(m),
      minutesToClose: Math.max(0, Math.floor((new Date(m.betCloseTime) - now) / 60000)),
    }));

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ─────────────────────────────────────────────
// GET /api/cricket/my-bets
// ─────────────────────────────────────────────
router.get('/my-bets', auth, async (req, res) => {
  try {
    const bets = await CricketBet.find({ user: req.user._id })
      .populate('match', 'sportTitle team1 team2 tossWinner status startTime')
      .sort({ createdAt: -1 })
      .limit(30);
    res.json(bets);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ─────────────────────────────────────────────
// POST /api/cricket/bet  — place a bet
// ─────────────────────────────────────────────
router.post('/bet', auth, async (req, res) => {
  try {
    const { matchId, pickedTeam, amount } = req.body;
    if (!matchId || !pickedTeam || !amount)
      return res.status(400).json({ message: 'matchId, pickedTeam, amount required' });
    if (!['team1','team2'].includes(pickedTeam))
      return res.status(400).json({ message: 'pickedTeam must be team1 or team2' });
    if (amount < 10)
      return res.status(400).json({ message: 'Minimum bet ₹10' });

    const match = await CricketMatch.findById(matchId);
    if (!match)        return res.status(404).json({ message: 'Match not found' });
    if (!isBetOpen(match)) return res.status(400).json({ message: 'Betting is closed for this match' });

    const existing = await CricketBet.findOne({ user: req.user._id, match: matchId, status: 'pending' });
    if (existing) return res.status(400).json({ message: 'You already have a bet on this match' });

    const user = await User.findById(req.user._id);
    const available = user.balance - user.lockedBalance;
    if (available < amount)
      return res.status(400).json({ message: `Insufficient balance. Available: ₹${available}` });

    user.lockedBalance += amount;
    await user.save();

    const usedOdds = pickedTeam === 'team1' ? match.oddsTeam1 : match.oddsTeam2;
    const bet = await CricketBet.create({
      user: req.user._id, match: matchId, pickedTeam, amount, odds: usedOdds,
    });

    await Transaction.create({
      user: req.user._id, type: 'game_lock', amount,
      balanceBefore: user.balance, balanceAfter: user.balance,
      status: 'completed', gameId: bet._id,
    });

    res.status(201).json({ message: 'Bet placed!', bet });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ─────────────────────────────────────────────
// ADMIN: GET /api/cricket/admin/matches
// ─────────────────────────────────────────────
router.get('/admin/matches', adminAuth, async (req, res) => {
  try {
    await syncIfStale();
    const matches = await CricketMatch.find().sort({ startTime: -1 }).limit(60);
    const result = [];
    for (const m of matches) {
      const [totalBets, pendingBets, stakeAgg] = await Promise.all([
        CricketBet.countDocuments({ match: m._id }),
        CricketBet.countDocuments({ match: m._id, status: 'pending' }),
        CricketBet.aggregate([
          { $match: { match: m._id } },
          { $group: { _id: null, total: { $sum: '$amount' } } }
        ]),
      ]);
      result.push({
        ...m.toObject(),
        betOpen: isBetOpen(m),
        minutesToClose: Math.max(0, Math.floor((new Date(m.betCloseTime) - new Date()) / 60000)),
        totalBets,
        pendingBets,
        totalStake: stakeAgg[0]?.total || 0,
      });
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ─────────────────────────────────────────────
// ADMIN: PUT /api/cricket/admin/settle/:id
// Declare toss winner + settle all bets
// Also used to EDIT/CORRECT a wrong decision
// ─────────────────────────────────────────────
router.put('/admin/settle/:id', adminAuth, async (req, res) => {
  try {
    const { tossWinner, adminNote, force } = req.body;
    // tossWinner = 'team1' | 'team2'
    if (!tossWinner) return res.status(400).json({ message: 'tossWinner required' });

    const match = await CricketMatch.findById(req.params.id);
    if (!match) return res.status(404).json({ message: 'Match not found' });

    // If already settled and not forced re-settle, block
    if (match.status === 'settled' && !force)
      return res.status(400).json({
        message: 'Match already settled. Pass force:true to re-settle.',
        alreadySettled: true,
      });

    // If re-settling, reverse previous payouts first
    if (match.status === 'settled' && force) {
      const prevBets = await CricketBet.find({ match: match._id, status: { $in: ['won','lost'] } });
      for (const b of prevBets) {
        const user = await User.findById(b.user);
        if (!user) continue;
        if (b.status === 'won') {
          // Reverse the win — take back the profit
          const profit = b.payout - b.amount;
          user.balance = Math.max(0, user.balance - profit);
          user.lockedBalance += b.amount; // re-lock
        } else {
          // Reverse the loss — give back
          user.balance += b.amount;
          user.lockedBalance += b.amount;
        }
        await user.save();
        b.status = 'pending';
        b.payout = 0;
        b.settledAt = null;
        await b.save();
      }
    }

    // Update match
    match.tossWinner = tossWinner;
    match.status     = 'settled';
    match.adminNote  = adminNote || '';
    await match.save();

    // Settle all pending bets
    const bets = await CricketBet.find({ match: match._id, status: 'pending' });
    let winners = 0, losers = 0;

    for (const bet of bets) {
      const user = await User.findById(bet.user);
      if (!user) continue;

      user.lockedBalance = Math.max(0, user.lockedBalance - bet.amount);

      if (bet.pickedTeam === tossWinner) {
        const payout = Math.floor(bet.amount * bet.odds);
        const profit = payout - bet.amount;
        const balBefore = user.balance;
        user.balance += profit;
        bet.status = 'won';
        bet.payout = payout;
        await Transaction.create({
          user: bet.user, type: 'game_win', amount: profit,
          balanceBefore: balBefore, balanceAfter: user.balance,
          status: 'completed', gameId: bet._id,
        });
        winners++;
      } else {
        const balBefore = user.balance;
        user.balance = Math.max(0, user.balance - bet.amount);
        bet.status = 'lost';
        bet.payout = 0;
        await Transaction.create({
          user: bet.user, type: 'game_loss', amount: bet.amount,
          balanceBefore: balBefore, balanceAfter: user.balance,
          status: 'completed', gameId: bet._id,
        });
        losers++;
      }

      bet.settledAt = new Date();
      await bet.save();
      await user.save();
    }

    res.json({
      message: `Settled ${winners + losers} bets — ${winners} won, ${losers} lost`,
      match,
      winners, losers,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ─────────────────────────────────────────────
// ADMIN: PUT /api/cricket/admin/status/:id
// Change status (upcoming → result_pending etc)
// ─────────────────────────────────────────────
router.put('/admin/status/:id', adminAuth, async (req, res) => {
  try {
    const { status } = req.body;
    const valid = ['upcoming','live','result_pending','cancelled'];
    if (!valid.includes(status))
      return res.status(400).json({ message: 'Invalid status' });

    const match = await CricketMatch.findByIdAndUpdate(
      req.params.id, { status }, { new: true }
    );
    if (!match) return res.status(404).json({ message: 'Match not found' });

    // If cancelling, refund all pending bets
    if (status === 'cancelled') {
      const bets = await CricketBet.find({ match: match._id, status: 'pending' });
      for (const b of bets) {
        const user = await User.findById(b.user);
        if (!user) continue;
        user.lockedBalance = Math.max(0, user.lockedBalance - b.amount);
        await user.save();
        b.status = 'refunded';
        await b.save();
        await Transaction.create({
          user: b.user, type: 'refund', amount: b.amount,
          balanceBefore: user.balance, balanceAfter: user.balance,
          status: 'completed', gameId: b._id,
        });
      }
    }

    res.json({ message: 'Status updated', match });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ADMIN: POST /api/cricket/admin/sync — force refresh from API
router.post('/admin/sync', adminAuth, async (req, res) => {
  try {
    lastSync = 0; // force sync
    await syncIfStale();
    res.json({ message: 'Synced from Odds API' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
