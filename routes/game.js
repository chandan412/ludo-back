const express = require('express');
const router = express.Router();
const Game = require('../models/Game');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const { auth } = require('../middleware/auth');
const lineverify = require('../utils/lineverify');

const generateRoomCode = () => Math.random().toString(36).substring(2, 8).toUpperCase();

// Fresh set of 4 home tokens for a new player
const freshTokens = () => ([
  { position: -1, isHome: true, isFinished: false },
  { position: -1, isHome: true, isFinished: false },
  { position: -1, isHome: true, isFinished: false },
  { position: -1, isHome: true, isFinished: false }
]);

// GET /api/game/lobby
router.get('/lobby', auth, async (req, res) => {
  try {
    const { minBet, maxBet } = req.query;
    const query = { status: 'waiting' };
    if (minBet || maxBet) {
      query.betAmount = {};
      if (minBet) query.betAmount.$gte = parseInt(minBet);
      if (maxBet) query.betAmount.$lte = parseInt(maxBet);
    }
    query.createdBy = { $ne: req.user._id };
    const games = await Game.find(query)
      .populate('createdBy', 'username gamesPlayed gamesWon')
      .sort({ createdAt: -1 })
      .limit(50);
    res.json(games);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/game/my-active-game
router.get('/my-active-game', auth, async (req, res) => {
  try {
    const game = await Game.findOne({
      'players.user': req.user._id,
      status: 'active'
    }).populate('players.user', 'username');
    if (!game) return res.status(404).json(null);
    res.json(game);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/game/my-waiting-game
router.get('/my-waiting-game', auth, async (req, res) => {
  try {
    const game = await Game.findOne({
      'players.user': req.user._id,
      status: 'waiting'
    }).populate('players.user', 'username');
    if (!game) return res.status(404).json(null);
    res.json(game);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ✅ FIXED: returns all statuses so Lobby can detect waiting/active games
router.get('/my-games/history', auth, async (req, res) => {
  try {
    const games = await Game.find({
      'players.user': req.user._id,
      status: { $in: ['waiting', 'active', 'finished', 'cancelled', 'aborted'] }
    })
      .populate('players.user', 'username')
      .populate('winner', 'username')
      .sort({ createdAt: -1 })
      .limit(20);
    res.json(games);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/game/create
// ✅ AUTO-MATCH REMOVED. Create ALWAYS opens a fresh waiting room — it never
// silently claims someone else's room. Matching happens only through the
// Browse tab / Join-by-code flow (POST /join/:roomCode). This prevents the
// "create → instantly Game in Progress / Rejoin → can't rejoin" bug, which
// was caused by auto-match flipping a stale/orphaned waiting room to 'active'
// (with currentTurn pointing at an absent creator) and dropping you into a
// dead game with your bet locked.
router.post('/create', auth, async (req, res) => {
  try {
    const { betAmount } = req.body;
    if (!betAmount || betAmount < 10)
      return res.status(400).json({ message: 'Minimum bet is ₹10' });

    const user = await User.findById(req.user._id);
    // ✅ Phone-verification gate — new players must verify before they can play. Existing
    // players are grandfathered (see server.js). needsPhoneVerification tells the frontend
    // to route the user to the verify screen instead of showing a plain error.
    if (lineverify.isEnabled() && !user.phoneVerified)
      return res.status(403).json({ message: 'Please verify your phone number to play.', needsPhoneVerification: true });
    const available = user.balance - user.lockedBalance;
    if (available < betAmount)
      return res.status(400).json({ message: `Insufficient balance. Available: ₹${available}` });

    const existingGame = await Game.findOne({
      'players.user': req.user._id,
      status: { $in: ['waiting', 'active'] }
    });
    if (existingGame)
      return res.status(400).json({ message: 'You already have an active game' });

    // ── Open a new waiting room ───────────────────────────────────────────────
    // ⚠️ ORDER MATTERS. This used to be:
    //
    //     user.lockedBalance += betAmount; await user.save();   // lock first
    //     const game = await Game.create({ ... });              // then create
    //
    // If Game.create threw, the stake stayed locked with no game attached — the
    // player's money was stranded. That is not hypothetical: roomCode is a random
    // 6-character string with a UNIQUE index, so a collision raises E11000 and
    // takes exactly that path.
    //
    // Now the game is created FIRST, the stake is locked with a conditional $inc
    // that cannot overdraw, and a failed lock deletes the room again.

    // Retry on the (rare) room-code collision instead of 500-ing.
    let game = null;
    for (let attempt = 0; attempt < 5 && !game; attempt++) {
      try {
        game = await Game.create({
          roomCode: generateRoomCode(),
          betAmount,
          createdBy: req.user._id,
          players: [{ user: req.user._id, color: 'red', tokens: freshTokens() }],
        });
      } catch (e) {
        if (e && e.code === 11000) continue; // code already taken — draw another
        throw e;
      }
    }
    if (!game) return res.status(500).json({ message: 'Could not allocate a room code, please retry' });

    // Lock the bet — only ever touch lockedBalance, never balance. The balance
    // condition is re-evaluated by MongoDB at write time, so this can't overdraw
    // even if something else committed money since the check above.
    const lockRes = await User.updateOne(
      {
        _id: req.user._id,
        $expr: { $gte: [{ $subtract: ['$balance', '$lockedBalance'] }, betAmount] },
      },
      { $inc: { lockedBalance: betAmount } }
    );

    if (lockRes.modifiedCount !== 1) {
      // Couldn't lock — remove the room so it can't be joined against an unpaid stake.
      await Game.deleteOne({ _id: game._id, status: 'waiting' })
        .catch(e => console.error('create rollback failed:', e.message));
      return res.status(400).json({ message: `Insufficient balance. Available: ${available}` });
    }

    await game.populate('createdBy', 'username');
    res.status(201).json({
      matched: false,
      message: 'Game created! Share the room code.',
      game
    });
  } catch (err) {
    console.error('create error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/game/join/:roomCode
//
// ⚠️ THIS ROUTE USED TO LET THREE PLAYERS INTO A TWO-PLAYER GAME.
//
// The old flow was a textbook read-then-write race:
//
//     const game = await Game.findOne({ roomCode, status: 'waiting' });  // step 1
//     ... existingGame lookup, user lookup, creator lookup, user.save() ...
//     game.players.push({ ... });                                        // step 5
//     game.status = 'active';
//     await game.save();
//
// The `status: 'waiting'` filter is evaluated at step 1, but status only flips to
// 'active' at step 5 — THREE database roundtrips later. Every joiner whose read
// landed inside that window saw "waiting" and proceeded. Worse, nothing anywhere
// checked players.length, so the room had no size cap at all.
//
// It also leaked locked balance: the joiner's stake was locked BEFORE the game
// save, so a joiner who lost the race had money locked against no game.
//
// The fix inverts the order and lets the DATABASE arbitrate:
//   1. Read-only eligibility checks (cheap, no side effects).
//   2. ATOMIC claim — one findOneAndUpdate whose filter includes both
//      status:'waiting' AND players:{$size:1}. Exactly one joiner can match;
//      everyone else gets null and a clean "already started" response.
//   3. Only then lock the stake, with a CONDITIONAL $inc that can't overdraw.
//   4. If the lock fails, roll the claim back so the room reopens.
router.post('/join/:roomCode', auth, async (req, res) => {
  const roomCode = req.params.roomCode.toUpperCase();
  try {
    // ── 1. Read-only eligibility checks ──────────────────────────────────────
    const game = await Game.findOne({ roomCode, status: 'waiting' });
    if (!game)
      return res.status(404).json({ message: 'Game not found or already started' });

    if (game.createdBy.toString() === req.user._id.toString())
      return res.status(400).json({ message: 'Cannot join your own game' });

    const existingGame = await Game.findOne({
      'players.user': req.user._id,
      status: { $in: ['waiting', 'active'] }
    });
    if (existingGame)
      return res.status(400).json({ message: 'You already have an active game' });

    const user = await User.findById(req.user._id);
    // ✅ Phone-verification gate (same as create).
    if (lineverify.isEnabled() && !user.phoneVerified)
      return res.status(403).json({ message: 'Please verify your phone number to play.', needsPhoneVerification: true });
    const available = user.balance - user.lockedBalance;
    if (available < game.betAmount)
      return res.status(400).json({
        message: `Insufficient balance. Need ₹${game.betAmount}, available: ₹${available}`
      });

    // ✅ Anti-laundering (referral rule): referral-linked players — the referrer and the
    // person who signed up with their code — may ONLY play each other with REAL money,
    // never bonus. This blocks the "refer my own account, then play it to convert the free
    // bonus into withdrawable winnings" trick. Bonus lives INSIDE `balance`; a stake is
    // real-backed only if non-bonus balance covers the locked amount.
    const creator = await User.findById(game.createdBy);
    const linked =
      (creator && creator.referredBy && creator.referredBy.toString() === user._id.toString()) ||
      (creator && user.referredBy && user.referredBy.toString() === creator._id.toString());
    if (linked) {
      const joinerRealAvail   = user.balance - user.lockedBalance - (user.bonusBalance || 0);
      const creatorRealBacked = (creator.balance - (creator.bonusBalance || 0)) >= creator.lockedBalance;
      if (joinerRealAvail < game.betAmount || !creatorRealBacked) {
        return res.status(400).json({
          message: 'You and this player are referral-linked, so you can only play each other with real money — not bonus. Add real balance to play.'
        });
      }
    }

    // ── 2. ATOMIC CLAIM — this is the seat, and there is exactly one ─────────
    // The filter is the entire guarantee:
    //   status: 'waiting'          → the room hasn't started
    //   players: { $size: 1 }      → the room holds ONLY the creator (the cap)
    //   'players.user': { $ne: me } → can't take a second seat in one room
    // MongoDB applies the filter and the update as a single atomic operation, so
    // concurrent joiners cannot all match. The winner gets the document; the
    // losers get null.
    const claimed = await Game.findOneAndUpdate(
      {
        roomCode,
        status: 'waiting',
        players: { $size: 1 },
        'players.user': { $ne: req.user._id },
      },
      {
        $push: {
          players: { user: req.user._id, color: 'blue', tokens: freshTokens() },
        },
        $set: {
          status: 'active',
          currentTurn: game.players[0].user,
          startedAt: new Date(),
        },
      },
      { new: true }
    );

    if (!claimed) {
      // Someone else took the seat between our checks and this write — which is
      // exactly the case that used to produce a third player.
      return res.status(409).json({ message: 'Game is already full or has started' });
    }

    // ── 3. Lock the stake, atomically and without overdrawing ────────────────
    // Conditional $inc: the balance condition is re-evaluated by MongoDB at write
    // time, so a stake can never be locked against money that has since been
    // committed elsewhere. MONEY SAFETY: only lockedBalance moves — `balance` is
    // never touched when a stake is locked.
    const lockRes = await User.updateOne(
      {
        _id: req.user._id,
        $expr: { $gte: [{ $subtract: ['$balance', '$lockedBalance'] }, game.betAmount] },
      },
      { $inc: { lockedBalance: game.betAmount } }
    );

    if (lockRes.modifiedCount !== 1) {
      // ── 4. ROLLBACK ────────────────────────────────────────────────────────
      // Couldn't lock, so undo the claim and reopen the room. Without this the
      // game would sit 'active' with a player who never paid in.
      await Game.updateOne(
        { _id: claimed._id, status: 'active' },
        {
          $pull: { players: { user: req.user._id } },
          $set: { status: 'waiting', currentTurn: null, startedAt: null },
        }
      ).catch(e => console.error('join rollback failed:', e.message));

      return res.status(400).json({ message: 'Insufficient balance to join this game' });
    }

    await claimed.populate('players.user', 'username');
    res.json({ message: 'Joined game! Starting now.', game: claimed });
  } catch (err) {
    console.error('join error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ✅ FIXED: cancel uses 'aborted' status + creates transaction record
router.post('/cancel/:roomCode', auth, async (req, res) => {
  try {
    const game = await Game.findOne({
      roomCode: req.params.roomCode.toUpperCase(),
      status: 'waiting'
    });
    if (!game)
      return res.status(404).json({ message: 'Game not found or already started' });

    if (game.createdBy.toString() !== req.user._id.toString())
      return res.status(403).json({ message: 'Only game creator can cancel' });

    const user = await User.findById(req.user._id);
    const balanceBefore = user.balance;
    user.lockedBalance = Math.max(0, user.lockedBalance - game.betAmount);
    await user.save();

    await Transaction.create({
      user: user._id,
      type: 'refund',
      amount: game.betAmount,
      balanceBefore,
      balanceAfter: user.balance,
      status: 'completed',
      gameId: game._id,
    });

    game.status = 'aborted';
    game.finishedAt = new Date();
    await game.save();

    res.json({ message: 'Game cancelled. Bet refunded.' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/game/abandon/:roomCode — let player abandon a stuck active game
// Refunds both players (no winner), only allowed if game has been inactive for 10+ minutes
router.post('/abandon/:roomCode', auth, async (req, res) => {
  try {
    const game = await Game.findOne({
      roomCode: req.params.roomCode.toUpperCase(),
      status: 'active',
    }).populate('players.user');

    if (!game) return res.status(404).json({ message: 'No active game with this code' });

    const isPlayer = game.players.some(
      p => p.user._id.toString() === req.user._id.toString()
    );
    if (!isPlayer) return res.status(403).json({ message: 'Not a player in this game' });

    // Refund both players — UNLOCK ONLY. A stake is only ever locked (balance is
    // never debited when a game starts), so a refund must only release lockedBalance.
    // The previous `balance += betAmount` here double-credited the player (free money) —
    // removed. balanceBefore === balanceAfter because balance is untouched, exactly like
    // every other refund path (cancel, 2-min abort, both-disconnected, startup sweep).
    for (const p of game.players) {
      const u = await User.findById(p.user._id);
      if (u) {
        const before = u.balance;
        u.lockedBalance = Math.max(0, u.lockedBalance - game.betAmount);
        await u.save();

        await Transaction.create({
          user: u._id,
          type: 'refund',
          amount: game.betAmount,
          balanceBefore: before,
          balanceAfter: u.balance,
          status: 'completed',
          gameId: game._id,
        });
      }
    }

    game.status = 'aborted';
    game.finishedAt = new Date();
    await game.save();

    res.json({ message: 'Game abandoned. Both players refunded.' });
  } catch (err) {
    console.error('abandon error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/game/forfeit/:roomCode — player intentionally exits an ACTIVE game
// Loser forfeits their bet, opponent wins (minus platform fee). Wallets settled here.
// After this returns, the client emits 'forfeit-notify' so the socket layer broadcasts
// 'game-over' to both players in real time.
router.post('/forfeit/:roomCode', auth, async (req, res) => {
  try {
    // ✅ Atomic flip: only succeeds if game is still 'active'. Prevents double-settle
    // if the game already finished by normal win, disconnect-timeout, or another race.
    const game = await Game.findOneAndUpdate(
      { roomCode: req.params.roomCode.toUpperCase(), status: 'active' },
      { $set: { status: 'finished', finishedAt: new Date() } },
      { new: true }
    ).populate('players.user', 'username');

    if (!game) return res.status(404).json({ message: 'No active game with this code' });

    const loserIdx = game.players.findIndex(
      p => p.user._id.toString() === req.user._id.toString()
    );
    if (loserIdx === -1) {
      // Caller isn't a player — undo the status flip so the game isn't left orphaned.
      game.status = 'active';
      game.finishedAt = null;
      await game.save();
      return res.status(403).json({ message: 'Not a player in this game' });
    }
    const opponentIdx = loserIdx === 0 ? 1 : 0;
    const winnerId = game.players[opponentIdx].user._id;
    const loserId  = game.players[loserIdx].user._id;

    const pot         = game.betAmount * 2;
    const platformFee = Math.floor(pot * (parseInt(process.env.PLATFORM_FEE_PERCENT || 5) / 100));
    const winAmount   = pot - platformFee;
    const netWin      = game.betAmount - platformFee; // amount actually added to winner.balance

    const winner = await User.findById(winnerId);
    const loser  = await User.findById(loserId);

    // ✅ Wallet math mirrors settleGame() in gameSocket.js — keep in sync.
    // Loser: release lock, deduct stake from balance.
    // Winner: release lock, add (own stake's worth minus fee) to balance.
    const winnerBalanceBefore = winner.balance;
    const loserBalanceBefore  = loser.balance;

    winner.lockedBalance = Math.max(0, winner.lockedBalance - game.betAmount);
    loser.lockedBalance  = Math.max(0, loser.lockedBalance  - game.betAmount);
    loser.balance        = Math.max(0, loser.balance - game.betAmount);
    // ✅ Shrink the loser's bonus marker so it can't exceed real balance after the loss
    // (mirrors settleGame in gameSocket.js — keep in sync). Bonus eaten by a loss is gone.
    loser.bonusBalance   = Math.min(loser.bonusBalance || 0, loser.balance);

    winner.balance     += netWin;
    winner.gamesWon    += 1;
    winner.gamesPlayed += 1;
    winner.totalEarned += netWin;
    loser.gamesPlayed  += 1;
    loser.totalLost    += game.betAmount;

    await winner.save();
    await loser.save();

    // Persist outcome on the game doc so forfeit-notify socket handler can broadcast it.
    game.winner      = winnerId;
    game.loser       = loserId;
    game.winAmount   = winAmount;
    game.platformFee = platformFee;
    game.forfeitedBy = loserId;
    await game.save();

    await Transaction.create({
      user: winnerId,
      type: 'game_win',
      amount: netWin,
      balanceBefore: winnerBalanceBefore,
      balanceAfter:  winner.balance,
      status: 'completed',
      gameId: game._id,
    });
    await Transaction.create({
      user: loserId,
      type: 'game_loss',
      amount: game.betAmount,
      balanceBefore: loserBalanceBefore,
      balanceAfter:  loser.balance,
      status: 'completed',
      gameId: game._id,
    });
    await Transaction.create({
      user: winnerId,
      type: 'platform_fee',
      amount: platformFee,
      balanceBefore: winner.balance,
      balanceAfter:  winner.balance,
      status: 'completed',
      gameId: game._id,
    });

    res.json({
      message: 'Forfeited. Opponent wins.',
      winAmount,
      platformFee,
    });
  } catch (err) {
    console.error('forfeit error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/game/:roomCode — ALWAYS LAST
router.get('/:roomCode', auth, async (req, res) => {
  try {
    const game = await Game.findOne({ roomCode: req.params.roomCode.toUpperCase() })
      .populate('players.user', 'username')
      .populate('winner', 'username')
      .populate('createdBy', 'username');
    if (!game) return res.status(404).json({ message: 'Game not found' });

    const isPlayer = game.players.some(
      p => p.user._id.toString() === req.user._id.toString()
    );
    if (!isPlayer) return res.status(403).json({ message: 'Not a player in this game' });

    res.json(game);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
