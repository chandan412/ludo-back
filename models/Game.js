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

// GET /api/game/my-active-game — strictly active games only
router.get('/my-active-game', auth, async (req, res) => {
  try {
    const game = await Game.findOne({
      'players.user': req.user._id,
      status: 'active'
    }).populate('players.user', 'username');
    res.json(game || null); // always 200, null if not found
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/game/my-waiting-game — strictly waiting games only
router.get('/my-waiting-game', auth, async (req, res) => {
  try {
    const game = await Game.findOne({
      'players.user': req.user._id,
      status: 'waiting'
    }).populate('players.user', 'username');
    res.json(game || null); // always 200, null if not found
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
