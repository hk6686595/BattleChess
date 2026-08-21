/**
 * 房间层测试：悔棋流程（请求/同意/撤销）与走子超时判负
 * 运行：node test/room.test.js
 */
import { config } from '../src/config.js';
import { RoomManager } from '../src/core/room.js';
import { logger } from '../src/log/logger.js';

let passed = 0;
let failed = 0;

function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${extra}`); }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  await logger.init();
  config.moveTimeLimit = 2; // 本测试用 2 秒限时验证超时判负

  const sent = [];
  const io = {
    send: (userId, msg) => sent.push({ to: [userId], msg }),
    sendToMany: (ids, msg) => sent.push({ to: ids, msg }),
    broadcastAll: (msg) => sent.push({ to: ['*'], msg }),
  };
  const rooms = new RoomManager(io);

  const userA = { id: 'u1', name: '甲' };
  const userB = { id: 'u2', name: '乙' };

  function newGame() {
    rooms.leaveRoom('u1');
    rooms.leaveRoom('u2');
    const c = rooms.createRoom(userA, { gameType: 'xiangqi' });
    rooms.joinRoom(userB, c.room.id);
    rooms.setReady('u1', true);
    rooms.setReady('u2', true);
    rooms.startGame('u1');
    return c.room.id;
  }

  function lastEvent(type) {
    return [...sent].reverse().find((e) => e.msg.type === type)?.msg;
  }

  console.log('[1] 悔棋流程：请求 → 同意 → 撤销一步');
  {
    sent.length = 0;
    const roomId = newGame();
    ok('对局开始', !!lastEvent('s.game.start'));

    rooms.applyMove('u1', { from: { x: 1, y: 7 }, to: { x: 1, y: 5 } }); // 红炮
    rooms.applyMove('u2', { from: { x: 1, y: 0 }, to: { x: 2, y: 2 } }); // 黑马
    const mv = lastEvent('s.game.move');
    ok('两步后轮到红方', mv && mv.turn === 0, JSON.stringify(mv?.turn));

    // u1 请求悔棋
    const req = rooms.undoRequest('u1');
    ok('请求悔棋成功', req.ok === true, JSON.stringify(req));
    const reqEvt = lastEvent('s.undo.requested');
    ok('对方收到悔棋请求', !!reqEvt && reqEvt.byName === '甲', JSON.stringify(reqEvt));

    // 非对方不能回应
    const bad = rooms.undoRespond('u1', true);
    ok('不能回应自己的请求', bad.error === 'BAD_REQUEST');

    // u2 同意 → 撤销黑马一步
    const resp = rooms.undoRespond('u2', true);
    ok('同意悔棋成功', resp.ok === true, JSON.stringify(resp));
    const done = lastEvent('s.undo.done');
    ok('撤销广播 UNDO_DONE', !!done, JSON.stringify(done));
    ok('撤销后步数为 1', done?.game?.moveCount === 1, `moves=${done?.game?.moveCount}`);
    ok('黑马回到原位', done?.game?.board?.[0]?.[1] === 'bh');
    ok('撤销后轮到黑方', done?.game?.turn === 1, `turn=${done?.game?.turn}`);
  }

  console.log('[2] 悔棋被拒绝');
  {
    sent.length = 0;
    newGame();
    rooms.applyMove('u1', { from: { x: 1, y: 7 }, to: { x: 1, y: 5 } });
    rooms.undoRequest('u1');
    rooms.undoRespond('u2', false);
    const resp = lastEvent('s.undo.response');
    ok('对方收到拒绝回应', !!resp && resp.agree === false, JSON.stringify(resp));
    ok('对局未受影响（步数仍为 1）', lastEvent('s.game.move')?.game?.moveCount === 1);
  }

  console.log('[3] 走子超时判负（2 秒限时）');
  {
    sent.length = 0;
    newGame();
    // 红方先手，2 秒内不走子 → 红方超时判负
    await sleep(3200);
    const over = lastEvent('s.game.over');
    ok('超时后收到 GAME_OVER', !!over, JSON.stringify(over));
    ok('超时判负方为红方', over?.reason?.includes('超时'), over?.reason);
    ok('对手获胜', over?.winnerId === 'u2', `winner=${over?.winnerId}`);
    // 对局结束后不能再走子
    ok('结束后走子被拒', rooms.applyMove('u1', { from: { x: 1, y: 7 }, to: { x: 1, y: 5 } }).error === 'INVALID_MOVE');
  }

  console.log('[4] 对局中走子后重新计时（超时不触发）');
  {
    sent.length = 0;
    newGame();
    rooms.applyMove('u1', { from: { x: 1, y: 7 }, to: { x: 1, y: 5 } });
    await sleep(2600); // 红方已走，超过 2 秒但轮到黑方，黑方也应超时
    const over = lastEvent('s.game.over');
    ok('黑方超时判负', !!over && over.winnerId === 'u1', JSON.stringify(over));
  }

  console.log('[5] 人机模式：玩家走子 → 电脑自动回应 → 电脑不超时');
  {
    sent.length = 0;
    rooms.leaveRoom('u1');
    // 创建人机房间
    const c = rooms.createRoom(userA, { gameType: 'xiangqi', vsAI: true });
    ok('创建人机房间成功', c.ok === true, JSON.stringify(c));
    ok('房间模式为 ai', c.room.mode === 'ai');
    ok('电脑玩家已加入并就绪', c.room.players.length === 2 && c.room.players.some((p) => p.name === '电脑' && p.ready));
    // 其他玩家不能加入人机房间
    const joinDenied = rooms.joinRoom(userB, c.room.id);
    ok('人机房间拒绝其他玩家加入', joinDenied.error === 'BAD_REQUEST', JSON.stringify(joinDenied));
    // 玩家就绪并开始
    rooms.setReady('u1', true);
    rooms.startGame('u1');
    ok('人机对局开始', !!lastEvent('s.game.start'));

    // 玩家（红方）走一步
    rooms.applyMove('u1', { from: { x: 1, y: 7 }, to: { x: 1, y: 5 } });
    // 轮询等待电脑回应（引擎思考约 1.5-3 秒，玩家 2 秒限时内必须完成悔棋）
    let aiMove = null;
    for (let i = 0; i < 100 && !aiMove; i++) {
      aiMove = [...sent].reverse().find((e) => e.msg.type === 's.game.move' && e.msg.playerId === '__ai__');
      if (!aiMove) await sleep(100);
    }
    ok('电脑自动走了一步', !!aiMove, JSON.stringify(aiMove?.msg?.move));
    ok('电脑走法有着法', !!aiMove?.msg?.game?.moves?.at(-1)?.notation, aiMove?.msg?.game?.moves?.at(-1)?.notation);
    ok('电脑走完后轮到玩家', aiMove?.msg?.turn === 0, `turn=${aiMove?.msg?.turn}`);

    // 人机悔棋：无需对方同意，直接撤销（撤销的是电脑刚走的一步 → 轮到电脑）
    sent.length = 0;
    const undo = rooms.undoRequest('u1');
    ok('人机悔棋直接生效', undo.ok === true, JSON.stringify(undo));
    const undone = lastEvent('s.undo.done');
    ok('悔棋广播 UNDO_DONE', !!undone, JSON.stringify(undone));
    ok('悔棋后步数减一', undone?.game?.moveCount === 1, `moves=${undone?.game?.moveCount}`);
    ok('悔棋后轮到电脑', undone?.game?.turn === 1, `turn=${undone?.game?.turn}`);

    // 电脑回合：等待超过限时（2 秒）无超时判负，且电脑会重新思考走子
    await sleep(3000);
    const overDuringAi = lastEvent('s.game.over');
    ok('电脑回合不触发超时判负', !overDuringAi, JSON.stringify(overDuringAi));
    const aiMove2 = [...sent].reverse().find((e) => e.msg.type === 's.game.move' && e.msg.playerId === '__ai__');
    ok('悔棋后电脑重新走子', !!aiMove2, JSON.stringify(aiMove2?.msg?.move));
  }

  console.log('[6] 五子棋房间：建房 → 落子 → 五连结束');
  {
    sent.length = 0;
    rooms.leaveRoom('u1');
    rooms.leaveRoom('u2');
    const c = rooms.createRoom(userA, { gameType: 'gomoku' });
    ok('创建五子棋房间', c.ok === true && c.room.gameType === 'gomoku', JSON.stringify(c));
    rooms.joinRoom(userB, c.room.id);
    rooms.setReady('u1', true);
    rooms.setReady('u2', true);
    rooms.startGame('u1');
    ok('五子棋对局开始', lastEvent('s.game.start')?.game?.type === 'gomoku');

    const seq = [
      ['u1', 7, 7], ['u2', 0, 0],
      ['u1', 8, 7], ['u2', 0, 1],
      ['u1', 9, 7], ['u2', 0, 2],
      ['u1', 10, 7], ['u2', 0, 3],
      ['u1', 11, 7],
    ];
    let last = null;
    for (const [uid, x, y] of seq) last = rooms.applyMove(uid, { x, y });
    ok('黑方五连房间层判胜', last.ok === true, JSON.stringify(last));
    const over = lastEvent('s.game.over');
    ok('广播 GAME_OVER', !!over && over.winnerId === 'u1', JSON.stringify(over));
    ok('原因含五子连珠', over?.reason?.includes('五子连珠'));
  }

  console.log('[7] 五子棋人机：玩家落子后电脑回应');
  {
    sent.length = 0;
    rooms.leaveRoom('u1');
    const c = rooms.createRoom(userA, { gameType: 'gomoku', vsAI: true });
    ok('创建五子棋人机房', c.ok === true && c.room.mode === 'ai');
    rooms.setReady('u1', true);
    rooms.startGame('u1');
    rooms.applyMove('u1', { x: 7, y: 7 });
    let aiMove = null;
    for (let i = 0; i < 40 && !aiMove; i++) {
      aiMove = [...sent].reverse().find((e) => e.msg.type === 's.game.move' && e.msg.playerId === '__ai__');
      if (!aiMove) await sleep(50);
    }
    ok('五子棋电脑自动落子', !!aiMove, JSON.stringify(aiMove?.msg?.move));
    ok('电脑落在空点', aiMove?.msg?.move?.x !== 7 || aiMove?.msg?.move?.y !== 7);
  }

  console.log(`\n房间层测试：通过 ${passed} 项，失败 ${failed} 项`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('测试异常:', err);
  process.exit(1);
});
