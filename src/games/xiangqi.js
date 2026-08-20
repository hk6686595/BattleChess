/**
 * 中国象棋（Xiangqi）规则引擎
 *
 * 棋盘坐标：x ∈ [0,8]（列，左→右），y ∈ [0,9]（行，上→下）
 *   黑方在上（y 0..4 为黑半场），红方在下（y 5..9 为红半场），河界在 y=4/5 之间
 *   红方先手
 *
 * 棋子编码（board[y][x]）：
 *   null 空；字符串两位：第 1 位颜色 'r'红 / 'b'黑，第 2 位类型
 *   k=将/帅 a=士/仕 e=象/相 h=马 r=车 c=炮 p=兵/卒
 */
export const type = 'xiangqi';
export const name = '中国象棋';
export const minPlayers = 2;
export const maxPlayers = 2;
export const supportsSpectate = true;

export const COLS = 9;
export const ROWS = 10;

const TYPES = {
  king: 'k',
  advisor: 'a',
  elephant: 'e',
  horse: 'h',
  rook: 'r',
  cannon: 'c',
  pawn: 'p',
};

const PIECE_NAMES = {
  rk: '帅', ra: '仕', re: '相', rh: '马', rr: '车', rc: '炮', rp: '兵',
  bk: '将', ba: '士', be: '象', bh: '马', br: '车', bc: '炮', bp: '卒',
};

export function pieceName(code) {
  return PIECE_NAMES[code] || '';
}

/** 初始棋盘 */
export function initialBoard() {
  const b = Array.from({ length: ROWS }, () => Array(COLS).fill(null));
  const back = ['r', 'h', 'e', 'a', 'k', 'a', 'e', 'h', 'r'];
  for (let x = 0; x < COLS; x++) {
    b[0][x] = 'b' + back[x]; // 黑方底线
    b[9][x] = 'r' + back[x]; // 红方底线
  }
  b[2][1] = 'bc'; b[2][7] = 'bc'; // 黑炮
  b[7][1] = 'rc'; b[7][7] = 'rc'; // 红炮
  for (let x = 0; x < COLS; x += 2) {
    b[3][x] = 'bp'; // 黑卒
    b[6][x] = 'rp'; // 红兵
  }
  return b;
}

export function create(players, opts = {}) {
  return {
    type,
    board: initialBoard(),
    turn: 0,
    players: players.map((p) => ({ id: p.id, name: p.name })),
    moves: [],
    lastMove: null,
    check: null, // 当前被将军的一方颜色 'r' | 'b' | null
    captured: [],
    startedAt: Date.now(),
    // 每步走子时限（秒）与当前回合开始时间（用于倒计时与超时判负）
    timeLimit: opts.timeLimit ?? 60,
    turnStartedAt: Date.now(),
    over: false,
    winnerId: null,
    isDraw: false,
    reason: null,
  };
}

export function parseMove(raw) {
  if (typeof raw !== 'object' || raw === null) return { error: '非法走法' };
  const from = raw.from, to = raw.to;
  if (!from || !to) return { error: '走法需包含 from 和 to' };
  const fx = Number(from.x), fy = Number(from.y);
  const tx = Number(to.x), ty = Number(to.y);
  if (![fx, fy, tx, ty].every((v) => Number.isInteger(v))) return { error: '坐标必须为整数' };
  if (!inBoard(fx, fy) || !inBoard(tx, ty)) return { error: '坐标超出棋盘' };
  return { from: { x: fx, y: fy }, to: { x: tx, y: ty } };
}

function inBoard(x, y) {
  return x >= 0 && x < COLS && y >= 0 && y < ROWS;
}

function inPalace(color, x, y) {
  if (x < 3 || x > 5) return false;
  return color === 'r' ? y >= 7 && y <= 9 : y >= 0 && y <= 2;
}

function colorOf(code) {
  return code ? code[0] : null;
}
function typeOf(code) {
  return code ? code[1] : null;
}

export function findKing(board, color) {
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const c = board[y][x];
      if (c && c[0] === color && c[1] === 'k') return { x, y };
    }
  }
  return null;
}

/** 将帅是否照面（同列且中间无子） */
export function kingsFace(board) {
  const rk = findKing(board, 'r');
  const bk = findKing(board, 'b');
  if (!rk || !bk || rk.x !== bk.x) return false;
  const yMin = Math.min(rk.y, bk.y);
  const yMax = Math.max(rk.y, bk.y);
  for (let y = yMin + 1; y < yMax; y++) {
    if (board[y][rk.x]) return false;
  }
  return true;
}

/** 两格之间（不含端点）是否为空 */
function pathClear(board, from, to) {
  const dx = Math.sign(to.x - from.x);
  const dy = Math.sign(to.y - from.y);
  let x = from.x + dx, y = from.y + dy;
  while (x !== to.x || y !== to.y) {
    if (board[y][x]) return false;
    x += dx; y += dy;
  }
  return true;
}

/** 路径上棋子数量（不含端点） */
function pathCount(board, from, to) {
  const dx = Math.sign(to.x - from.x);
  const dy = Math.sign(to.y - from.y);
  let count = 0;
  let x = from.x + dx, y = from.y + dy;
  while (x !== to.x || y !== to.y) {
    if (board[y][x]) count++;
    x += dx; y += dy;
  }
  return count;
}

/**
 * 单棋子走法规则（不含将军检查）
 * board 为深拷贝或原始，from 上必须是 color 的 type 棋子
 */
export function canPieceMove(board, from, to, color, t) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const target = board[to.y][to.x];
  if (target && colorOf(target) === color) return false; // 不能吃己方
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);

  switch (t) {
    case 'r': // 车
      if (!(dx === 0 || dy === 0)) return false;
      return pathClear(board, from, to);
    case 'c': // 炮
      if (!(dx === 0 || dy === 0)) return false;
      const n = pathCount(board, from, to);
      if (target) return n === 1; // 吃子必须隔一个炮架
      return n === 0; // 不吃子不能越子
    case 'h': { // 马：蹩马腿
      if (!((adx === 1 && ady === 2) || (adx === 2 && ady === 1))) return false;
      const legX = adx === 2 ? from.x + dx / 2 : from.x;
      const legY = ady === 2 ? from.y + dy / 2 : from.y;
      if (board[legY][legX]) return false;
      return true;
    }
    case 'e': // 象：田字，塞象眼，不能过河
      if (adx !== 2 || ady !== 2) return false;
      if (color === 'r' ? to.y < 5 : to.y >= 5) return false; // 红不能到 y<5，黑不能到 y>=5
      if (board[from.y + dy / 2][from.x + dx / 2]) return false;
      return true;
    case 'a': // 士：九宫斜线一格
      if (adx !== 1 || ady !== 1) return false;
      return inPalace(color, to.x, to.y);
    case 'k': // 将/帅：九宫横竖一格
      if (adx + ady !== 1) return false;
      return inPalace(color, to.x, to.y);
    case 'p': { // 兵/卒
      const forward = color === 'r' ? -1 : 1; // 红向上(y-1)，黑向下(y+1)
      const crossedRiver = color === 'r' ? from.y <= 4 : from.y >= 5;
      if (dy === forward && dx === 0) return true;
      if (crossedRiver && dy === 0 && adx === 1) return true; // 过河后可横走
      return false; // 不能后退
    }
    default:
      return false;
  }
}

/**
 * 某方是否被将军（含将帅照面）
 */
export function isInCheck(board, color) {
  if (kingsFace(board)) return true;
  const king = findKing(board, color);
  if (!king) return true; // 老将被吃视为被将军
  const opp = color === 'r' ? 'b' : 'r';
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const c = board[y][x];
      if (c && c[0] === opp) {
        if (canPieceMove(board, { x, y }, king, opp, c[1])) return true;
      }
    }
  }
  return false;
}

/** 模拟走子，返回新棋盘 */
export function makeMove(board, from, to) {
  const nb = board.map((row) => row.slice());
  nb[to.y][to.x] = nb[from.y][from.x];
  nb[from.y][from.x] = null;
  return nb;
}

/** 某方是否存在任何合法走法（走完后自己不被将军） */
export function hasLegalMoves(board, color) {
  return genLegalMoves(board, color).length > 0;
}

/**
 * 生成某方全部合法走法（供 AI 使用）
 * 返回 [{ from: {x,y}, to: {x,y} }]
 */
export function genLegalMoves(board, color) {
  const moves = [];
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const c = board[y][x];
      if (!c || c[0] !== color) continue;
      for (let ty = 0; ty < ROWS; ty++) {
        for (let tx = 0; tx < COLS; tx++) {
          if (tx === x && ty === y) continue;
          if (!canPieceMove(board, { x, y }, { x: tx, y: ty }, color, c[1])) continue;
          const nb = makeMove(board, { x, y }, { x: tx, y: ty });
          if (!isInCheck(nb, color)) moves.push({ from: { x, y }, to: { x: tx, y: ty } });
        }
      }
    }
  }
  return moves;
}

/**
 * 走子
 * @returns {ok, error?, gameOver?, winnerId?, isDraw?, reason?, check?}
 */
export function applyMove(state, playerId, move) {
  if (state.over) return { ok: false, error: '对局已结束' };
  const current = state.players[state.turn];
  if (!current || current.id !== playerId) return { ok: false, error: '还没轮到你' };

  const parsed = parseMove(move);
  if (parsed.error) return { ok: false, error: parsed.error };
  const { from, to } = parsed;
  const board = state.board;

  const piece = board[from.y][from.x];
  const color = state.turn === 0 ? 'r' : 'b';
  if (!piece || colorOf(piece) !== color) {
    return { ok: false, error: '该位置没有你的棋子' };
  }
  if (!canPieceMove(board, from, to, color, typeOf(piece))) {
    return { ok: false, error: '不符合走子规则' };
  }
  // 模拟并检查送将 / 照面
  const nb = makeMove(board, from, to);
  if (isInCheck(nb, color)) {
    return { ok: false, error: '走子后己方将帅将被将军' };
  }

  // 正式落子
  const captured = board[to.y][to.x];
  board[to.y][to.x] = piece;
  board[from.y][from.x] = null;
  const notation = makeNotation(state, from, to, piece);
  state.lastMove = { from: { ...from }, to: { ...to } };
  state.moves.push({ player: current.id, from: { ...from }, to: { ...to }, captured, notation });
  if (captured) state.captured.push({ code: captured, at: { x: to.x, y: to.y } });

  // 吃将 → 胜利
  if (captured && captured[1] === 'k') {
    state.over = true;
    state.winnerId = current.id;
    state.reason = `吃掉对方${pieceName(captured)}`;
    return { ok: true, gameOver: true, winnerId: current.id, isDraw: false, reason: state.reason };
  }

  // 切换回合，并为本回合方重新计时
  const nextTurn = (state.turn + 1) % state.players.length;
  const oppColor = color === 'r' ? 'b' : 'r';
  state.turn = nextTurn;
  state.turnStartedAt = Date.now();

  // 对方无合法走法（将死或困毙）
  if (!hasLegalMoves(board, oppColor)) {
    state.over = true;
    state.winnerId = current.id;
    state.reason = isInCheck(board, oppColor) ? '将军绝杀' : '困毙无子可走';
    return { ok: true, gameOver: true, winnerId: current.id, isDraw: false, reason: state.reason };
  }

  state.check = isInCheck(board, oppColor) ? oppColor : null;
  return { ok: true, nextTurn, check: state.check };
}

// ---------------- 中文着法记录 ----------------

const PIECE_CH = {
  rk: '帅', ra: '仕', re: '相', rh: '马', rr: '车', rc: '炮', rp: '兵',
  bk: '将', ba: '士', be: '象', bh: '马', br: '车', bc: '炮', bp: '卒',
};

const CN_NUM = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

function cn(n) {
  return CN_NUM[n] ?? String(n);
}

/**
 * 生成中文着法（如"炮二进五""马八进七"）。
 * 红方列号从左到右 1-9、行号自底线向上 1-10；黑方列号从右到左 1-9、行号自底线向下 1-10。
 */
function makeNotation(state, from, to, piece) {
  const red = piece[0] === 'r';
  const name = PIECE_CH[piece];
  // 列号：红 x+1；黑 9-x
  const fromCol = red ? from.x + 1 : COLS - from.x;
  const toCol = red ? to.x + 1 : COLS - to.x;
  // 行号：红 10-y；黑 y+1
  const rowOf = (y) => (red ? ROWS - y : y + 1);

  // 判断平/进/退
  const action = from.y === to.y ? '平' : (red ? (to.y < from.y ? '进' : '退') : (to.y > from.y ? '进' : '退'));

  // 数字规则：直线子（车/炮/兵/将）进退跟目标行号、平移跟目标列号；
  // 跳跃子（马/相/象/士）进退跟目标列号
  const t = typeOf(piece);
  const isLinear = t === 'r' || t === 'c' || t === 'p' || t === 'k';
  let number;
  if (action === '平') {
    number = cn(toCol);
  } else {
    number = cn(isLinear ? rowOf(to.y) : toCol);
  }

  // 同一列存在多个同类棋子时，需加 前/中/后 区分
  let prefix = '';
  const sameCol = [];
  for (let y = 0; y < ROWS; y++) {
    const c = state.board[y][from.x];
    if (c && c === piece) sameCol.push(y);
  }
  if (sameCol.length >= 2) {
    // 红方：y 越小（越靠近对方）越"前"；黑方相反
    sameCol.sort(red ? (a, b) => a - b : (a, b) => b - a);
    const idx = sameCol.indexOf(from.y);
    prefix = idx === 0 ? '前' : idx === sameCol.length - 1 ? '后' : '中';
  }

  return `${prefix}${name}${cn(fromCol)}${action}${number}`;
}

/**
 * 悔棋：撤销最后一步（恢复棋子与回合，重新计时）
 */
export function undoLastMove(state) {
  if (state.over) return { ok: false, error: '对局已结束，无法悔棋' };
  if (state.moves.length === 0) return { ok: false, error: '没有可撤销的棋步' };

  const last = state.moves[state.moves.length - 1];
  const { from, to, captured } = last;
  const piece = state.board[to.y][to.x];
  state.board[from.y][from.x] = piece;
  state.board[to.y][to.x] = captured ?? null;
  state.moves.pop();
  if (captured) state.captured.pop();

  // 回合回到最后一步的走子方
  state.turn = (state.turn + state.players.length - 1) % state.players.length;
  state.lastMove = state.moves.length > 0 ? { ...state.moves[state.moves.length - 1] } : null;
  state.over = false;
  state.winnerId = null;
  state.isDraw = false;
  state.reason = null;
  state.turnStartedAt = Date.now();

  // 重新计算将军状态
  const color = state.turn === 0 ? 'r' : 'b';
  state.check = isInCheck(state.board, color) ? color : null;

  return { ok: true, turn: state.turn, notation: last.notation };
}

/** 认输 */
export function surrender(state, playerId) {
  if (state.over) return { ok: false, error: '对局已结束' };
  const idx = state.players.findIndex((p) => p.id === playerId);
  if (idx === -1) return { ok: false, error: '你不是本局玩家' };
  const winner = state.players[(idx + 1) % state.players.length];
  state.over = true;
  state.winnerId = winner.id;
  state.reason = `${state.players[idx].name} 认输`;
  return { ok: true, gameOver: true, winnerId: winner.id, isDraw: false, reason: state.reason };
}

export function serialize(state) {
  return {
    type,
    cols: COLS,
    rows: ROWS,
    board: state.board.map((row) => row.slice()),
    turn: state.turn,
    players: state.players.map((p) => ({ ...p })),
    moveCount: state.moves.length,
    moves: state.moves.map((m) => ({
      player: m.player,
      from: { ...m.from },
      to: { ...m.to },
      captured: m.captured ?? null,
      notation: m.notation,
    })),
    timeLimit: state.timeLimit,
    turnStartedAt: state.turnStartedAt,
    lastMove: state.lastMove ? { from: { ...state.lastMove.from }, to: { ...state.lastMove.to } } : null,
    check: state.check,
    captured: state.captured.map((c) => ({ ...c, at: { ...c.at } })),
    over: state.over,
    winnerId: state.winnerId,
    isDraw: state.isDraw,
    reason: state.reason,
  };
}
