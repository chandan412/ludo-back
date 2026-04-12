// ─────────────────────────────────────────────
//  Ludo Engine  –  2-player (red vs blue) variant
//  Main track   : 52 squares   (progress 0 – 51)
//  Home stretch : 6 squares    (progress 52 – 57)
//  Finish       : progress 57  (exact roll required)
//  Total path   : 58 steps     (BOARD_PATH_LENGTH + HOME_STRETCH_LENGTH)
// ─────────────────────────────────────────────

const BOARD_PATH_LENGTH  = 52;   // main loop squares
const HOME_STRETCH_LENGTH = 6;   // colored home column + finishing cell
const TOTAL_PATH          = BOARD_PATH_LENGTH + HOME_STRETCH_LENGTH; // 58
const FINISH_PROGRESS     = TOTAL_PATH - 1; // 57

// Each color's starting offset on the shared 52-square main loop
const START_POSITIONS = {
  red:    0,
  blue:   26,
  green:  13,
  yellow: 39,
};

// Safe squares expressed as GLOBAL board positions (0-51)
// These are the 8 star squares on a standard Indian Ludo board:
// Each player's starting square + the star square in each quadrant
const SAFE_SQUARES = new Set([0, 8, 13, 21, 26, 34, 39, 47]);

class LudoEngine {

  static rollDice() {
    return Math.floor(Math.random() * 6) + 1;
  }

  /**
   * Convert a token's progress (0-51) to its GLOBAL board position (0-51).
   * Returns null for tokens not yet on the board (progress < 0)
   * or tokens in the home stretch (progress >= 52) — they are safe and can't capture/be captured.
   */
  static getGlobalPosition(color, progress) {
    if (progress < 0) return null;                   // in home base — not on board
    if (progress >= BOARD_PATH_LENGTH) return null;  // in home stretch — safe
    const start = START_POSITIONS[color];
    if (start === undefined) return null;
    return (start + progress) % BOARD_PATH_LENGTH;
  }

  /**
   * Check whether moving to globalPos would capture an opponent token there.
   * Safe squares are immune to capture.
   */
  static canCapture(globalPos, opponentState) {
    if (!opponentState || globalPos === null) return false;
    if (SAFE_SQUARES.has(globalPos)) return false; // safe square — no capture allowed

    return opponentState.tokens.some(t => {
      if (t.isFinished) return false;
      const tProgress = this._safeProgress(t.position);
      if (tProgress < 0) return false;                   // opponent still in home base
      if (tProgress >= BOARD_PATH_LENGTH) return false;  // opponent in home stretch — safe

      const opGlobal = this.getGlobalPosition(opponentState.color, tProgress);
      return opGlobal === globalPos;
    });
  }

  /**
   * Return all legal moves for playerState given diceRoll.
   * Each move: { tokenIndex, currentProgress, newProgress, canCapture, willFinish }
   */
  static getValidMoves(playerState, diceRoll, opponentState) {
    const validMoves = [];
    const { color, tokens } = playerState;

    tokens.forEach((token, index) => {
      if (token.isFinished) return;

      const progress = this._safeProgress(token.position);

      // ── Token in home base: only a 6 brings it out ──
      if (progress === -1) {
        if (diceRoll === 6) {
          const globalPos  = this.getGlobalPosition(color, 0);
          const willCapture = this.canCapture(globalPos, opponentState);
          validMoves.push({
            tokenIndex:      index,
            currentProgress: -1,
            newProgress:     0,
            canCapture:      willCapture,
            willFinish:      false,
          });
        }
        return;
      }

      const newProgress = progress + diceRoll;

      // Cannot overshoot the finishing cell — exact roll required
      if (newProgress > FINISH_PROGRESS) return;

      const willFinish = newProgress === FINISH_PROGRESS;

      // Tokens in home stretch (progress >= 52) can never capture or be captured
      const globalPos   = this.getGlobalPosition(color, newProgress);
      const willCapture = !willFinish && globalPos !== null
        ? this.canCapture(globalPos, opponentState)
        : false;

      validMoves.push({
        tokenIndex:      index,
        currentProgress: progress,
        newProgress,
        canCapture:      willCapture,
        willFinish,
      });
    });

    return validMoves;
  }

  /**
   * Apply a move. Returns:
   *   { newPlayerTokens, newOpponentTokens, captured, extraTurn, gameOver, finishedCount }
   *
   * Extra turn is granted on:
   *   - rolling a 6 (standard rule)
   *   - capturing an opponent token (Indian Ludo variant)
   */
  static applyMove(playerState, opponentState, tokenIndex, diceRoll) {
    // Deep-clone tokens so we don't mutate originals
    const newPlayerTokens   = playerState.tokens.map(t => ({
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

    // Move: from base → progress 0, or advance by diceRoll
    const newProgress = oldProgress === -1 ? 0 : oldProgress + diceRoll;

    token.position = newProgress;
    token.isHome   = false;

    let captured = false;
    let gameOver  = false;

    // ── Capture check: only on main loop, not home stretch ──
    const newGlobalPos = this.getGlobalPosition(playerState.color, newProgress);

    if (newGlobalPos !== null && !SAFE_SQUARES.has(newGlobalPos)) {
      newOpponentTokens.forEach(opToken => {
        if (opToken.isFinished) return;
        const opProgress = this._safeProgress(opToken.position);
        if (opProgress < 0) return;                   // still in base
        if (opProgress >= BOARD_PATH_LENGTH) return;  // in home stretch — safe

        const opGlobal = this.getGlobalPosition(opponentState.color, opProgress);
        if (opGlobal === newGlobalPos) {
          // ✅ Capture — send opponent token back to base
          opToken.position = -1;
          opToken.isHome   = true;
          captured = true;
        }
      });
    }

    // ── Finishing ──
    if (newProgress >= FINISH_PROGRESS) {
      token.position   = FINISH_PROGRESS;
      token.isFinished = true;
    }

    const finishedCount = newPlayerTokens.filter(t => t.isFinished).length;
    if (finishedCount === newPlayerTokens.length) gameOver = true;

    // Extra turn: rolling a 6 OR capturing (Indian Ludo rule)
    const extraTurn = diceRoll === 6 || captured;

    return {
      newPlayerTokens,
      newOpponentTokens,
      captured,
      extraTurn,
      gameOver,
      finishedCount,
    };
  }

  static hasValidMoves(playerState, diceRoll, opponentState) {
    return this.getValidMoves(playerState, diceRoll, opponentState).length > 0;
  }

  // ── Internal helper ──────────────────────────────────────────
  // Safely read a token's progress, defaulting to -1 (home base)
  static _safeProgress(pos) {
    if (pos === undefined || pos === null || isNaN(pos)) return -1;
    return Number(pos);
  }
}

module.exports = LudoEngine;
