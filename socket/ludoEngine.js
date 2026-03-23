const BOARD_PATH_LENGTH = 52;
const HOME_STRETCH_LENGTH = 6;
const TOTAL_PATH = BOARD_PATH_LENGTH + HOME_STRETCH_LENGTH; // 58
const START_POSITIONS = { red: 0, blue: 26 };
const SAFE_SQUARES = new Set([0, 8, 13, 21, 26, 34, 39, 47]);

class LudoEngine {

  // progress is 0-indexed (0 = first square, 57 = last home square)
  static getGlobalPosition(color, progress) {
    if (progress < 0) return -1;
    if (progress >= TOTAL_PATH) return TOTAL_PATH;
    const start = START_POSITIONS[color];
    if (progress < BOARD_PATH_LENGTH) {
      return (start + progress) % BOARD_PATH_LENGTH;
    }
    return `home_${color}_${progress - BOARD_PATH_LENGTH}`;
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
        ? Number(token.position) : -1;

      if (progress === -1) {
        // ✅ Exit home on dice=6 → goes to position 0 (first cell)
        if (diceRoll === 6) {
          validMoves.push({
            tokenIndex: index,
            currentProgress: -1,
            newProgress: 0,
            canCapture: this.canCapture(this.getGlobalPosition(color, 0), color, opponentState),
            willFinish: false
          });
        }
        return;
      }

      // ✅ dice=N moves exactly N squares forward
      const newProgress = progress + diceRoll;
      if (newProgress > TOTAL_PATH - 1) return; // can't overshoot

      const willFinish = newProgress === TOTAL_PATH - 1;
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
      ? Number(token.position) : -1;

    // ✅ Exit home → position 0. Normal move → position + dice
    const newProgress = oldProgress === -1 ? 0 : oldProgress + diceRoll;

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

    // Finish if reached last cell
    if (newProgress >= TOTAL_PATH - 1) {
      token.position = TOTAL_PATH - 1;
      token.isFinished = true;
    }

    const finishedCount = newPlayerTokens.filter(t => t.isFinished).length;
    if (finishedCount === 4) gameOver = true;

    const extraTurn = diceRoll === 6 || captured;

    return { newPlayerTokens, newOpponentTokens, captured, extraTurn, gameOver, finishedCount };
  }

  static hasValidMoves(playerState, diceRoll, opponentState) {
    return this.getValidMoves(playerState, diceRoll, opponentState).length > 0;
  }
}

module.exports = LudoEngine;
