const express = require('express');
const router = express.Router();
const ChatMessage = require('../models/ChatMessage');
const Game = require('../models/Game');
const { auth } = require('../middleware/auth');

// ============================================================================
// GET /api/chat/messages
//
// Returns the last 100 chat messages in chronological order (oldest first),
// so GameChat.js can render history on page load / refresh.
//
// ✅ SELF-HEALING INVITE STATE
// Every invite card carries its own lifecycle fields (status / acceptedBy /
// winnerName). gameSocket.js keeps them up to date live — but a live socket
// hook can be missed: a Railway redeploy mid-game, a crash, or an invite
// created before this feature shipped. If we trusted the stored field alone,
// those cards would be stuck showing "Waiting for someone to accept..." forever.
//
// So on every history read we re-derive the true state from the Game collection
// (the real source of truth: status, players, winner) for any invite that isn't
// already in a terminal state, and write the corrected values back. That means:
//   • Cards already sitting in production get repaired the first time anyone
//     opens chat — no migration script needed.
//   • Once a card reaches 'finished' or 'expired' it is never re-derived again,
//     so this stays cheap (one extra indexed query per page load at most).
//
// MONEY SAFETY: this route is READ-ONLY with respect to games and balances. It
// never touches Game, User, or Transaction documents — it only writes display
// fields onto chat messages.
// ============================================================================
router.get('/messages', auth, async (req, res) => {
  try {
    const messages = await ChatMessage.find()
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();
    messages.reverse(); // oldest -> newest for display

    // ── Which invite cards still need their state checked? ───────────────────
    // 'finished' and 'expired' are terminal — the result never changes again.
    const TERMINAL = new Set(['finished', 'expired']);
    const openInvites = messages.filter(
      m => m.type === 'invite' && m.roomCode && !TERMINAL.has(m.status)
    );

    if (openInvites.length > 0) {
      const codes = [...new Set(openInvites.map(m => String(m.roomCode).toUpperCase()))];

      const games = await Game.find({ roomCode: { $in: codes } })
        .populate('players.user', 'username')
        .select('roomCode status players winner winAmount betAmount')
        .lean();

      const gameByCode = new Map(games.map(g => [String(g.roomCode).toUpperCase(), g]));
      const ops = [];

      for (const msg of openInvites) {
        const game = gameByCode.get(String(msg.roomCode).toUpperCase());
        const derived = deriveInviteState(game);
        if (!derived) continue;

        // Only write when something actually changed — avoids pointless writes
        // on every single page load.
        const changed = Object.keys(derived).some(
          k => String(msg[k] ?? '') !== String(derived[k] ?? '')
        );

        // Apply to the object we're about to send back, so the client gets the
        // corrected state on THIS request, not the next one.
        Object.assign(msg, derived);

        if (changed) {
          ops.push({
            updateOne: {
              filter: { _id: msg._id },
              update: { $set: derived },
            },
          });
        }
      }

      // Fire the repairs, but never let a write failure break history loading.
      if (ops.length > 0) {
        ChatMessage.bulkWrite(ops, { ordered: false }).catch(e =>
          console.error('invite state backfill error (non-fatal):', e.message)
        );
      }
    }

    res.json(messages);
  } catch (err) {
    console.error('chat history error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================================
// Derive an invite card's display state from its Game document.
// Returns null when there is nothing meaningful to say yet.
// ============================================================================
function deriveInviteState(game) {
  // No game row at all → it was created, then cleaned up. Treat as expired so
  // the card stops inviting people into a room that no longer exists.
  if (!game) {
    return {
      status: 'expired',
      resultReason: 'no_opponent',
    };
  }

  const players = Array.isArray(game.players) ? game.players : [];
  const creator  = players[0]?.user;
  const opponent = players[1]?.user;

  if (game.status === 'waiting') {
    return { status: 'waiting' };
  }

  if (game.status === 'aborted' || game.status === 'cancelled') {
    return {
      status: 'expired',
      resultReason: game.status === 'cancelled' ? 'cancelled' : 'no_opponent',
      acceptedBy: opponent?.username || '',
      acceptedById: opponent?._id || null,
    };
  }

  if (game.status === 'active') {
    return {
      status: 'accepted',
      acceptedBy: opponent?.username || '',
      acceptedById: opponent?._id || null,
    };
  }

  if (game.status === 'finished') {
    const winnerIdStr = game.winner ? String(game.winner) : '';
    const winnerP = players.find(p => String(p.user?._id) === winnerIdStr);
    const loserP  = players.find(p => String(p.user?._id) !== winnerIdStr);

    // Finished with no winner recorded (rare: aborted-then-finished path).
    if (!winnerIdStr) {
      return {
        status: 'expired',
        resultReason: 'connection_lost',
        acceptedBy: opponent?.username || '',
        acceptedById: opponent?._id || null,
      };
    }

    return {
      status: 'finished',
      acceptedBy: opponent?.username || '',
      acceptedById: opponent?._id || null,
      winnerName: winnerP?.user?.username || '',
      winnerId: game.winner || null,
      loserName: loserP?.user?.username || '',
      winAmount: game.winAmount || 0,
      resultReason: 'win',
    };
  }

  // Unknown status — leave the card alone rather than guessing.
  void creator;
  return null;
}

module.exports = router;
