socket.on('disconnect', async () => {
  console.log(`User disconnected: ${socket.user.username}`);
  if (!socket.currentRoom) return;

  try {
    const game = await Game.findOne({
      roomCode: socket.currentRoom,
      status: { $in: ['waiting', 'active'] }, // ✅ FIXED
    }).populate('players.user', 'username');

    if (!game) return;

    const playerIdx = game.players.findIndex(
      p => p.user._id.toString() === socket.user._id.toString()
    );
    if (playerIdx === -1) return;

    // 🟡 ✅ IF GAME IS WAITING → CANCEL IMMEDIATELY
    if (game.status === 'waiting') {
      game.status = 'cancelled';
      await game.save();

      console.log(`Game ${game.roomCode} cancelled because creator left`);

      // optional: notify frontend
      io.to(socket.currentRoom).emit('game-cancelled', {
        message: 'Game cancelled because host left',
      });

      return; // stop here
    }

    // 🔴 EXISTING ACTIVE GAME LOGIC (UNCHANGED)
    game.players[playerIdx].isConnected = false;
    await game.save();

    socket.to(socket.currentRoom).emit('player-disconnected', {
      username: socket.user.username,
      message: `${socket.user.username} disconnected. Waiting 60 seconds for reconnect...`,
    });

    const timer = setTimeout(async () => {
      const freshGame = await Game.findOne({
        roomCode: socket.currentRoom,
        status: 'active',
      });

      if (!freshGame) return;

      const disconnectedIdx = freshGame.players.findIndex(
        p => p.user._id.toString() === socket.user._id.toString()
      );

      if (
        disconnectedIdx === -1 ||
        freshGame.players[disconnectedIdx].isConnected
      )
        return;

      const opponentIdx = disconnectedIdx === 0 ? 1 : 0;
      const winnerId = freshGame.players[opponentIdx].user;
      const loserId = socket.user._id;

      const pot = freshGame.betAmount * 2;
      const platformFee = Math.floor(
        pot * (parseInt(process.env.PLATFORM_FEE_PERCENT || 5) / 100)
      );
      const winAmount = pot - platformFee;

      freshGame.status = 'finished';
      freshGame.winner = winnerId;
      freshGame.loser = loserId;
      freshGame.winAmount = winAmount;
      freshGame.platformFee = platformFee;
      freshGame.finishedAt = new Date();
      await freshGame.save();

      await settleGame(freshGame, winnerId, loserId, winAmount, platformFee);

      io.to(socket.currentRoom).emit('game-over', {
        reason: 'opponent_disconnected',
        winner: { id: winnerId.toString() },
        loser: { id: loserId.toString(), username: socket.user.username },
        winAmount,
        message: `${socket.user.username} disconnected. You win!`,
      });
    }, 60000);

    if (!activeRooms.has(socket.currentRoom))
      activeRooms.set(socket.currentRoom, {});

    activeRooms.get(socket.currentRoom).disconnectTimer = timer;

  } catch (err) {
    console.error('disconnect handler error:', err);
  }
});
