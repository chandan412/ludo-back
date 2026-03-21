const BOARD_PATH_LENGTH = 52;
const HOME_STRETCH_LENGTH = 6;
const TOTAL_PATH = BOARD_PATH_LENGTH + HOME_STRETCH_LENGTH;

const START_POSITIONS = {
  red: 0,
  blue: 26
};

const SAFE_SQUARES = new Set([0, 8, 13, 21, 26, 34, 39, 47]);

const HOME_ENTRY = {
  red: 51,
  blue: 25
};

class LudoEngine {
  static getGlobalPosition(color, progress) {
    if (progress < 0) return -1;
    if (progress > TOTAL_PATH) return 57;

    const start = START_POSITIONS[color];
    if (progress <= BOARD_PATH_LENGTH - 1) {
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

      const progress = token.position;

      if (progress === -1) {
        if (diceRoll === 6) {
          validMoves.push({
            tokenIndex: index,
            currentProgress: -1,
            newProgress: 0,
            canCapture: this.canCapture(0, color, opponentState),
            willFinish: false
          });
        }
        return;
      }

      const newProgress = progress + diceRoll;
      if (newProgress > TOTAL_PATH) return;

      const willFinish = newProgress === TOTAL_PATH;
      const newGlobalPos = this.getGlobalPosition(color, newProgress);
      const canCapture = !willFinish && typeof newGlobalPos === 'number' &&
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
    const newPlayerTokens = playerState.tokens.map(t => ({ ...t }));
    const newOpponentTokens = opponentState.tokens.map(t => ({ ...t }));

    const token = newPlayerTokens[tokenIndex];
    const oldProgress = token.position;
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
