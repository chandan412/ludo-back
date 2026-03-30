const BOARD_PATH_LENGTH = 52;
const HOME_STRETCH_LENGTH = 6;
const TOTAL_PATH = BOARD_PATH_LENGTH + HOME_STRETCH_LENGTH;

const START_POSITIONS = { red: 0, blue: 26 };
const SAFE_SQUARES = new Set([0, 8, 13, 21, 26, 34, 39, 47]);

class LudoEngine {

  // 🔥 Dice history (prevents bad streaks)
  static lastRolls = [];

  // ✅ STRONG RANDOM (crypto-based)
  static secureRandom() {
    const array = new Uint32Array(1);
    crypto.getRandomValues(array);
    return (array[0] % 6) + 1;
  }

  // ✅ SMART DICE (like MPL / Ludo King)
  static rollDice() {
    let roll = this.secureRandom();

    // Prevent same number 3+ times in a row
    const last = this.lastRolls;

    if (
      last.length >= 2 &&
      last[last.length - 1] === roll &&
      last[last.length - 2] === roll
    ) {
      do {
        roll = this.secureRandom();
      } while (roll === last[last.length - 1]);
    }

    // Store history (last 5 rolls)
    this.lastRolls.push(roll);
    if (this.lastRolls.length > 5) this.lastRolls.shift();

    return roll;
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

      const p = Number(t.position ?? -1);
      if (p < 0 || p >= BOARD_PATH_LENGTH) return false;

      return this.getGlobalPosition(opponentState.color, p) === globalPos;
    });
  }

  static getValidMoves(playerState, diceRoll, opponentState) {
    const validMoves = [];
    const { color, tokens } = playerState;

    tokens.forEach((token, index) => {
      if (token.isFinished) return;

      const progress = Number(token.position ?? -1);

      // Home exit
      if (progress === -1) {
        if (diceRoll === 6) {
          const globalPos = this.getGlobalPosition(color, 0);
          validMoves.push({
            tokenIndex: index,
            currentProgress: -1,
            newProgress: 0,
            canCapture: this.canCapture(globalPos, opponentState),
            willFinish: false
          });
        }
        return;
      }

      const newProgress = progress + diceRoll;
      if (newProgress > TOTAL_PATH - 1) return;

      const willFinish = newProgress === TOTAL_PATH - 1;
      const globalPos = this.getGlobalPosition(color, newProgress);

      validMoves.push({
        tokenIndex: index,
        currentProgress: progress,
        newProgress,
        canCapture: !willFinish && globalPos !== null
          ? this.canCapture(globalPos, opponentState)
          : false,
        willFinish
      });
    });

    return validMoves;
  }

  static applyMove(playerState, opponentState, tokenIndex, diceRoll) {

    const newPlayerTokens = playerState.tokens.map(t => ({
      position: Number(t.position ?? -1),
      isHome: t.isHome ?? true,
      isFinished: t.isFinished ?? false
    }));

    const newOpponentTokens = opponentState.tokens.map(t => ({
      position: Number(t.position ?? -1),
      isHome: t.isHome ?? true,
      isFinished: t.isFinished ?? false
    }));

    const token = newPlayerTokens[tokenIndex];
    const oldProgress = token.position;

    const newProgress = oldProgress === -1 ? 0 : oldProgress + diceRoll;

    token.position = newProgress;
    token.isHome = false;

    let captured = false;

    const newGlobalPos = this.getGlobalPosition(playerState.color, newProgress);

    // ✅ CAPTURE ONLY ONE TOKEN (real Ludo rule)
    if (newGlobalPos !== null && !SAFE_SQUARES.has(newGlobalPos)) {
      const target = newOpponentTokens.find(op => {
        if (op.isFinished) return false;

        const p = op.position;
        if (p < 0 || p >= BOARD_PATH_LENGTH) return false;

        return this.getGlobalPosition(opponentState.color, p) === newGlobalPos;
      });

      if (target) {
        target.position = -1;
        target.isHome = true;
        captured = true;
      }
    }

    // Finish
    if (newProgress >= TOTAL_PATH - 1) {
      token.position = TOTAL_PATH - 1;
      token.isFinished = true;
    }

    const finishedCount = newPlayerTokens.filter(t => t.isFinished).length;
    const gameOver = finishedCount === 4;

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
