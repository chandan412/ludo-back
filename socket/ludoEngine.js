import React, { useMemo, useState, useEffect, useRef } from 'react';

const C = 46;      // ✅ increased cell size = wider paths
const B = 15 * C;  // board size

const COLORS = {
  red:    { main: '#CC0000', light: '#FFEBEE' },
  green:  { main: '#2E7D32', light: '#E8F5E9' },
  blue:   { main: '#0055AA', light: '#E3F2FD' },
  yellow: { main: '#C68000', light: '#FFFDE7' },
};

const RED_PATH = [
  [6,1],[6,2],[6,3],[6,4],[6,5],
  [5,6],[4,6],[3,6],[2,6],[1,6],[0,6],
  [0,7],
  [0,8],[1,8],[2,8],[3,8],[4,8],[5,8],
  [6,9],[6,10],[6,11],[6,12],[6,13],[6,14],
  [7,14],
  [8,14],[8,13],[8,12],[8,11],[8,10],[8,9],
  [9,8],[10,8],[11,8],[12,8],[13,8],[14,8],
  [14,7],
  [14,6],[13,6],[12,6],[11,6],[10,6],[9,6],
  [8,5],[8,4],[8,3],[8,2],[8,1],[8,0],
  [7,0],[6,0],
  [7,1],[7,2],[7,3],[7,4],[7,5],[7,6],
];

const BLUE_PATH = [
  [8,13],[8,12],[8,11],[8,10],[8,9],
  [9,8],[10,8],[11,8],[12,8],[13,8],[14,8],
  [14,7],
  [14,6],[13,6],[12,6],[11,6],[10,6],[9,6],
  [8,5],[8,4],[8,3],[8,2],[8,1],[8,0],
  [7,0],
  [6,0],[6,1],[6,2],[6,3],[6,4],[6,5],
  [5,6],[4,6],[3,6],[2,6],[1,6],[0,6],
  [0,7],
  [0,8],[1,8],[2,8],[3,8],[4,8],[5,8],
  [6,9],[6,10],[6,11],[6,12],[6,13],[6,14],
  [7,14],[8,14],
  [7,13],[7,12],[7,11],[7,10],[7,9],[7,8],
];

const SAFE = new Set(['6,1','2,6','1,8','6,12','8,13','12,8','13,6','8,2']);

// ✅ Home slot positions — fractional row/col so they center inside each quadrant
const HOME_SLOTS = {
  red:    [[1, 1],[1, 3],[3, 1],[3, 3]],
  green:  [[1,10],[1,12],[3,10],[3,12]],
  blue:   [[10,10],[10,12],[12,10],[12,12]],
  yellow: [[10, 1],[10, 3],[12, 1],[12, 3]],
};

// pixel center of a grid cell
function mid(v) { return v * C + C / 2; }
// fractional position → pixel
function midF(v) { return v * C; }

function getPathPos(color, progress) {
  if (progress < 0) return null;
  const path = color === 'red' ? RED_PATH : BLUE_PATH;
  if (progress >= path.length) return null;
  const [r, c] = path[progress];
  return { x: mid(c), y: mid(r) };
}

// ✅ FIXED PinToken — ball perfectly centered in cell
function PinToken({ x, y, color, isValid, isFinished, onClick, small }) {
  const col = COLORS[color] || COLORS.red;

  // sizes relative to cell
  const bR    = small ? C * 0.18 : C * 0.26;  // ball radius
  const pW    = small ? C * 0.19 : C * 0.28;  // pin width
  const tipDY = small ? C * 0.18 : C * 0.26;  // tip length

  // ✅ Center the whole pin (ball + tip) in the cell
  // Total visual height = bR (top of ball) + bR (bottom of ball) + tipDY
  // Shift up by half total so it looks centered
  const totalH = bR * 2 + tipDY;
  const ballCY = y - totalH / 2 + bR;
  const tipY   = ballCY + bR + tipDY;

  return (
    <g onClick={onClick} style={{ cursor: isValid ? 'pointer' : 'default' }}>
      {/* Invisible enlarged tap target for easy mobile touch */}
      <circle cx={x} cy={ballCY} r={bR + 8} fill="transparent" />
      {/* shadow */}
      <ellipse cx={x} cy={tipY + 2} rx={pW * 0.5} ry={2.5} fill="rgba(0,0,0,0.18)" />
      {/* pin body */}
      <path
        d={`M${x},${tipY}
            C${x - pW * 0.7},${ballCY + tipDY * 0.6}
             ${x - pW},${ballCY + bR * 0.4}
             ${x - pW},${ballCY}
            A${pW} ${bR * 1.1} 0 1 1 ${x + pW},${ballCY}
            C${x + pW},${ballCY + bR * 0.4}
             ${x + pW * 0.7},${ballCY + tipDY * 0.6}
             ${x},${tipY}Z`}
        fill="white"
        stroke="#ddd"
        strokeWidth="0.5"
        style={{ filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.25))' }}
      />
      {/* ball */}
      <circle cx={x} cy={ballCY} r={bR} fill={isFinished ? '#FFD700' : col.main} />
      {/* star on finished token */}
      {isFinished && (
        <text x={x} y={ballCY} textAnchor="middle" dominantBaseline="central"
          fontSize={bR * 1.1} fill="#7a5c00" style={{ userSelect: 'none', pointerEvents: 'none' }}>
          ★
        </text>
      )}
      {/* highlight */}
      <ellipse
        cx={x - bR * 0.3} cy={ballCY - bR * 0.3}
        rx={bR * 0.3} ry={bR * 0.2}
        fill="rgba(255,255,255,0.65)"
        transform={`rotate(-25,${x - bR * 0.3},${ballCY - bR * 0.3})`}
      />
      {/* valid ring */}
      {isValid && (
        <circle cx={x} cy={ballCY} r={bR + 4}
          fill="none" stroke="#FFD700" strokeWidth={2} strokeDasharray="4 3">
          <animateTransform attributeName="transform" type="rotate"
            from={`0 ${x} ${ballCY}`} to={`360 ${x} ${ballCY}`}
            dur="1s" repeatCount="indefinite" />
        </circle>
      )}
    </g>
  );
}

function HomeBox({ color, startRow, startCol, player, myColor, isMyTurn, validIdx, onTokenClick }) {
  const col   = COLORS[color];
  const slots = HOME_SLOTS[color];
  const x0    = startCol * C;
  const y0    = startRow * C;
  const size  = 6 * C;
  const pad   = C * 0.5;

  const ix = x0 + pad;
  const iy = y0 + pad;
  const iw = size - pad * 2;
  const ih = size - pad * 2;

  return (
    <g>
      {/* Outer colored square */}
      <rect x={x0} y={y0} width={size} height={size} fill={col.main} rx={6} />
      {/* Inner white circle-ish box */}
      <rect x={ix} y={iy} width={iw} height={ih} fill="white" rx={50} stroke={col.main} strokeWidth={3} />

      {/* + cross lines */}
      <line
        x1={ix + iw * 0.08} y1={iy + ih * 0.5}
        x2={ix + iw * 0.92} y2={iy + ih * 0.5}
        stroke={col.main} strokeWidth={3} strokeLinecap="round" opacity={0.25}
      />
      <line
        x1={ix + iw * 0.5} y1={iy + ih * 0.08}
        x2={ix + iw * 0.5} y2={iy + ih * 0.92}
        stroke={col.main} strokeWidth={3} strokeLinecap="round" opacity={0.25}
      />

      {/* ✅ Token slots — smaller circles */}
      {slots.map(([sr, sc], idx) => {
        const token  = player?.tokens[idx];
        const inHome = !token || token.position === -1;
        if (!inHome) return null;

        const isValid = isMyTurn && color === myColor && validIdx.has(idx);
        const px = mid(sc);
        const py = mid(sr);
        const r  = C * 0.30; // ✅ smaller slot circle

        return (
          <g key={idx}>
            <circle
              cx={px} cy={py} r={r}
              fill="white"
              stroke={isValid ? '#FFD700' : col.main}
              strokeWidth={isValid ? 2.5 : 1.5}
            />
            {player && (
              <PinToken
                x={px} y={py}
                color={color}
                isValid={isValid}
                isFinished={token?.isFinished}
                small={false}
                onClick={() => isValid && onTokenClick(idx)}
              />
            )}
          </g>
        );
      })}
    </g>
  );
}

export default function LudoBoard({ gameState, myColor, isMyTurn, onTokenClick, validMoves, lastMove }) {
  if (!gameState) return null;

  const { players } = gameState;
  const oppColor  = myColor === 'red' ? 'blue' : 'red';
  const myPlayer  = players?.find(p => p.color === myColor);
  const oppPlayer = players?.find(p => p.color === oppColor);
  const validIdx  = new Set((validMoves || []).map(m => m.tokenIndex));

  const [animPos, setAnimPos] = useState(null);
  const animTimer = useRef(null);
  const lastMoveKey = lastMove
    ? `${lastMove.color}-${lastMove.tokenIndex}-${lastMove.fromProgress}-${lastMove.toProgress}`
    : null;

  useEffect(() => {
    // lastMove cleared (null) → just wipe animPos. By this point Game.js has already
    // updated game state with the final token position, so the static token is visible.
    if (!lastMove || lastMove.fromProgress === undefined || lastMove.toProgress === undefined) {
      if (animTimer.current) { clearInterval(animTimer.current); animTimer.current = null; }
      setAnimPos(null);
      return;
    }
    const { color, tokenIndex, fromProgress, toProgress } = lastMove;
    const start = fromProgress === -1 ? 0 : fromProgress + 1;
    const end   = toProgress;
    if (start > end) { setAnimPos(null); return; }
    if (animTimer.current) clearInterval(animTimer.current);
    let step = start;
    setAnimPos({ color, tokenIndex, progress: step });
    animTimer.current = setInterval(() => {
      step++;
      if (step > end) {
        clearInterval(animTimer.current);
        animTimer.current = null;
        // ✅ Hold animPos at final position — do NOT clear here.
        // Game.js clears lastMove 50ms after updating game state, which re-triggers
        // this effect with lastMove=null and cleanly removes animPos then.
        return;
      }
      setAnimPos({ color, tokenIndex, progress: step });
    }, 150);
    return () => { if (animTimer.current) clearInterval(animTimer.current); };
  }, [lastMoveKey]);

  const grid = useMemo(() => {
    const cells = [];
    for (let r = 0; r < 15; r++) {
      for (let c = 0; c < 15; c++) {
        if (r < 6 && c < 6)   continue;
        if (r < 6 && c > 8)   continue;
        if (r > 8 && c < 6)   continue;
        if (r > 8 && c > 8)   continue;
        if (r >= 6 && r <= 8 && c >= 6 && c <= 8) continue;

        const key = `${r},${c}`;
        let fill = 'white';
        if (r === 7 && c >= 1 && c <= 6)  fill = COLORS.red.main;
        if (c === 7 && r >= 1 && r <= 6)  fill = COLORS.green.main;
        if (r === 7 && c >= 8 && c <= 13) fill = COLORS.blue.main;
        if (c === 7 && r >= 8 && r <= 13) fill = COLORS.yellow.main;

        const isSafe = SAFE.has(key);
        if (isSafe) fill = '#e8e8e8';

        cells.push(
          <g key={key}>
            <rect x={c * C} y={r * C} width={C} height={C} fill={fill} stroke="#ccc" strokeWidth={0.5} />
            {isSafe && (
              <text
                x={mid(c)} y={mid(r)}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={C * 0.48}
                fill={fill === '#e8e8e8' ? '#aaa' : 'rgba(255,255,255,0.8)'}
                style={{ userSelect: 'none' }}
              >
                ☆
              </text>
            )}
          </g>
        );
      }
    }
    return cells;
  }, []);

  const cx0 = 6 * C, cy0 = 6 * C, cx1 = 9 * C, cy1 = 9 * C, cmx = 7.5 * C, cmy = 7.5 * C;

  // ── Collect all tokens that need rendering ──────────────────────────────
  // Each entry: { key, color, posKey, x, y, idx, isValid, isFinished, isAnim }
  const tokenEntries = [];

  // Animated token
  if (animPos) {
    const animColor  = animPos.color;
    const animPlayer = animColor === myColor ? myPlayer : oppPlayer;
    if (animPlayer) {
      const pos = getPathPos(animColor, animPos.progress);
      if (pos) {
        const isValid = isMyTurn && animColor === myColor && validIdx.has(animPos.tokenIndex);
        tokenEntries.push({
          key: `anim-${animColor}-${animPos.tokenIndex}`,
          color: animColor,
          posKey: `${pos.x},${pos.y}`,
          x: pos.x, y: pos.y,
          idx: animPos.tokenIndex,
          isValid,
          isFinished: false,
          isAnim: true,
        });
      }
    }
  }

  // Static tokens
  [[myPlayer, myColor], [oppPlayer, oppColor]].forEach(([player, color]) => {
    if (!player) return;
    player.tokens.forEach((token, idx) => {
      if (token.position === -1) return; // in home base — rendered by HomeBox
      if (animPos && animPos.color === color && animPos.tokenIndex === idx && animPos.progress === token.position) return;

      // Finished tokens — show them in the center triangle area
      if (token.isFinished) {
        // Spread finished tokens slightly inside the center
        const finishedOffsets = [[-0.3,-0.3],[0.3,-0.3],[-0.3,0.3],[0.3,0.3]];
        const off = finishedOffsets[idx] || [0, 0];
        const cx  = 7.5 * C + off[0] * C;
        const cy  = 7.5 * C + off[1] * C;
        tokenEntries.push({
          key: `finished-${color}-${idx}`,
          color,
          posKey: `finished-${color}-${idx}`,
          x: cx, y: cy,
          idx,
          isValid: false,
          isFinished: true,
          isAnim: false,
        });
        return;
      }

      const pos = getPathPos(color, token.position);
      if (!pos) return;
      const isValid = isMyTurn && color === myColor && validIdx.has(idx);
      tokenEntries.push({
        key: `${color}-${idx}`,
        color,
        posKey: `${pos.x},${pos.y}`,
        x: pos.x, y: pos.y,
        idx,
        isValid,
        isFinished: false,
        isAnim: false,
      });
    });
  });

  // ── Group tokens by cell position ────────────────────────────────────────
  const cellGroups = {};
  tokenEntries.forEach(t => {
    if (!cellGroups[t.posKey]) cellGroups[t.posKey] = [];
    cellGroups[t.posKey].push(t);
  });

  // Spread offsets for stacked tokens — kept tight within ±0.18*C so tokens
  // never bleed into adjacent cells
  const SPREAD = {
    1: [[0,      0    ]],
    2: [[-0.17,  0    ], [ 0.17,  0    ]],
    3: [[-0.17, -0.15 ], [ 0.17, -0.15 ], [ 0,     0.17 ]],
    4: [[-0.17, -0.15 ], [ 0.17, -0.15 ], [-0.17,  0.17 ], [ 0.17,  0.17 ]],
  };

  // ── Build final boardTokens with spread positions ─────────────────────
  const boardTokens = [];

  Object.values(cellGroups).forEach(group => {
    const count   = group.length;
    const offsets = SPREAD[Math.min(count, 4)] || SPREAD[4];

    group.forEach((t, i) => {
      const off = offsets[i] || [0, 0];
      const rx  = t.x + off[0] * C;
      const ry  = t.y + off[1] * C;

      boardTokens.push(
        <PinToken
          key={t.key}
          x={rx} y={ry}
          color={t.color}
          isValid={t.isValid}
          isFinished={t.isFinished}
          small={true}
          onClick={() => t.isValid && onTokenClick(t.idx)}
        />
      );
    });

    // Badge showing count if >1
    if (count > 1) {
      const cx = group[0].x;
      const cy = group[0].y;
      const hasValid = group.some(t => t.isValid);
      boardTokens.push(
        <g key={`badge-${group[0].posKey}`}>
          <circle
            cx={cx + C * 0.32}
            cy={cy - C * 0.32}
            r={C * 0.22}
            fill={hasValid ? '#FFD700' : '#222'}
            stroke="white"
            strokeWidth={1.5}
          />
          <text
            x={cx + C * 0.32}
            y={cy - C * 0.32}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={C * 0.26}
            fontWeight="bold"
            fill={hasValid ? '#111' : 'white'}
            style={{ userSelect: 'none', pointerEvents: 'none' }}
          >
            {count}
          </text>
        </g>
      );
    }
  });

  return (
    <div style={{ display: 'flex', justifyContent: 'center' }}>
      <svg
        width="100%"
        viewBox={`0 0 ${B} ${B}`}
        style={{ maxWidth: 460, borderRadius: 10, border: '4px solid #111', background: 'white', boxShadow: '0 8px 32px rgba(0,0,0,0.4)' }}
      >
        <rect width={B} height={B} fill="white" />
        {grid}

        {/* Center home triangles */}
        <rect x={cx0} y={cy0} width={3 * C} height={3 * C} fill="white" />
        <polygon points={`${cx0},${cy0} ${cx0},${cy1} ${cmx},${cmy}`} fill={COLORS.red.main} />
        <polygon points={`${cx0},${cy0} ${cx1},${cy0} ${cmx},${cmy}`} fill={COLORS.green.main} />
        <polygon points={`${cx1},${cy0} ${cx1},${cy1} ${cmx},${cmy}`} fill={COLORS.blue.main} />
        <polygon points={`${cx0},${cy1} ${cx1},${cy1} ${cmx},${cmy}`} fill={COLORS.yellow.main} />

        <HomeBox
          color="red" startRow={0} startCol={0}
          player={myColor === 'red' ? myPlayer : oppPlayer}
          myColor={myColor} isMyTurn={isMyTurn}
          validIdx={validIdx} onTokenClick={onTokenClick}
        />
        <HomeBox
          color="green" startRow={0} startCol={9}
          player={null}
          myColor={myColor} isMyTurn={false}
          validIdx={new Set()} onTokenClick={() => {}}
        />
        <HomeBox
          color="yellow" startRow={9} startCol={0}
          player={null}
          myColor={myColor} isMyTurn={false}
          validIdx={new Set()} onTokenClick={() => {}}
        />
        <HomeBox
          color="blue" startRow={9} startCol={9}
          player={myColor === 'blue' ? myPlayer : oppPlayer}
          myColor={myColor} isMyTurn={isMyTurn}
          validIdx={validIdx} onTokenClick={onTokenClick}
        />

        {/* Direction arrows */}
        <text x={mid(7)} y={14}      textAnchor="middle" fontSize={14} fill="rgba(0,0,0,0.3)" fontWeight="bold">↓</text>
        <text x={mid(7)} y={B - 4}   textAnchor="middle" fontSize={14} fill="rgba(0,0,0,0.3)" fontWeight="bold">↑</text>
        <text x={10}     y={mid(7) + 5} textAnchor="middle" fontSize={14} fill="rgba(0,0,0,0.3)" fontWeight="bold">→</text>
        <text x={B - 10} y={mid(7) + 5} textAnchor="middle" fontSize={14} fill="rgba(0,0,0,0.3)" fontWeight="bold">←</text>

        {boardTokens}
      </svg>
    </div>
  );
}
