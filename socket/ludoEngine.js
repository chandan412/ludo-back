const BOARD_PATH_LENGTH   = 51;  // main loop squares (0-50)
const HOME_STRETCH_LENGTH = 6;   // colored home column squares (51-56)
const HOME_CENTER         = 57;  // center triangle — the true finish (progress 57)
const TOTAL_PATH          = HOME_CENTER + 1; // 58

const START_POSITIONS = { red: 0, blue: 26 };

// Safe squares by GLOBAL board position (0-51)
const SAFE_SQUARES = new Set([0, 8, 13, 21, 26, 34, 39, 47]);

function normalizeProgress(position) {
  if (position === undefined || position === null || isNaN(position)) return -1;
  return Number(position);
}

class LudoEngine {

  static rollDice() {
    return Math.floor(Math.random() * 6) + 1;
  }

  static getGlobalPosition(color, progress) {
    if (progress < 0) return null;
    if (progress >= BOARD_PATH_LENGTH) return null;
    const start = START_POSITIONS[color];
    return (start + progress) % BOARD_PATH_LENGTH;
  }

  static canCapture(globalPos, opponentState) {
    if (!opponentState || globalPos === null) return false;
    if (SAFE_SQUARES.has(globalPos)) return false;
    return opponentState.tokens.some(t => {
      if (t.isFinished) return false;
      const tProgress = normalizeProgress(t.position);
      if (tProgress < 0) return false;
      if (tProgress >= BOARD_PATH_LENGTH) return false;
      const opGlobal = this.getGlobalPosition(opponentState.color, tProgress);
      return opGlobal === globalPos;
    });
  }

  static getValidMoves(playerState, diceRoll, opponentState) {
    const validMoves = [];
    const { color, tokens } = playerState;

    tokens.forEach((token, index) => {
      if (token.isFinished) return;
      const progress = normalizeProgress(token.position);

      if (progress === -1) {
        if (diceRoll === 6) {
          const globalPos  = this.getGlobalPosition(color, 0);
          const canCapture = this.canCapture(globalPos, opponentState);
          validMoves.push({ tokenIndex: index, currentProgress: -1, newProgress: 0, canCapture, willFinish: false });
        }
        return;
      }

      const newProgress = progress + diceRoll;
      if (newProgress > HOME_CENTER) return; // cannot overshoot center — exact roll needed

      const willFinish = newProgress === HOME_CENTER;
      const globalPos  = this.getGlobalPosition(color, newProgress);
      const canCapture = (!willFinish && globalPos !== null) ? this.canCapture(globalPos, opponentState) : false;

      validMoves.push({ tokenIndex: index, currentProgress: progress, newProgress, canCapture, willFinish });
    });

    return validMoves;
  }

  static applyMove(playerState, opponentState, tokenIndex, diceRoll) {
    const newPlayerTokens = playerState.tokens.map(t => ({
      position: normalizeProgress(t.position), isHome: t.isHome ?? true, isFinished: t.isFinished ?? false,
    }));
    const newOpponentTokens = opponentState.tokens.map(t => ({
      position: normalizeProgress(t.position), isHome: t.isHome ?? true, isFinished: t.isFinished ?? false,
    }));

    const token       = newPlayerTokens[tokenIndex];
    const oldProgress = normalizeProgress(token.position);
    const newProgress = oldProgress === -1 ? 0 : oldProgress + diceRoll;

    token.position = newProgress;
    token.isHome   = false;

    let captured = false;
    let gameOver  = false;

    const newGlobalPos = this.getGlobalPosition(playerState.color, newProgress);
    if (newGlobalPos !== null && !SAFE_SQUARES.has(newGlobalPos)) {
      newOpponentTokens.forEach(opToken => {
        if (opToken.isFinished) return;
        const opProgress = opToken.position;
        if (opProgress < 0 || opProgress >= BOARD_PATH_LENGTH) return;
        const opGlobal = this.getGlobalPosition(opponentState.color, opProgress);
        if (opGlobal === newGlobalPos) {
          opToken.position = -1;
          opToken.isHome   = true;
          captured = true;
          console.log(`[CAPTURE] ${playerState.color} captured ${opponentState.color} at global ${newGlobalPos}`);
        }
      });
    }

    if (newProgress >= HOME_CENTER) {
      token.position   = HOME_CENTER;
      token.isFinished = true;
    }

    const finishedCount = newPlayerTokens.filter(t => t.isFinished).length;
    if (finishedCount === 4) gameOver = true;

    // Extra turn: rolling 6 OR capturing OR reaching home center (Indian online variant)
    const reachedHome = newProgress >= HOME_CENTER;
    const extraTurn = diceRoll === 6 || captured || reachedHome;

    return { newPlayerTokens, newOpponentTokens, captured, extraTurn, gameOver, finishedCount };
  }

  static hasValidMoves(playerState, diceRoll, opponentState) {
    return this.getValidMoves(playerState, diceRoll, opponentState).length > 0;
  }
}

module.exports = LudoEngine;
