// ─────────────────────────────────────────────────────────────────────────────
//  Ludo Engine  —  2-player (red vs blue) with full 4-color support
//  Main track   : 52 squares  (progress 0–51)
//  Home stretch : 6 squares   (progress 52–57)
//  Finish       : progress 57 (exact roll required)
// ─────────────────────────────────────────────────────────────────────────────

const BOARD_PATH_LENGTH   = 51;   // 51 main loop steps (progress 0-50; 50 = junction/entry)
const HOME_STRETCH_LENGTH = 6;
const TOTAL_PATH          = BOARD_PATH_LENGTH + HOME_STRETCH_LENGTH; // 57
const FINISH_PROGRESS     = TOTAL_PATH - 1; // 56

// Starting offsets on the shared 52-square main loop
// Must match LudoBoard.js RED_MAIN array order
const START_OFFSETS = {
  red:    0,
  green:  13,
  blue:   26,
  yellow: 39,
};

// Safe squares as global indices into the main loop
// Matches SAFE_INDICES in LudoBoard.js: [0,8,13,21,26,34,39,47]
// = [6,1],[2,6],[1,8],[6,12],[8,13],[12,8],[13,6],[8,2]
const SAFE_SQUARES = new Set([0, 8, 13, 21, 26, 34, 39, 47]);

class LudoEngine {

  static rollDice() {
    return Math.floor(Math.random() * 6) + 1;
  }

  // Convert token progress (0-51) → global board index (0-51)
  // Returns null if in home base (progress < 0) or home stretch (progress >= 52)
  static getGlobalPosition(color, progress) {
    if (progress < 0) return null;
    if (progress >= BOARD_PATH_LENGTH) return null;
    const offset = START_OFFSETS[color];
    if (offset === undefined) return null;
    return (offset + progress) % 52; // 52 = full main loop size
  }

  static canCapture(globalPos, opponentState) {
    if (!opponentState || globalPos === null) return false;
    if (SAFE_SQUARES.has(globalPos)) return false;
    return opponentState.tokens.some(t => {
      if (t.isFinished) return false;
      const tProgress = this._safeProgress(t.position);
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
      const progress = this._safeProgress(token.position);

      if (progress === -1) {
        if (diceRoll === 6) {
          const globalPos   = this.getGlobalPosition(color, 0);
          const willCapture = this.canCapture(globalPos, opponentState);
          validMoves.push({ tokenIndex: index, currentProgress: -1, newProgress: 0, canCapture: willCapture, willFinish: false });
        }
        return;
      }

      const newProgress = progress + diceRoll;
      if (newProgress > FINISH_PROGRESS) return;

      const willFinish  = newProgress === FINISH_PROGRESS;
      const globalPos   = this.getGlobalPosition(color, newProgress);
      const willCapture = !willFinish && globalPos !== null
        ? this.canCapture(globalPos, opponentState) : false;

      validMoves.push({ tokenIndex: index, currentProgress: progress, newProgress, canCapture: willCapture, willFinish });
    });

    return validMoves;
  }

  static applyMove(playerState, opponentState, tokenIndex, diceRoll) {
    const newPlayerTokens = playerState.tokens.map(t => ({
      position:   this._safeProgress(t.position),
      isHome:     t.isHome     ?? true,
      isFinished: t.isFinished ?? false,
    }));
    const newOpponentTokens = opponentState.tokens.map(t => ({
      position:   this._safeProgress(t.position),
      isHome:     t.isHome     ?? true,
      isFinished: t.isFinished ?? false,
    }));

    const token      = newPlayerTokens[tokenIndex];
    const oldProgress = this._safeProgress(token.position);
    const newProgress = oldProgress === -1 ? 0 : oldProgress + diceRoll;

    token.position = newProgress;
    token.isHome   = false;

    let captured = false;
    let gameOver  = false;

    const newGlobalPos = this.getGlobalPosition(playerState.color, newProgress);
    if (newGlobalPos !== null && !SAFE_SQUARES.has(newGlobalPos)) {
      newOpponentTokens.forEach(opToken => {
        if (opToken.isFinished) return;
        const opProgress = this._safeProgress(opToken.position);
        if (opProgress < 0) return;
        if (opProgress >= BOARD_PATH_LENGTH) return;
        const opGlobal = this.getGlobalPosition(opponentState.color, opProgress);
        if (opGlobal === newGlobalPos) {
          opToken.position = -1;
          opToken.isHome   = true;
          captured = true;
        }
      });
    }

    if (newProgress >= FINISH_PROGRESS) {
      token.position   = FINISH_PROGRESS;
      token.isFinished = true;
    }

    const finishedCount = newPlayerTokens.filter(t => t.isFinished).length;
    if (finishedCount === newPlayerTokens.length) gameOver = true;

    // Extra turn: roll 6 OR capture (Indian Ludo rules)
    const extraTurn = diceRoll === 6 || captured;

    return { newPlayerTokens, newOpponentTokens, captured, extraTurn, gameOver, finishedCount };
  }

  static hasValidMoves(playerState, diceRoll, opponentState) {
    return this.getValidMoves(playerState, diceRoll, opponentState).length > 0;
  }

  static _safeProgress(pos) {
    if (pos === undefined || pos === null || isNaN(Number(pos))) return -1;
    return Number(pos);
  }
}

module.exports = LudoEngine;
