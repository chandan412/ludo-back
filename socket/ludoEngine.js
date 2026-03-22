const BOARD_PATH_LENGTH = 52;
const HOME_STRETCH_LENGTH = 6;
const TOTAL_PATH = BOARD_PATH_LENGTH + HOME_STRETCH_LENGTH; // 58
const START_POSITIONS = { red: 0, blue: 26 };
const SAFE_SQUARES = new Set([0, 8, 13, 21, 26, 34, 39, 47]);

class LudoEngine {

  // ✅ FIXED: progress is 1-indexed (1=first square, 58=finished)
  // progress 1 → array index 0, progress 2 → index 1, etc.
  static getGlobalPosition(color, progress) {
    if (progress <= 0) return -1;
    if (progress > TOTAL_PATH) return TOTAL_PATH + 1;
    const idx = progress - 1; // 1-indexed → 0-indexed
    const start = START_POSITIONS[color];
    if (idx < BOARD_PATH_LENGTH) {
      return (start + idx) % BOARD_PATH_LENGTH;
    }
    return `home_${color}_${idx - BOARD_PATH_LENGTH}`;
  }

  static rollDice() {
    return Math.floor(Math.random() * 6) + 1;
  }

  static getValidMoves(playerState, diceRoll, opponentState) {
    const validMoves = [];
    const { color, tokens } = playerState;

    tokens.forEach((token, index) => {
      if (token.isFinished) return;

      const progress = (token.position !== undefined && token.position !== null && !isNaN(token.position))
        ? token.position : -1;

      if (progress === -1) {
        if (diceRoll === 6) {
          // ✅ FIXED: exit home = position 1 (first square on board)
          validMoves.push({
            tokenIndex: index,
            currentProgress: -1,
            newProgress: 1,
            canCapture: this.canCapture(this.getGlobalPosition(color, 1), color, opponentState),
            willFinish: false
          });
        }
        return;
      }

      const newProgress = progress + diceRoll;
      if (newProgress > TOTAL_PATH) return;

      const willFinish = newProgress === TOTAL_PATH;
      const newGlobalPos = this.getGlobalPosition(color, newProgress);
      const canCapture = !willFinish &&
        typeof newGlobalPos === 'number' &&
        !SAFE_SQUARES.has(newGlobalPos) &&
        this.canCapture(newGlobalPos, color, opponentState);

      validMoves.push({
        tokenIndex: index,
        currentProgress: progress,
        newProgress,
        canCapture,
        willFinish
      });
    });

    return validMoves;
  }

  static canCapture(globalPos, myColor, opponentState) {
    if (!opponentState) return false;
    return opponentState.tokens.some(t =>
      !t.isFinished &&
      t.position >= 0 &&
      this.getGlobalPosition(opponentState.color, t.position) === globalPos
    );
  }

  static applyMove(playerState, opponentState, tokenIndex, diceRoll) {
    const newPlayerTokens = playerState.tokens.map(t => ({
      position: (t.position !== undefined && t.position !== null && !isNaN(t.position)) ? Number(t.position) : -1,
      isHome: t.isHome ?? true,
      isFinished: t.isFinished ?? false
    }));

    const newOpponentTokens = opponentState.tokens.map(t => ({
      position: (t.position !== undefined && t.position !== null && !isNaN(t.position)) ? Number(t.position) : -1,
      isHome: t.isHome ?? true,
      isFinished: t.isFinished ?? false
    }));

    const token = newPlayerTokens[tokenIndex];
    const oldProgress = (token.position !== undefined && token.position !== null && !isNaN(token.position))
      ? token.position : -1;

    // ✅ FIXED: exit home → position 1 (not 0)
    const newProgress = oldProgress === -1 ? 1 : oldProgress + diceRoll;

    token.position = newProgress;
    token.isHome = false;

    let captured = false;
    let gameOver = false;

    const newGlobalPos = this.getGlobalPosition(playerState.color, newProgress);

    if (typeof newGlobalPos === 'number' && !SAFE_SQUARES.has(newGlobalPos)) {
      newOpponentTokens.forEach(opToken => {
        if (!opToken.isFinished && opToken.position >= 0) {
          const opGlobal = this.getGlobalPosition(opponentState.color, opToken.position);
          if (opGlobal === newGlobalPos) {
            opToken.position = -1;
            opToken.isHome = true;
            captured = true;
          }
        }
      });
    }

    if (newProgress >= TOTAL_PATH) {
      token.position = TOTAL_PATH;
      token.isFinished = true;
    }

    const finishedCount = newPlayerTokens.filter(t => t.isFinished).length;
    if (finishedCount === 4) gameOver = true;

    const extraTurn = diceRoll === 6 || captured;

    return {
      newPlayerTokens,
      newOpponentTokens,
      captured,
      extraTurn,
      gameOver,
      finishedCount
    };
  }

  static hasValidMoves(playerState, diceRoll, opponentState) {
    return this.getValidMoves(playerState, diceRoll, opponentState).length > 0;
  }
}

module.exports = LudoEngine;
