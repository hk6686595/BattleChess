/**
 * 匹配系统：相同游戏类型的玩家两两配对，自动建房开局
 */
import { EVT, ERR, isValidGameType } from '../net/protocol.js';
import { config } from '../config.js';
import { logger } from '../log/logger.js';

export class Matchmaker {
  constructor(io, roomManager, getUser) {
    this.io = io;
    this.roomManager = roomManager;
    this.getUser = getUser; // (userId) => publicUser | null
    this.queue = new Map(); // userId -> { userId, name, gameType, queuedAt, timer }
  }

  /** 用户是否在队列中 */
  isQueued(userId) {
    return this.queue.has(userId);
  }

  /** 入队 */
  enqueue(user, gameType) {
    if (!isValidGameType(gameType)) {
      return { error: ERR.BAD_REQUEST, message: '未知的游戏类型' };
    }
    if (this.queue.has(user.id)) {
      return { error: ERR.ALREADY_MATCHING, message: '你已在匹配队列中' };
    }
    if (this.roomManager.inRoom(user.id)) {
      return { error: ERR.ALREADY_IN_ROOM, message: '请先离开当前房间' };
    }
    const entry = { userId: user.id, name: user.name, gameType, queuedAt: Date.now() };
    const timer = setTimeout(() => this._timeout(entry), config.matchTimeout);
    entry.timer = timer;
    this.queue.set(user.id, entry);

    this.io.send(user.id, {
      type: EVT.MATCH_QUEUED,
      gameType,
      position: this._positionOf(gameType, user.id),
      timeoutMs: config.matchTimeout,
    });
    this._tryPair();
    return { ok: true };
  }

  /** 出队 */
  dequeue(userId) {
    const entry = this.queue.get(userId);
    if (!entry) return { error: ERR.NOT_MATCHING, message: '你不在匹配队列中' };
    this._remove(entry);
    this.io.send(userId, { type: EVT.MATCH_LEFT });
    return { ok: true };
  }

  /** 移除某个用户（掉线/离开等场景） */
  removeUser(userId) {
    const entry = this.queue.get(userId);
    if (entry) this._remove(entry);
  }

  _remove(entry) {
    clearTimeout(entry.timer);
    this.queue.delete(entry.userId);
  }

  _timeout(entry) {
    if (!this.queue.has(entry.userId)) return;
    this._remove(entry);
    this.io.send(entry.userId, {
      type: EVT.MATCH_TIMEOUT,
      gameType: entry.gameType,
      message: '匹配超时，请重试',
    });
    logger.info('match', '匹配超时', { userId: entry.userId, name: entry.name, game: entry.gameType });
  }

  _positionOf(gameType, excludeUserId) {
    let pos = 0;
    for (const e of this.queue.values()) {
      if (e.gameType === gameType && e.userId !== excludeUserId) pos++;
    }
    return pos + 1;
  }

  /** 尝试配对 */
  _tryPair() {
    const byGame = new Map();
    for (const entry of this.queue.values()) {
      if (!byGame.has(entry.gameType)) byGame.set(entry.gameType, []);
      byGame.get(entry.gameType).push(entry);
    }
    for (const [gameType, entries] of byGame) {
      while (entries.length >= 2) {
        const a = entries.shift();
        const b = entries.shift();
        if (!this.queue.has(a.userId) || !this.queue.has(b.userId)) continue;
        this._pair(a, b);
      }
    }
  }

  /** 配对成功：建房、入房、开局 */
  _pair(a, b) {
    this._remove(a);
    this._remove(b);

    const userA = this.getUser(a.userId);
    const userB = this.getUser(b.userId);
    if (!userA || !userB) {
      // 用户已不存在（如掉线）则回填队列
      if (userA) this.enqueue(userA, a.gameType);
      if (userB) this.enqueue(userB, b.gameType);
      return;
    }

    const created = this.roomManager.createRoom(userA, {
      gameType: a.gameType,
      name: `${a.name} vs ${b.name}`,
      private: true, // 匹配对局不出现在列表
    });
    if (!created.ok) return;
    const joined = this.roomManager.joinRoom(userB, created.room.id, null);
    if (!joined.ok) {
      this.roomManager.leaveRoom(a.userId);
      return;
    }
    // 双方自动就绪并开始
    this.roomManager.setReady(a.userId, true);
    this.roomManager.setReady(b.userId, true);
    const started = this.roomManager.startGame(a.userId);
    if (!started.ok) {
      this.roomManager.leaveRoom(a.userId);
      this.roomManager.leaveRoom(b.userId);
      return;
    }

    this.io.send(a.userId, { type: EVT.MATCH_FOUND, room: created.room });
    this.io.send(b.userId, { type: EVT.MATCH_FOUND, room: joined.room });
    logger.info('match', '配对成功', {
      game: a.gameType,
      roomId: created.room.id,
      players: [a.name, b.name],
      queueSize: this.queue.size,
    });
  }
}
