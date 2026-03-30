const BOARD_PATH_LENGTH = 52;
const HOME_STRETCH_LENGTH = 6;
const TOTAL_PATH = BOARD_PATH_LENGTH + HOME_STRETCH_LENGTH; // 58


const START_POSITIONS = { red: 0, blue: 26 };

// Safe squares by GLOBAL board position (0-51)
const SAFE_SQUARES = new Set([0, 8, 13, 21, 26, 34, 39, 47]);

class LudoEngine {

  static rollDice() {
    return Math.floor(Math.random() * 6) + 1;
  }

  // Returns global board position (0-51) for tokens on main loop
  // Returns null for tokens in home stretch (progress >= 52) — they can't be captured
  static getGlobalPosition(color, progress) {
    if (progress < 0) return null;                  // still in home base
    if (progress >= BOARD_PATH_LENGTH) return null; // in home stretch — safe, can't capture
    const start = START_POSITIONS[color];
    return (start + progress) % BOARD_PATH_LENGTH;
  }

  // ✅ Can we capture an opponent token at this global position?
  static canCapture(globalPos, opponentState) {
    if (!opponentState || globalPos === null) return false;
    if (SAFE_SQUARES.has(globalPos)) return false; // safe square — no capture

    return opponentState.tokens.some(t => {
      if (t.isFinished) return false;
      const tProgress = (t.position !== undefined && t.position !== null && !isNaN(t.position))
        ? Number(t.position) : -1;
      if (tProgress < 0) return false;                    // in home base
      if (tProgress >= BOARD_PATH_LENGTH) return false;   // in home stretch — safe

      const opGlobal = this.getGlobalPosition(opponentState.color, tProgress);
      return opGlobal === globalPos;
    });
  }

  static getValidMoves(playerState, diceRoll, opponentState) {
    const validMoves = [];
    const { color, tokens } = playerState;

    tokens.forEach((token, index) => {
      if (token.isFinished) return;

      const progress = (token.position !== undefined && token.position !== null && !isNaN(token.position))
        ? Number(token.position) : -1;

      // Token in home base — only a 6 can bring it out
      if (progress === -1) {
        if (diceRoll === 6) {
          const globalPos = this.getGlobalPosition(color, 0);
          const canCapture = this.canCapture(globalPos, opponentState);
          validMoves.push({
            tokenIndex: index,
            currentProgress: -1,
            newProgress: 0,
            canCapture,
            willFinish: false
          });
        }
        return;
      }

      const newProgress = progress + diceRoll;

      // Can't overshoot the finish
      if (newProgress > TOTAL_PATH - 1) return;

      const willFinish = newProgress === TOTAL_PATH - 1;

      // Tokens in home stretch (progress >= 52) can never be captured or capture
      const globalPos = this.getGlobalPosition(color, newProgress);
      const canCapture = !willFinish && globalPos !== null
        ? this.canCapture(globalPos, opponentState)
        : false;

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

  static applyMove(playerState, opponentState, tokenIndex, diceRoll) {
    const newPlayerTokens = playerState.tokens.map(t => ({
      position:   (t.position !== undefined && t.position !== null && !isNaN(t.position)) ? Number(t.position) : -1,
      isHome:     t.isHome ?? true,
      isFinished: t.isFinished ?? false
    }));
    const newOpponentTokens = opponentState.tokens.map(t => ({
      position:   (t.position !== undefined && t.position !== null && !isNaN(t.position)) ? Number(t.position) : -1,
      isHome:     t.isHome ?? true,
      isFinished: t.isFinished ?? false
    }));

    const token = newPlayerTokens[tokenIndex];
    const oldProgress = (token.position !== undefined && token.position !== null && !isNaN(token.position))
      ? Number(token.position) : -1;

    const newProgress = oldProgress === -1 ? 0 : oldProgress + diceRoll;

    token.position = newProgress;
    token.isHome   = false;

    let captured = false;
    let gameOver  = false;

    // ✅ Only attempt capture if landing on main loop (not home stretch)
    const newGlobalPos = this.getGlobalPosition(playerState.color, newProgress);

    if (newGlobalPos !== null && !SAFE_SQUARES.has(newGlobalPos)) {
      newOpponentTokens.forEach(opToken => {
        if (opToken.isFinished) return;
        const opProgress = opToken.position;
        if (opProgress < 0) return;                   // opponent in home base
        if (opProgress >= BOARD_PATH_LENGTH) return;  // opponent in home stretch — safe

        const opGlobal = this.getGlobalPosition(opponentState.color, opProgress);
        if (opGlobal === newGlobalPos) {
          // ✅ CAPTURE — send opponent token back to base
          opToken.position = -1;
          opToken.isHome   = true;
          captured = true;
        }
      });
    }

    // Finish if reached last cell
    if (newProgress >= TOTAL_PATH - 1) {
      token.position  = TOTAL_PATH - 1;
      token.isFinished = true;
    }

    const finishedCount = newPlayerTokens.filter(t => t.isFinished).length;
    if (finishedCount === 4) gameOver = true;

    // Extra turn on 6 OR on capture
    const extraTurn = diceRoll === 6 || captured;

    return { newPlayerTokens, newOpponentTokens, captured, extraTurn, gameOver, finishedCount };
  }

  static hasValidMoves(playerState, diceRoll, opponentState) {
    return this.getValidMoves(playerState, diceRoll, opponentState).length > 0;
  }
}

module.exports = LudoEngine;
