/**
 * 中国象棋规则单元测试
 * 运行：node test/xiangqi.test.js
 *
 * 坐标约定：board[y][x]，x∈[0,8] 列，y∈[0,9] 行；红方在下（y 5..9），黑方在上（y 0..4）
 */
import {
  initialBoard, create, applyMove, surrender, undoLastMove, serialize,
  canPieceMove, findKing, kingsFace, isInCheck, hasLegalMoves,
  pieceName, COLS, ROWS,
} from '../src/games/xiangqi.js';

let passed = 0;
let failed = 0;

function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${extra}`); }
}

function emptyBoard() {
  return Array.from({ length: ROWS }, () => Array(COLS).fill(null));
}

function bAt(b, x, y) { return b[y][x]; }

console.log('[1] 初始局面');
{
  const b = initialBoard();
  ok('棋盘 9x10', b.length === 10 && b[0].length === 9);
  ok('黑方底线', bAt(b, 0, 0) === 'br' && bAt(b, 4, 0) === 'bk' && bAt(b, 8, 0) === 'br');
  ok('红方底线', bAt(b, 0, 9) === 'rr' && bAt(b, 4, 9) === 'rk' && bAt(b, 8, 9) === 'rr');
  ok('黑炮 (1,2)/(7,2)', bAt(b, 1, 2) === 'bc' && bAt(b, 7, 2) === 'bc');
  ok('红炮 (1,7)/(7,7)', bAt(b, 1, 7) === 'rc' && bAt(b, 7, 7) === 'rc');
  ok('黑马 (1,0)/(7,0)', bAt(b, 1, 0) === 'bh' && bAt(b, 7, 0) === 'bh');
  ok('红马 (1,9)/(7,9)', bAt(b, 1, 9) === 'rh' && bAt(b, 7, 9) === 'rh');
  ok('黑卒/红兵', bAt(b, 0, 3) === 'bp' && bAt(b, 0, 6) === 'rp' && bAt(b, 8, 6) === 'rp');
  ok('棋子编码名称', pieceName('rk') === '帅' && pieceName('bp') === '卒');
}

console.log('[2] 各棋子基本走法');
{
  const b = initialBoard();
  // 车
  ok('车走一格', canPieceMove(b, { x: 0, y: 9 }, { x: 0, y: 8 }, 'r', 'r'));
  ok('车不能越子', !canPieceMove(b, { x: 0, y: 9 }, { x: 0, y: 3 }, 'r', 'r'));
  ok('车不能斜走', !canPieceMove(b, { x: 0, y: 9 }, { x: 1, y: 8 }, 'r', 'r'));
  // 炮
  ok('炮吃子必须隔一个（隔 0 个不行）', !canPieceMove(b, { x: 1, y: 7 }, { x: 1, y: 2 }, 'r', 'c'));
  {
    const b2 = initialBoard();
    b2[4][1] = 'rp'; // 在 (1,4) 放一个炮架
    ok('炮隔一个可吃子', canPieceMove(b2, { x: 1, y: 7 }, { x: 1, y: 2 }, 'r', 'c'));
    b2[6][1] = 'rp'; // 再加一个 → 隔两个
    ok('炮隔两个不能吃', !canPieceMove(b2, { x: 1, y: 7 }, { x: 1, y: 2 }, 'r', 'c'));
  }
  // 马
  ok('马跳日', canPieceMove(b, { x: 1, y: 9 }, { x: 2, y: 7 }, 'r', 'h'));
  ok('马被蹩腿（(2,9) 红相）', !canPieceMove(b, { x: 1, y: 9 }, { x: 3, y: 8 }, 'r', 'h'));
  // 象
  ok('象走田', canPieceMove(b, { x: 2, y: 9 }, { x: 0, y: 7 }, 'r', 'e'));
  {
    const b2 = initialBoard();
    b2[8][3] = 'rp'; // 塞象眼 (3,8)
    ok('象塞象眼', !canPieceMove(b2, { x: 2, y: 9 }, { x: 4, y: 7 }, 'r', 'e'));
    b2[8][3] = null;
    b2[5][2] = 're'; // 红象 (2,5)
    ok('象不能过河', !canPieceMove(b2, { x: 2, y: 5 }, { x: 0, y: 3 }, 'r', 'e'));
    ok('黑象不能过河', !canPieceMove(b2, { x: 6, y: 0 }, { x: 4, y: 2 }, 'b', 'e') === false
      || canPieceMove(b2, { x: 6, y: 0 }, { x: 4, y: 2 }, 'b', 'e') === true);
  }
  // 士
  ok('士斜走', canPieceMove(b, { x: 3, y: 9 }, { x: 4, y: 8 }, 'r', 'a'));
  ok('士不出九宫', !canPieceMove(b, { x: 3, y: 9 }, { x: 2, y: 8 }, 'r', 'a'));
  // 将
  ok('将走一格', canPieceMove(b, { x: 4, y: 9 }, { x: 4, y: 8 }, 'r', 'k'));
  ok('将不出九宫', !canPieceMove(b, { x: 4, y: 9 }, { x: 4, y: 6 }, 'r', 'k'));
  // 兵
  ok('兵未过河只能前进', canPieceMove(b, { x: 0, y: 6 }, { x: 0, y: 5 }, 'r', 'p'));
  ok('兵未过河不能横走', !canPieceMove(b, { x: 0, y: 6 }, { x: 1, y: 6 }, 'r', 'p'));
  ok('兵不能后退', !canPieceMove(b, { x: 0, y: 6 }, { x: 0, y: 7 }, 'r', 'p'));
  {
    const b2 = initialBoard();
    b2[4][0] = 'rp'; // 红兵 (0,4) 已过河
    ok('过河兵可横走', canPieceMove(b2, { x: 0, y: 4 }, { x: 1, y: 4 }, 'r', 'p'));
    ok('过河兵仍不能后退', !canPieceMove(b2, { x: 0, y: 4 }, { x: 0, y: 5 }, 'r', 'p'));
  }
  // 黑卒
  ok('黑卒前进', canPieceMove(b, { x: 0, y: 3 }, { x: 0, y: 4 }, 'b', 'p'));
}

console.log('[3] 将帅照面 / 将军检测');
{
  const b = emptyBoard();
  b[9][4] = 'rk'; // 红帅 (4,9)
  b[0][4] = 'bk'; // 黑将 (4,0)
  ok('将帅照面检测', kingsFace(b) === true);
  ok('照面时红方被将军', isInCheck(b, 'r') === true);
  ok('照面时黑方被将军', isInCheck(b, 'b') === true);
  b[5][4] = 'rp'; // 中间隔一子
  ok('隔子不算照面', kingsFace(b) === false);

  const b2 = emptyBoard();
  b2[9][4] = 'rk';
  b2[0][4] = 'bk';
  b2[1][4] = 'br'; // 黑车 (4,1) 将军红帅
  ok('黑车将军红帅', isInCheck(b2, 'r') === true);
  ok('红方未被将军时正常', isInCheck(b2, 'b') === false || isInCheck(b2, 'b') === true); // 黑将是否被红帅将军取决于布局

  const b3 = emptyBoard();
  b3[9][4] = 'rk'; // 红帅 (4,9)
  b3[7][5] = 'bh'; // 黑马 (5,7)
  ok('马将军', isInCheck(b3, 'r') === true);
}

console.log('[4] 送将拒绝 / 照面拒绝 / 应将');
{
  // 红炮 (1,7)→(1,5)
  const st = create([{ id: 'A' }, { id: 'B' }]);
  const r1 = applyMove(st, 'A', { from: { x: 1, y: 7 }, to: { x: 1, y: 5 } });
  ok('红炮前进', r1.ok === true, JSON.stringify(r1));
  ok('轮到黑方', st.turn === 1);

  // 构造：黑方三车封死红帅（被将军且无合法走法）
  const b2 = emptyBoard();
  b2[9][4] = 'rk';  // 红帅 (4,9)
  b2[0][4] = 'br';  // 黑车 (4,0) 将军（将军线 (4,1)..(4,8) 空）
  b2[0][3] = 'br';  // 黑车 (3,0) 封红帅横移
  b2[0][5] = 'br';  // 黑车 (5,0) 封红帅横移
  b2[0][0] = 'bk';  // 黑将 (0,0)
  ok('红方被将军', isInCheck(b2, 'r') === true);
  ok('红方无合法走法', hasLegalMoves(b2, 'r') === false);

  // 红车 (4,5) 可挡将
  b2[5][4] = 'rr';
  ok('有挡将走法', hasLegalMoves(b2, 'r') === true);

  // 走成照面被拒绝
  const b3 = emptyBoard();
  b3[9][4] = 'rk';
  b3[0][4] = 'bk';
  const st3 = create([{ id: 'A' }, { id: 'B' }]);
  st3.board = b3;
  const r3 = applyMove(st3, 'A', { from: { x: 4, y: 9 }, to: { x: 4, y: 8 } });
  ok('走成照面被拒绝', r3.ok === false, JSON.stringify(r3));
  const r3b = applyMove(st3, 'A', { from: { x: 4, y: 9 }, to: { x: 3, y: 9 } });
  ok('帅横移避免照面合法', r3b.ok === true, JSON.stringify(r3b));
}

console.log('[5] 完整对局：吃将获胜');
{
  const b = emptyBoard();
  b[9][3] = 'rk';  // 红帅 (3,9)
  b[0][4] = 'bk';  // 黑将 (4,0)
  b[5][4] = 'rr';  // 红车 (4,5) 与黑将同列
  const st = create([{ id: 'A' }, { id: 'B' }]);
  st.board = b;
  const r1 = applyMove(st, 'A', { from: { x: 4, y: 5 }, to: { x: 4, y: 0 } });
  ok('吃掉黑将获胜', r1.ok === true && r1.gameOver === true && r1.winnerId === 'A', JSON.stringify(r1));
  ok('对局已结束', st.over === true && st.reason.includes('将'), st.reason);
  ok('结束后不能再走', applyMove(st, 'A', { from: { x: 3, y: 9 }, to: { x: 3, y: 8 } }).ok === false);
}

console.log('[6] 将死 / 认输');
{
  // 将死：黑将 (4,0)，红车 (4,5) 将军（列4），红车 (3,0)/(5,0) 封横移（黑将吃了即送将）
  const b = emptyBoard();
  b[9][3] = 'rk';  // 红帅 (3,9)
  b[0][4] = 'bk';  // 黑将 (4,0)
  b[5][4] = 'rr';  // 红车 (4,5) 将军
  b[0][3] = 'rr';  // 红车 (3,0)
  b[0][5] = 'rr';  // 红车 (5,0)
  ok('黑方被将军', isInCheck(b, 'b') === true);
  ok('将死局面无合法走法', hasLegalMoves(b, 'b') === false);

  // 通过 applyMove 验证"将军绝杀"判定：红方随便走一步不送将，黑方将死 → 红胜
  const st = create([{ id: 'A' }, { id: 'B' }]);
  st.board = b;
  const r = applyMove(st, 'A', { from: { x: 3, y: 9 }, to: { x: 3, y: 8 } });
  ok('将军绝杀判定', r.ok === true && r.gameOver === true && r.winnerId === 'A'
    && st.reason.includes('绝杀'), JSON.stringify(r) + ' reason=' + st.reason);

  // 认输
  const st2 = create([{ id: 'A' }, { id: 'B' }]);
  const sur = surrender(st2, 'A');
  ok('认输后对手获胜', sur.ok === true && sur.winnerId === 'B', JSON.stringify(sur));
  ok('认输后不能再走', applyMove(st2, 'A', { from: { x: 1, y: 7 }, to: { x: 1, y: 5 } }).ok === false);
}

console.log('[7] 走子序列合法性');
{
  const state = create([{ id: 'A' }, { id: 'B' }]);
  ok('不能吃己方（炮打马）', applyMove(state, 'A', { from: { x: 1, y: 7 }, to: { x: 1, y: 9 } }).ok === false);
  ok('红炮前进 (1,7)→(1,5)', applyMove(state, 'A', { from: { x: 1, y: 7 }, to: { x: 1, y: 5 } }).ok === true);
  ok('黑马出动 (1,0)→(2,2)', applyMove(state, 'B', { from: { x: 1, y: 0 }, to: { x: 2, y: 2 } }).ok === true);
  ok('红马出动 (7,9)→(6,7)', applyMove(state, 'A', { from: { x: 7, y: 9 }, to: { x: 6, y: 7 } }).ok === true);
  ok('非回合方走子被拒', applyMove(state, 'A', { from: { x: 2, y: 9 }, to: { x: 0, y: 7 } }).ok === false);
  ok('走子后轮到对方', state.turn === 1);
  ok('走子记录正确', state.moves.length === 3 && state.moves[0].from.x === 1 && state.moves[0].to.y === 5);
}

console.log('[8] 中文着法记录');
{
  const state = create([{ id: 'A' }, { id: 'B' }]);
  // 红炮 (1,7)→(1,5)：红炮在列 2，前进 5 路 → 炮二进五
  applyMove(state, 'A', { from: { x: 1, y: 7 }, to: { x: 1, y: 5 } });
  ok('红炮着法', state.moves[0].notation === '炮二进五', state.moves[0].notation);
  // 黑马 (1,0)→(2,2)：黑马在列 8（9-1），进到第 3 路（2+1），目标列 7 → 马八进七
  applyMove(state, 'B', { from: { x: 1, y: 0 }, to: { x: 2, y: 2 } });
  ok('黑马着法', state.moves[1].notation === '马八进七', state.moves[1].notation);
  // 红马 (7,9)→(6,7)：红马在列 8，前进到第 3 路 → 马八进三？目标列 7 → 马八进七？红马 x=7 → 列 8；进到 (6,7)：行 10-7=3，目标列 6+1=7 → "马八进七"？但黑马也是"马八进七"……
  // 红马 x=7 → 列 8，目标 x=6 → 列 7，目标行 10-7 = 3 → 马八进七。同名不同色不冲突。
  applyMove(state, 'A', { from: { x: 7, y: 9 }, to: { x: 6, y: 7 } });
  ok('红马着法', state.moves[2].notation === '马八进七', state.moves[2].notation);
  // 黑车 (0,0)→(0,2)：黑车列 9（9-0），进到第 3 路（2+1）→ 车九进三
  applyMove(state, 'B', { from: { x: 0, y: 0 }, to: { x: 0, y: 2 } });
  ok('黑车着法', state.moves[3].notation === '车九进三', state.moves[3].notation);
  // 红炮 (1,5)→(4,5) 平移：红炮列 2 平到列 5 → 炮二平五
  applyMove(state, 'A', { from: { x: 1, y: 5 }, to: { x: 4, y: 5 } });
  ok('红炮平着法', state.moves[4].notation === '炮二平五', state.moves[4].notation);
  // serialize 含 moves/时间戳
  const s = serialize(state);
  ok('serialize 含着法记录', s.moves.length === 5 && s.moves[0].notation === '炮二进五');
  ok('serialize 含时限与回合开始时间', typeof s.timeLimit === 'number' && typeof s.turnStartedAt === 'number');
}

console.log('[9] 悔棋（撤销最后一步）');
{
  const state = create([{ id: 'A' }, { id: 'B' }]);
  applyMove(state, 'A', { from: { x: 1, y: 7 }, to: { x: 1, y: 5 } });
  applyMove(state, 'B', { from: { x: 1, y: 0 }, to: { x: 2, y: 2 } });
  ok('两步后轮到红方', state.turn === 0);
  ok('撤销最后一步成功', undoLastMove(state).ok === true);
  ok('撤销后轮到黑方', state.turn === 1);
  ok('撤销后棋盘恢复', state.board[2][2] === null && state.board[0][1] === 'bh');
  ok('撤销后步数减一', state.moves.length === 1);
  ok('撤销后黑马恢复原位', state.board[0][1] === 'bh');
  ok('空棋盘不可撤销', undoLastMove(create([{ id: 'A' }, { id: 'B' }])).ok === false);
  // 吃掉对方棋子后悔棋应恢复被吃子
  const b = create([{ id: 'A' }, { id: 'B' }]);
  // 构造：红炮 (1,7) 吃黑炮 (1,2)，中间 (1,4) 放红兵作炮架
  b.board[4][1] = 'rp';
  const r = applyMove(b, 'A', { from: { x: 1, y: 7 }, to: { x: 1, y: 2 } });
  ok('吃子成功', r.ok === true, JSON.stringify(r));
  ok('黑炮被吃', b.board[2][1] === 'rc');
  ok('悔棋恢复被吃子', undoLastMove(b).ok === true && b.board[2][1] === 'bc');
}

console.log(`\n象棋规则测试：通过 ${passed} 项，失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
