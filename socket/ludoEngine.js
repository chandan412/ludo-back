const crypto = require('crypto');

// ✅ Standard Ludo:
//   - Physical board loop has 52 cells (global position 0..51)
//   - Each player TRAVERSES 51 cells before entering home column
//     (they skip the cell right before their own start — the 52nd cell)
//   - Home column has 5 colored cells + 1 center home triangle = 6 cells
//   - Total movement: progress 0..50 (main) + 51..55 (home column) + 56 (center) = 57 progress steps
const PHYSICAL_LOOP_LENGTH = 52;     // ✅ Physical cells on board's main loop
const BOARD_PATH_LENGTH = 51;        // ✅ Cells each player traverses on main loop
const HOME_STRETCH_LENGTH = 6;       // 5 home column cells + 1 center home
const TOTAL_PATH = BOARD_PATH_LENGTH + HOME_STRETCH_LENGTH; // 57

const START_POSITIONS = { red: 0, blue: 26 };

// Safe squares by GLOBAL physical board position (0-51)
const SAFE_SQUARES = new Set([0, 8, 13, 21, 26, 34, 39, 47]);

class LudoEngine {

  static rollDice() {
    // ✅ Cryptographically secure, unbiased 1..6. crypto.randomInt(1, 7) returns an
    // integer in [1, 7) — i.e. 1..6 inclusive — with no modulo bias and no
    // predictability (unlike Math.random()). Appropriate for a real-money game.
    // The custom six-rule (reroll on a 3rd consecutive six) lives in gameSocket and
    // simply calls this again, so it is unaffected.
    return crypto.randomInt(1, 7);
  }

  // Returns global physical board position (0-51) for tokens on main loop
  // Returns null for tokens in home stretch (progress >= 51) — they can't be captured
  static getGlobalPosition(color, progress) {
    if (progress < 0) return null;                  // still in home base
    if (progress >= BOARD_PATH_LENGTH) return null; // in home stretch — safe, can't capture
    const start = START_POSITIONS[color];
    return (start + progress) % PHYSICAL_LOOP_LENGTH;
  }

  // ✅ Can we capture an opponent token at this global position?
  // Count-based: capture is only possible if MY token count on that cell (after the
  // move, i.e. +1 for the incoming token) would be >= the OPPONENT's count there.
  static canCapture(globalPos, opponentState, playerState = null, incomingCount = 1) {
    if (!opponentState || globalPos === null) return false;
    if (SAFE_SQUARES.has(globalPos)) return false; // safe square — no capture

    const opCount = this.countTokensAtGlobal(opponentState, globalPos);
    if (opCount === 0) return false;

    // Count my tokens already on that cell (the incoming token is counted separately).
    const myExisting = playerState ? this.countTokensAtGlobal(playerState, globalPos) : 0;
    return (myExisting + incomingCount) >= opCount;
  }

  // ✅ Count how many of a player's tokens sit on a given GLOBAL board position.
  static countTokensAtGlobal(state, globalPos) {
    if (!state || globalPos === null) return 0;
    let count = 0;
    state.tokens.forEach(t => {
      if (t.isFinished) return;
      const p = (t.position !== undefined && t.position !== null && !isNaN(t.position)) ? Number(t.position) : -1;
      if (p < 0 || p >= BOARD_PATH_LENGTH) return;
      if (this.getGlobalPosition(state.color, p) === globalPos) count++;
    });
    return count;
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
          const canCapture = this.canCapture(globalPos, opponentState, playerState, 1);
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

      // Tokens in home stretch (progress >= 51) can never be captured or capture
      const globalPos = this.getGlobalPosition(color, newProgress);
      const canCapture = !willFinish && globalPos !== null
        ? this.canCapture(globalPos, opponentState, playerState, 1)
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

    let captured        = false;
    let passiveCaptured = false; // BUG-8
    let gameOver        = false;

    // Build temporary state objects reflecting the post-move token positions, so
    // count helpers see the new reality (the moved token is already at newProgress).
    const movedColor = playerState.color;
    const oppColor   = opponentState.color;
    const tmpPlayerState = { color: movedColor, tokens: newPlayerTokens };
    const tmpOppState    = { color: oppColor,   tokens: newOpponentTokens };

    // ── (1) CAPTURE AT DESTINATION (count-based) ──
    // My move lands on newGlobalPos. I capture the opponent's stack there ONLY if
    // my token count on that cell >= their count. Otherwise we coexist (no capture).
    const newGlobalPos = this.getGlobalPosition(movedColor, newProgress);
    if (newGlobalPos !== null && !SAFE_SQUARES.has(newGlobalPos)) {
      const myCount = this.countTokensAtGlobal(tmpPlayerState, newGlobalPos);
      const opCount = this.countTokensAtGlobal(tmpOppState, newGlobalPos);
      if (opCount > 0 && myCount >= opCount) {
        // Capture ALL opponent tokens on this cell
        newOpponentTokens.forEach(opToken => {
          if (opToken.isFinished) return;
          const opProgress = opToken.position;
          if (opProgress < 0 || opProgress >= BOARD_PATH_LENGTH) return;
          if (this.getGlobalPosition(oppColor, opProgress) === newGlobalPos) {
            opToken.position = -1;
            opToken.isHome   = true;
            captured = true;
          }
        });
      }
    }

    // ── (2) PASSIVE AUTO-CAPTURE AT VACATED CELL ──
    // The moved token left oldGlobalPos. If opponent tokens are sitting there and
    // now (after I reduced my count) the OPPONENT count >= my remaining count,
    // the opponent's sitting tokens auto-capture MY remaining tokens there.
    const oldGlobalPos = oldProgress >= 0 ? this.getGlobalPosition(movedColor, oldProgress) : null;
    if (oldGlobalPos !== null && oldGlobalPos !== newGlobalPos && !SAFE_SQUARES.has(oldGlobalPos)) {
      const myRemaining = this.countTokensAtGlobal(tmpPlayerState, oldGlobalPos);
      const opThere     = this.countTokensAtGlobal(tmpOppState, oldGlobalPos);
      if (myRemaining > 0 && opThere >= myRemaining) {
        // Opponent outnumbers/equals my leftover tokens → my tokens get captured
        newPlayerTokens.forEach(myToken => {
          if (myToken.isFinished) return;
          const p = myToken.position;
          if (p < 0 || p >= BOARD_PATH_LENGTH) return;
          if (this.getGlobalPosition(movedColor, p) === oldGlobalPos) {
            myToken.position = -1;
            myToken.isHome   = true;
            passiveCaptured  = true; // BUG-8
            // Note: this is the opponent capturing me — does NOT grant me a capture/extra turn
          }
        });
      }
    }

    // Finish if reached last cell
    if (newProgress >= TOTAL_PATH - 1) {
      token.position  = TOTAL_PATH - 1;
      token.isFinished = true;
    }

    const finishedCount = newPlayerTokens.filter(t => t.isFinished).length;
    if (finishedCount === 4) gameOver = true;

    // ✅ Extra turn on 6 OR capture OR reaching main home (finishing a token)
    const extraTurn = diceRoll === 6 || captured || token.isFinished;

    return { newPlayerTokens, newOpponentTokens, captured, passiveCaptured, extraTurn, gameOver, finishedCount };
  }

  static hasValidMoves(playerState, diceRoll, opponentState) {
    return this.getValidMoves(playerState, diceRoll, opponentState).length > 0;
  }
}

module.exports = LudoEngine;
