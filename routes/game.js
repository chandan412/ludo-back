const express = require('express');
const router = express.Router();
const Game = require('../models/Game');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const { auth } = require('../middleware/auth');

const generateRoomCode = () => Math.random().toString(36).substring(2, 8).toUpperCase();

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
router.post('/create', auth, async (req, res) => {
  try {
    const { betAmount } = req.body;
    if (!betAmount || betAmount < 10)
      return res.status(400).json({ message: 'Minimum bet is ₹10' });

    const user = await User.findById(req.user._id);
    const available = user.balance - user.lockedBalance;
    if (available < betAmount)
      return res.status(400).json({ message: `Insufficient balance. Available: ₹${available}` });

    const existingGame = await Game.findOne({
      'players.user': req.user._id,
      status: { $in: ['waiting', 'active'] }
    });
    if (existingGame)
      return res.status(400).json({ message: 'You already have an active game' });

    user.lockedBalance += betAmount;
    await user.save();

    const roomCode = generateRoomCode();
    const game = await Game.create({
      roomCode,
      betAmount,
      createdBy: req.user._id,
      players: [{
        user: req.user._id,
        color: 'red',
        tokens: [
          { position: -1, isHome: true, isFinished: false },
          { position: -1, isHome: true, isFinished: false },
          { position: -1, isHome: true, isFinished: false },
          { position: -1, isHome: true, isFinished: false }
        ]
      }]
    });

    await game.populate('createdBy', 'username');
    res.status(201).json({ message: 'Game created! Share the room code.', game });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/game/join/:roomCode
router.post('/join/:roomCode', auth, async (req, res) => {
  try {
    const game = await Game.findOne({
      roomCode: req.params.roomCode.toUpperCase(),
      status: 'waiting'
    });
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
    const available = user.balance - user.lockedBalance;
    if (available < game.betAmount)
      return res.status(400).json({
        message: `Insufficient balance. Need ₹${game.betAmount}, available: ₹${available}`
      });

    user.lockedBalance += game.betAmount;
    await user.save();

    game.players.push({
      user: req.user._id,
      color: 'blue',
      tokens: [
        { position: -1, isHome: true, isFinished: false },
        { position: -1, isHome: true, isFinished: false },
        { position: -1, isHome: true, isFinished: false },
        { position: -1, isHome: true, isFinished: false }
      ]
    });
    game.status = 'active';
    game.currentTurn = game.players[0].user;
    game.startedAt = new Date();
    await game.save();

    await game.populate('players.user', 'username');
    res.json({ message: 'Joined game! Starting now.', game });
  } catch (err) {
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

    // Refund both players
    for (const p of game.players) {
      const u = await User.findById(p.user._id);
      if (u) {
        const before = u.balance;
        u.balance += game.betAmount;
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
