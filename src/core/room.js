/**
 * 房间系统：创建 / 加入 / 离开 / 就绪 / 开始 / 观战 / 踢人 / 重开 / 快进
 *
 * 房间状态：
 *   status: 'waiting' | 'playing'
 *   players: 对局玩家（含 owner），spectators: 观战者（仅支持观战的游戏）
 *
 * 与外部解耦：通过 io 接口发送消息
 *   io.send(userId, msg)  /  io.sendToMany(userIds, msg)  /  io.broadcastAll(msg)
 */
import crypto from 'node:crypto';
import { ERR, EVT, GAME_TYPES, isValidGameType } from '../net/protocol.js';
import { getGame, listGameTypes } from '../games/index.js';
import { bestMove } from '../games/xiangqi-ai.js';
import { ucciEngine } from '../games/uci-engine.js';
import { config } from '../config.js';
import * as userApi from './user.js';
import { logger } from '../log/logger.js';

const ID_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const OFFLINE_GRACE_MS = 60_000;
/** 人机对局中电脑玩家的虚拟用户 ID */
const AI_USER_ID = '__ai__';
/** 电脑思考延迟范围（毫秒），模拟"思考"节奏 */
const AI_THINK_MIN = 500;
const AI_THINK_MAX = 1200;

function genRoomId() {
  let id = '';
  const bytes = crypto.randomBytes(6);
  for (const b of bytes) id += ID_CHARSET[b % ID_CHARSET.length];
  return id;
}

function genInviteCode() {
  return genRoomId().slice(0, 4);
}

export class RoomManager {
  constructor(io) {
    this.io = io;
    this.rooms = new Map(); // roomId -> room
    this.userRoom = new Map(); // userId -> roomId
    this._offlineTimers = new Map(); // userId -> timeout handle
  }

  listGameTypes() {
    return listGameTypes();
  }

  /** 对外可见房间列表（不含 private 房间） */
  listRooms() {
    const rooms = [];
    for (const room of this.rooms.values()) {
      if (room.private) continue;
      rooms.push(this._publicRoom(room));
    }
    return rooms.sort((a, b) => a.createdAt - b.createdAt);
  }

  _publicRoom(room) {
    const game = getGame(room.gameType);
    return {
      id: room.id,
      name: room.name,
      gameType: room.gameType,
      gameName: game ? game.name : room.gameType,
      hasPassword: !!room.password,
      status: room.status,
      playerCount: room.players.length,
      maxPlayers: room.maxPlayers,
      spectatorCount: room.spectators.length,
      ownerName: room.owner ? room.owner.name : '',
      createdAt: room.createdAt,
    };
  }

  /** 发给指定用户的完整房间视图 */
  _roomViewFor(room, userId) {
    const game = getGame(room.gameType);
    const view = {
      id: room.id,
      name: room.name,
      gameType: room.gameType,
      gameName: game ? game.name : room.gameType,
      hasPassword: !!room.password,
      status: room.status,
      ownerId: room.ownerId,
      maxPlayers: room.maxPlayers,
      mode: room.mode || 'pvp',
      players: room.players.map((p) => ({
        id: p.id,
        name: p.name,
        isOwner: p.id === room.ownerId,
        ready: p.ready,
        online: p.online,
      })),
      spectators: room.spectators.map((s) => ({ id: s.id, name: s.name, online: s.online })),
      createdAt: room.createdAt,
    };
    if (room.status === 'playing' && room.game) {
      view.game = game.serialize(room.game);
    }
    return view;
  }

  _broadcastRoom(room) {
    const memberIds = new Set([
      ...room.players.map((p) => p.id),
      ...room.spectators.map((s) => s.id),
    ]);
    const view = this._roomViewFor(room);
    this.io.sendToMany([...memberIds], { type: EVT.ROOM_UPDATE, room: view });
  }

  // ---------- 生命周期 ----------

  /** 创建房间（vsAI=true 时为单人模式，自动加入电脑玩家） */
  createRoom(user, opts = {}) {
    const gameType = opts.gameType || GAME_TYPES.GOMOKU;
    if (!isValidGameType(gameType)) {
      return { error: ERR.BAD_REQUEST, message: '未知的游戏类型' };
    }
    if (this.userRoom.has(user.id)) {
      return { error: ERR.ALREADY_IN_ROOM, message: '你已在其他房间中' };
    }
    const game = getGame(gameType);
    const id = genRoomId();
    const vsAI = !!opts.vsAI;
    const room = {
      id,
      inviteCode: genInviteCode(),
      name: (opts.name || (vsAI ? `${game.name}（人机）` : `${game.name}房间 #${id.slice(0, 4)}`)).slice(0, 24),
      gameType,
      maxPlayers: game.maxPlayers,
      password: opts.password || null,
      private: !!opts.private || vsAI, // 人机房间不出现在列表
      mode: vsAI ? 'ai' : 'pvp',
      aiId: vsAI ? AI_USER_ID : null,
      ownerId: user.id,
      status: 'waiting',
      players: [this._seat(user)],
      spectators: [],
      game: null,
      createdAt: Date.now(),
    };
    if (vsAI) {
      // 电脑玩家自动就绪，永远在线
      room.players.push({ id: AI_USER_ID, name: '电脑', ready: true, online: true });
    }
    this.rooms.set(id, room);
    this.userRoom.set(user.id, id);
    this._cancelOfflineTimer(user.id);
    logger.info('room', vsAI ? '创建人机房间' : '创建房间', { userId: user.id, roomId: id, game: gameType });
    return { ok: true, room: this._roomViewFor(room, user.id), inviteCode: room.inviteCode };
  }

  _seat(user) {
    return { id: user.id, name: user.name, ready: false, online: true };
  }

  /** 加入房间（含观战） */
  joinRoom(user, roomId, password) {
    const room = this.rooms.get(String(roomId || '').toUpperCase());
    if (!room) return { error: ERR.NOT_FOUND, message: '房间不存在' };
    if (room.mode === 'ai') {
      return { error: ERR.BAD_REQUEST, message: '这是人机对战房间，请创建自己的对局' };
    }
    if (this.userRoom.has(user.id)) {
      return { error: ERR.ALREADY_IN_ROOM, message: '你已在其他房间中' };
    }
    if (room.password && room.password !== password) {
      return { error: ERR.WRONG_PASSWORD, message: '房间密码错误' };
    }

    const game = getGame(room.gameType);
    // 对局进行中：仅支持观战的游戏可加入观战
    if (room.status === 'playing') {
      if (!game.supportsSpectate) {
        return { error: ERR.ROOM_FULL, message: '对局已开始，无法加入' };
      }
      if (room.spectators.length + room.players.length >= config.maxRoomMembers) {
        return { error: ERR.ROOM_FULL, message: '房间人数已满' };
      }
      room.spectators.push(this._seat(user));
      this.userRoom.set(user.id, room.id);
      this._cancelOfflineTimer(user.id);
      return { ok: true, room: this._roomViewFor(room, user.id), spectator: true };
    }

    // 等待中：作为玩家加入
    if (room.players.length >= room.maxPlayers) {
      return { error: ERR.ROOM_FULL, message: '房间已满' };
    }
    room.players.push(this._seat(user));
    this.userRoom.set(user.id, room.id);
    this._cancelOfflineTimer(user.id);
    this._broadcastRoom(room); // 通知房主与其他成员
    return { ok: true, room: this._roomViewFor(room, user.id), spectator: false };
  }

  /** 快进：随机加入一个等待中的房间 */
  quickJoin(user, gameType) {
    const candidates = [...this.rooms.values()].filter(
      (r) =>
        r.status === 'waiting' &&
        !r.password &&
        r.players.length < r.maxPlayers &&
        (!gameType || r.gameType === gameType)
    );
    if (candidates.length === 0) return { error: ERR.NOT_FOUND, message: '暂无可加入的房间' };
    const room = candidates[Math.floor(Math.random() * candidates.length)];
    return this.joinRoom(user, room.id, null);
  }

  /** 离开房间 */
  leaveRoom(userId) {
    const roomId = this.userRoom.get(userId);
    if (!roomId) return { ok: false };
    const room = this.rooms.get(roomId);
    if (!room) {
      this.userRoom.delete(userId);
      return { ok: true };
    }
    this._removeFromRoom(room, userId);
    return { ok: true, roomId };
  }

  /** 从房间中移除某用户（内部） */
  _removeFromRoom(room, userId) {
    const pIdx = room.players.findIndex((p) => p.id === userId);
    const sIdx = room.spectators.findIndex((s) => s.id === userId);
    if (pIdx === -1 && sIdx === -1) return;

    const member = pIdx !== -1 ? room.players[pIdx] : room.spectators[sIdx];
    if (pIdx !== -1) {
      room.players.splice(pIdx, 1);
      // 对局进行中玩家离开 => 对手直接获胜
      if (room.status === 'playing' && room.game && !room.game.over) {
        this._forfeit(room, userId, `${member.name} 离开房间`);
      }
      // 转移房主
      if (room.ownerId === userId && room.players.length > 0) {
        room.ownerId = room.players[0].id;
      }
    } else {
      room.spectators.splice(sIdx, 1);
    }
    this.userRoom.delete(userId);
    this._broadcastRoom(room);
    this._maybeRemoveRoom(room);
  }

  /** 无玩家时销毁房间 */
  _maybeRemoveRoom(room) {
    if (room.players.length === 0 && room.spectators.length === 0) {
      this.rooms.delete(room.id);
      logger.info('room', '房间已销毁（无成员）', { roomId: room.id, name: room.name });
      return true;
    }
    return false;
  }

  /** 用户离线处理：游客立即离开，正式用户宽限 60s 等待重连，超时后移除 */
  onUserOffline(userId, isGuest) {
    const roomId = this.userRoom.get(userId);
    if (!roomId) return;
    const room = this.rooms.get(roomId);
    if (!room) {
      this.userRoom.delete(userId);
      return;
    }
    const member = [...room.players, ...room.spectators].find((m) => m.id === userId);
    if (!member) {
      this.userRoom.delete(userId);
      return;
    }
    member.online = false;

    if (isGuest) {
      // 游客掉线：直接离房（对局中自动判负）
      logger.info('room', '游客掉线离开房间', { userId, roomId: room.id, name: member.name });
      this._removeFromRoom(room, userId);
      return;
    }
    this._broadcastRoom(room);
    logger.info('room', '用户掉线，等待重连（60 秒宽限）', { userId, roomId: room.id, name: member.name });
    // 宽限期内等待重连，超时后移除（对局中会自动判负）
    const timer = setTimeout(() => {
      this._offlineTimers.delete(userId);
      const cur = this.rooms.get(roomId);
      if (!cur) return;
      const still = [...cur.players, ...cur.spectators].find((m) => m.id === userId);
      if (!still || still.online) return;
      this._removeFromRoom(cur, userId);
    }, OFFLINE_GRACE_MS);
    this._offlineTimers.set(userId, timer);
  }

  /** 用户重连恢复 */
  onUserReconnect(userId) {
    const roomId = this.userRoom.get(userId);
    if (!roomId) return null;
    const room = this.rooms.get(roomId);
    if (!room) return null;
    const member = [...room.players, ...room.spectators].find((m) => m.id === userId);
    if (!member) return null;
    member.online = true;
    this._cancelOfflineTimer(userId);
    this._broadcastRoom(room);
    return this._roomViewFor(room, userId);
  }

  _cancelOfflineTimer(userId) {
    const t = this._offlineTimers.get(userId);
    if (t) {
      clearTimeout(t);
      this._offlineTimers.delete(userId);
    }
  }

  // ---------- 房间操作 ----------

  /** 就绪/取消就绪 */
  setReady(userId, ready) {
    const room = this._roomOf(userId);
    if (!room) return { error: ERR.NOT_IN_ROOM, message: '你不在房间中' };
    const seat = room.players.find((p) => p.id === userId);
    if (!seat) return { error: ERR.NOT_IN_ROOM, message: '观战者无需就绪' };
    if (room.status !== 'waiting') return { error: ERR.GAME_ALREADY_STARTED, message: '对局已开始' };
    seat.ready = !!ready;
    this._broadcastRoom(room);
    return { ok: true };
  }

  /** 房主开始对局 */
  startGame(userId) {
    const room = this._roomOf(userId);
    if (!room) return { error: ERR.NOT_IN_ROOM, message: '你不在房间中' };
    if (room.ownerId !== userId) return { error: ERR.NOT_OWNER, message: '只有房主可以开始' };
    if (room.status !== 'waiting') return { error: ERR.GAME_ALREADY_STARTED, message: '对局已开始' };
    const game = getGame(room.gameType);
    if (room.players.length < game.minPlayers) {
      return { error: ERR.BAD_REQUEST, message: `至少需要 ${game.minPlayers} 名玩家` };
    }
    if (!room.players.every((p) => p.ready)) {
      return { error: ERR.BAD_REQUEST, message: '还有玩家未就绪' };
    }
    room.status = 'playing';
    room.game = game.create(
      room.players.map((p) => ({ id: p.id, name: p.name })),
      { timeLimit: config.moveTimeLimit }
    );
    this._clearTurnTimer(room);
    this._clearUndoRequest(room);
    this._scheduleTurnTimeout(room);
    logger.info('room', '对局开始', { roomId: room.id, players: room.players.map((p) => p.name) });
    this._broadcastRoom(room);
    this.io.sendToMany(
      room.players.map((p) => p.id),
      { type: EVT.GAME_START, roomId: room.id, game: game.serialize(room.game) }
    );
    // 观战者同步棋盘
    if (room.spectators.length > 0) {
      this.io.sendToMany(
        room.spectators.map((s) => s.id),
        { type: EVT.GAME_STATE, roomId: room.id, game: game.serialize(room.game) }
      );
    }
    return { ok: true, roomId: room.id };
  }

  /** 踢人（房主） */
  kick(userId, targetId) {
    const room = this._roomOf(userId);
    if (!room) return { error: ERR.NOT_IN_ROOM, message: '你不在房间中' };
    if (room.ownerId !== userId) return { error: ERR.NOT_OWNER, message: '只有房主可以踢人' };
    if (targetId === userId) return { error: ERR.BAD_REQUEST, message: '不能踢自己' };
    const target = [...room.players, ...room.spectators].find((m) => m.id === targetId);
    if (!target) return { error: ERR.NOT_FOUND, message: '目标不在房间中' };
    this._removeFromRoom(room, targetId);
    this.io.send(targetId, { type: EVT.ROOM_LEFT, roomId: room.id, kicked: true });
    return { ok: true };
  }

  /** 落子 */
  applyMove(userId, move) {
    const room = this._roomOf(userId);
    if (!room) return { error: ERR.NOT_IN_ROOM, message: '你不在房间中' };
    if (!room.game || room.status !== 'playing') {
      return { error: ERR.GAME_NOT_STARTED, message: '对局尚未开始' };
    }
    const game = getGame(room.gameType);
    const result = game.applyMove(room.game, userId, move);
    if (!result.ok) {
      return { error: ERR.INVALID_MOVE, message: result.error };
    }
    const snapshot = game.serialize(room.game);
    if (result.gameOver) {
      this._finishGame(room, result);
      // GAME_OVER 消息中包含最终棋盘
      this.io.sendToMany(this._memberIds(room), {
        type: EVT.GAME_OVER,
        roomId: room.id,
        winnerId: result.winnerId,
        winnerName: result.winnerId
          ? room.players.find((p) => p.id === result.winnerId)?.name || ''
          : '',
        reason: result.reason,
        isDraw: result.isDraw,
        game: snapshot,
      });
      this._broadcastRoom(room);
    } else {
      // 本回合计时结束，为下一位玩家重新计时；清除未决的悔棋请求
      // 人机模式：若轮到电脑则触发 AI 走子（AI 回合不参与超时）
      this._clearTurnTimer(room);
      this._clearUndoRequest(room);
      this._scheduleAiMove(room);
      this._scheduleTurnTimeout(room);
      this.io.sendToMany(this._memberIds(room), {
        type: EVT.GAME_MOVE,
        roomId: room.id,
        playerId: userId,
        move: room.game.lastMove,
        turn: room.game.turn,
        game: snapshot,
      });
    }
    return { ok: true };
  }

  // ---------------- 悔棋 ----------------

  /** 请求悔棋（撤销最后一步，需对方同意） */
  undoRequest(userId) {
    const room = this._roomOf(userId);
    if (!room) return { error: ERR.NOT_IN_ROOM, message: '你不在房间中' };
    if (!room.game || room.status !== 'playing' || room.game.over) {
      return { error: ERR.GAME_NOT_STARTED, message: '对局尚未开始或已结束' };
    }
    const me = room.players.find((p) => p.id === userId);
    if (!me) return { error: ERR.BAD_REQUEST, message: '观战者不能请求悔棋' };
    if (room.game.moves.length === 0) {
      return { error: ERR.BAD_REQUEST, message: '还没有棋步可撤销' };
    }
    if (room.pendingUndo) {
      return { error: ERR.BAD_REQUEST, message: '已有悔棋请求在等待回应' };
    }
    const opponent = room.players.find((p) => p.id !== userId);
    if (!opponent) return { error: ERR.BAD_REQUEST, message: '找不到对手' };

    // 人机模式：电脑无需同意，直接撤销最后一步
    if (room.mode === 'ai') {
      const game = getGame(room.gameType);
      const result = game.undoLastMove(room.game);
      if (!result.ok) return { error: ERR.BAD_REQUEST, message: result.error };
      this._clearTurnTimer(room);
      this._clearAiTimer(room);
      this._scheduleAiMove(room);
      this._scheduleTurnTimeout(room);
      this.io.sendToMany(this._memberIds(room), {
        type: EVT.UNDO_DONE,
        roomId: room.id,
        byName: '电脑',
        game: game.serialize(room.game),
      });
      this._broadcastRoom(room);
      logger.info('game', '人机悔棋成功', { roomId: room.id, undone: result.notation });
      return { ok: true };
    }

    room.pendingUndo = {
      byId: userId,
      byName: me.name,
      timer: setTimeout(() => {
        // 对方 30 秒未回应，请求作废
        const cur = this.rooms.get(room.id);
        if (cur?.pendingUndo && cur.pendingUndo.byId === userId) {
          this._clearUndoRequest(cur);
          this.io.send(userId, { type: EVT.UNDO_CANCELLED, reason: '等待超时，悔棋请求已取消' });
        }
      }, config.undoRequestTimeout),
    };
    this.io.send(opponent.id, {
      type: EVT.UNDO_REQUESTED,
      byUserId: userId,
      byName: me.name,
    });
    this.io.send(userId, { type: EVT.UNDO_REQUESTED, byUserId: userId, byName: me.name, mine: true });
    logger.info('game', '悔棋请求', { roomId: room.id, by: me.name });
    return { ok: true };
  }

  /** 回应悔棋请求 */
  undoRespond(userId, agree) {
    const room = this._roomOf(userId);
    if (!room) return { error: ERR.NOT_IN_ROOM, message: '你不在房间中' };
    if (!room.pendingUndo) return { error: ERR.BAD_REQUEST, message: '当前没有悔棋请求' };
    if (room.pendingUndo.byId === userId) {
      return { error: ERR.BAD_REQUEST, message: '不能回应自己的悔棋请求' };
    }
    const responder = room.players.find((p) => p.id === userId);
    if (!responder) return { error: ERR.BAD_REQUEST, message: '观战者不能回应悔棋' };

    const request = room.pendingUndo;
    this._clearUndoRequest(room);

    if (!agree) {
      this.io.send(request.byId, { type: EVT.UNDO_RESPONSE, agree: false, byName: responder.name });
      logger.info('game', '悔棋被拒绝', { roomId: room.id, by: responder.name });
      return { ok: true };
    }

    // 同意：撤销最后一步
    const game = getGame(room.gameType);
    const result = game.undoLastMove(room.game);
    if (!result.ok) {
      this.io.send(request.byId, { type: EVT.UNDO_RESPONSE, agree: false, byName: responder.name, reason: result.error });
      return { error: ERR.BAD_REQUEST, message: result.error };
    }
    this._clearTurnTimer(room);
    this._clearAiTimer(room);
    this._scheduleAiMove(room);
    this._scheduleTurnTimeout(room);
    this.io.sendToMany(this._memberIds(room), {
      type: EVT.UNDO_DONE,
      roomId: room.id,
      byName: responder.name,
      game: game.serialize(room.game),
    });
    this._broadcastRoom(room);
    logger.info('game', '悔棋成功', { roomId: room.id, by: responder.name, undone: result.notation });
    return { ok: true };
  }

  _clearUndoRequest(room) {
    if (room.pendingUndo?.timer) {
      clearTimeout(room.pendingUndo.timer);
    }
    room.pendingUndo = null;
  }

  // ---------------- 走子倒计时（超时判负） ----------------

  _scheduleTurnTimeout(room) {
    if (!room.game || room.game.over) return;
    // 人机对局中，电脑回合不参与超时（由 AI 自己走子）
    if (room.mode === 'ai' && room.game.players[room.game.turn]?.id === room.aiId) {
      this._clearTurnTimer(room);
      return;
    }
    const limitMs = (room.game.timeLimit || config.moveTimeLimit) * 1000;
    this._clearTurnTimer(room);
    room.turnTimer = setTimeout(() => {
      const cur = this.rooms.get(room.id);
      if (!cur || !cur.game || cur.game.over || cur.status !== 'playing') return;
      const timedOut = cur.game.players[cur.game.turn];
      if (!timedOut) return;
      // 当前回合方超时未走子 → 判负
      const game = getGame(cur.gameType);
      const result = game.surrender(cur.game, timedOut.id);
      if (!result.ok) return;
      result.reason = `${timedOut.name} 走子超时`;
      this._finishGame(cur, result);
      this.io.sendToMany(this._memberIds(cur), {
        type: EVT.GAME_OVER,
        roomId: cur.id,
        winnerId: result.winnerId,
        winnerName: result.winnerId
          ? cur.players.find((p) => p.id === result.winnerId)?.name || ''
          : '',
        reason: result.reason,
        isDraw: result.isDraw,
        game: game.serialize(cur.game),
      });
      this._broadcastRoom(cur);
      logger.info('game', '超时判负', { roomId: cur.id, userId: timedOut.id, name: timedOut.name, limitMs });
    }, limitMs);
  }

  // ---------------- 人机模式：电脑走子 ----------------

  /** 若当前轮到电脑，安排一次 AI 走子（带思考延迟） */
  _scheduleAiMove(room) {
    if (room.mode !== 'ai' || !room.game || room.game.over) return;
    if (room.game.players[room.game.turn]?.id !== room.aiId) return;
    this._clearAiTimer(room);
    const delay = AI_THINK_MIN + Math.floor(Math.random() * (AI_THINK_MAX - AI_THINK_MIN));
    room.aiTimer = setTimeout(() => this._aiMove(room), delay);
    logger.debug('game', '电脑思考中', { roomId: room.id, delay });
  }

  _clearAiTimer(room) {
    if (room.aiTimer) {
      clearTimeout(room.aiTimer);
      room.aiTimer = null;
    }
  }

  /** 电脑走一步棋（优先 eleeye 引擎，失败回退内置 AI） */
  async _aiMove(room) {
    const cur = this.rooms.get(room.id);
    if (!cur || !cur.game || cur.game.over || cur.status !== 'playing') return;
    if (cur.game.players[cur.game.turn]?.id !== cur.aiId) return;

    const game = getGame(cur.gameType);
    const aiColor = cur.game.turn === 0 ? 'r' : 'b';
    const started = Date.now();

    // 1) 尝试 eleeye（象眼）引擎（side = 当前走棋方）
    let move = null;
    try {
      move = await ucciEngine.getBestMove(cur.game.board, aiColor, config.aiThinkMs);
    } catch (err) {
      logger.warn('game', '引擎调用异常，回退内置 AI', { roomId: cur.id, error: err.message });
    }

    // 2) 应用引擎走法；若被拒（理论上不应发生）则回退内置 AI 兜底，避免电脑卡住
    let result = null;
    if (move) {
      result = game.applyMove(cur.game, cur.aiId, move);
      if (!result.ok) {
        logger.warn('game', '引擎走法被拒，回退内置 AI', { roomId: cur.id, move, error: result.error });
        move = null;
      }
    }
    if (!move) {
      move = bestMove(cur.game.board, aiColor, 3);
      if (move) result = game.applyMove(cur.game, cur.aiId, move);
    }
    if (!result || !result.ok) {
      logger.warn('game', '电脑无合法走法', { roomId: cur.id });
      return;
    }
    const cost = Date.now() - started;
    logger.info('game', '电脑走子', { roomId: cur.id, move, notation: cur.game.lastMove?.notation, ms: cost, engine: 'eleeye' });

    if (result.gameOver) {
      this._finishGame(cur, result);
      this.io.sendToMany(this._memberIds(cur), {
        type: EVT.GAME_OVER,
        roomId: cur.id,
        winnerId: result.winnerId,
        winnerName: result.winnerId
          ? cur.players.find((p) => p.id === result.winnerId)?.name || ''
          : '',
        reason: result.reason,
        isDraw: result.isDraw,
        game: game.serialize(cur.game),
      });
      this._broadcastRoom(cur);
      return;
    }
    // 电脑走完，轮到玩家：重新计时并广播
    this._clearTurnTimer(cur);
    this._clearUndoRequest(cur);
    this._scheduleTurnTimeout(cur);
    this._scheduleAiMove(cur);
    this.io.sendToMany(this._memberIds(cur), {
      type: EVT.GAME_MOVE,
      roomId: cur.id,
      playerId: cur.aiId,
      move: cur.game.lastMove,
      turn: cur.game.turn,
      game: game.serialize(cur.game),
    });
  }

  _clearTurnTimer(room) {
    if (room.turnTimer) {
      clearTimeout(room.turnTimer);
      room.turnTimer = null;
    }
  }

  /** 认输 */
  surrender(userId) {
    const room = this._roomOf(userId);
    if (!room) return { error: ERR.NOT_IN_ROOM, message: '你不在房间中' };
    if (!room.game || room.status !== 'playing') {
      return { error: ERR.GAME_NOT_STARTED, message: '对局尚未开始' };
    }
    const game = getGame(room.gameType);
    const result = game.surrender(room.game, userId);
    if (!result.ok) return { error: ERR.BAD_REQUEST, message: result.error };
    this._finishGame(room, result);
    this.io.sendToMany(this._memberIds(room), {
      type: EVT.GAME_OVER,
      roomId: room.id,
      winnerId: result.winnerId,
      winnerName: result.winnerId
        ? room.players.find((p) => p.id === result.winnerId)?.name || ''
        : '',
      reason: result.reason,
      isDraw: result.isDraw,
      game: game.serialize(room.game),
    });
    this._broadcastRoom(room);
    return { ok: true };
  }

  /** 对局结束统一处理：计分、记录历史 */
  _finishGame(room, result) {
    const game = getGame(room.gameType);
    const snapshot = game.serialize(room.game);
    this._clearTurnTimer(room);
    this._clearUndoRequest(room);
    this._clearAiTimer(room);
    const playerIds = room.players.map((p) => p.id);
    // 人机对局：电脑不计入排行榜与战绩（电脑用户不存在于 store，applyMatchResult 会忽略）
    userApi.applyMatchResult(playerIds.filter((id) => id !== AI_USER_ID), result.winnerId, result.isDraw);
    userApi.recordMatch({
      gameType: room.gameType,
      players: room.players,
      winnerId: result.winnerId,
      isDraw: result.isDraw,
      reason: result.reason,
      moves: room.game.moves,
    });
    logger.info('game', '对局结束', {
      roomId: room.id,
      game: room.gameType,
      moves: room.game.moves.length,
      winnerId: result.winnerId,
      isDraw: result.isDraw,
      reason: result.reason,
      players: room.players.map((p) => ({ id: p.id, name: p.name })),
    });
    // 更新所有成员的评分/战绩显示
    const users = this._memberIds(room)
      .map((pid) => userApi.getUserById(pid))
      .filter(Boolean);
    if (users.length > 0) {
      this.io.sendToMany(
        users.map((u) => u.id),
        { type: EVT.RATING_UPDATE, users }
      );
    }
    return snapshot;
  }

  /** 重开一局（房主，且上局已结束） */
  restart(userId) {
    const room = this._roomOf(userId);
    if (!room) return { error: ERR.NOT_IN_ROOM, message: '你不在房间中' };
    if (room.ownerId !== userId) return { error: ERR.NOT_OWNER, message: '只有房主可以重开' };
    if (!room.game || !room.game.over) {
      return { error: ERR.BAD_REQUEST, message: '对局尚未结束' };
    }
    const game = getGame(room.gameType);
    room.game = game.create(room.players.map((p) => ({ id: p.id, name: p.name })), {
      timeLimit: config.moveTimeLimit,
    });
    for (const p of room.players) p.ready = false;
    // 电脑玩家保持就绪
    if (room.mode === 'ai') {
      const ai = room.players.find((p) => p.id === room.aiId);
      if (ai) ai.ready = true;
    }
    this._clearTurnTimer(room);
    this._clearUndoRequest(room);
    this._clearAiTimer(room);
    this._scheduleAiMove(room);
    this._scheduleTurnTimeout(room);
    this._broadcastRoom(room);
    this.io.sendToMany(this._memberIds(room), {
      type: EVT.GAME_RESTARTED,
      roomId: room.id,
      game: game.serialize(room.game),
    });
    return { ok: true, roomId: room.id };
  }

  /** 对局中玩家离开/掉线判负 */
  _forfeit(room, loserId, reason) {
    const game = getGame(room.gameType);
    const result = game.surrender(room.game, loserId);
    if (!result.ok) return;
    this._finishGame(room, result);
    this.io.sendToMany(this._memberIds(room), {
      type: EVT.GAME_OVER,
      roomId: room.id,
      winnerId: result.winnerId,
      winnerName: result.winnerId
        ? room.players.find((p) => p.id === result.winnerId)?.name || ''
        : '',
      reason: result.reason,
      isDraw: result.isDraw,
      game: game.serialize(room.game),
    });
  }

  // ---------- 工具 ----------

  _roomOf(userId) {
    const roomId = this.userRoom.get(userId);
    if (!roomId) return null;
    return this.rooms.get(roomId) || null;
  }

  _memberIds(room) {
    return [...room.players.map((p) => p.id), ...room.spectators.map((s) => s.id)];
  }

  /** 用户是否在房间中 */
  inRoom(userId) {
    return this.userRoom.has(userId);
  }

  /** 用户当前房间视图（供恢复用） */
  currentRoomView(userId) {
    const room = this._roomOf(userId);
    return room ? this._roomViewFor(room, userId) : null;
  }

  get roomCount() {
    return this.rooms.size;
  }
}
