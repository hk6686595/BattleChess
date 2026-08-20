/**
 * WebSocket 网关：连接管理、鉴权、消息路由、心跳、聊天
 */
import { WebSocketServer } from 'ws';
import { config } from '../config.js';
import { EVT, REQ, ERR } from '../net/protocol.js';
import * as userApi from '../core/user.js';
import { RoomManager } from '../core/room.js';
import { Matchmaker } from '../core/matchmaker.js';
import { logger } from '../log/logger.js';

const LOBBY_CHAT_HISTORY = 50;

export class Gateway {
  constructor(httpServer) {
    this.wss = new WebSocketServer({ server: httpServer, path: '/ws' });
    this.sockets = new Map(); // userId -> Set<ws>
    this.wsUser = new Map(); // ws -> userId
    this.wsAlive = new Map(); // ws -> boolean

    this.lobbyChat = []; // { from, text, ts }
    this.rankings = [];

    // io 接口（供 RoomManager / Matchmaker 使用）
    const io = {
      send: (userId, msg) => this.sendToUser(userId, msg),
      sendToMany: (userIds, msg) => this.sendToUsers(userIds, msg),
      broadcastAll: (msg) => this.broadcastAll(msg),
    };
    this.rooms = new RoomManager(io);
    this.matchmaker = new Matchmaker(io, this.rooms, (id) => userApi.getUserById(id));

    this._bind();
    this._refreshRankings();
    setInterval(() => this._refreshRankings(), 30_000).unref();
  }

  _bind() {
    this.wss.on('connection', (ws, req) => this._onConnection(ws, req));
  }

  // ---------------- 连接 ----------------

  _onConnection(ws, req) {
    const ip = req?.socket?.remoteAddress || 'unknown';
    this.wsAlive.set(ws, true);
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    ws.on('message', (data) => this._onMessage(ws, data));
    ws.on('close', () => this._onClose(ws));
    ws.on('error', (err) => {
      logger.warn('ws', '连接异常', { ip, error: err.message });
      this._onClose(ws);
    });

    logger.info('ws', '新连接建立', { ip, total: this.wss.clients.size });
    globalThis.__onlineUsers = this.sockets.size;
    ws.send(JSON.stringify({
      type: EVT.WELCOME,
      server: '对战平台',
      version: '1.0.0',
      games: this.rooms.listGameTypes(),
      requiresAuth: true,
    }));
  }

  // ---------------- 鉴权 ----------------

  _authSocket(ws, user, token, reconnectToken = null) {
    // 若该 socket 已绑定其他用户，先解绑（切换账号场景）
    const oldUserId = this.wsUser.get(ws);
    if (oldUserId && oldUserId !== user.id) {
      this._detachSocket(ws, oldUserId);
    }

    // 单端登录：同一账号只允许一个在线连接。
    // 新设备登录时踢掉旧连接；同一令牌的旧连接视为同一客户端断线重连，静默关闭即可。
    const existing = this.sockets.get(user.id);
    if (existing && existing.size > 0) {
      for (const oldWs of [...existing]) {
        if (oldWs === ws) continue;
        if (reconnectToken && oldWs.token === reconnectToken) {
          try { oldWs.close(4000, 'reconnect'); } catch { /* 忽略 */ }
        } else {
          this._kickSocket(oldWs, '您的账号已在其他设备登录，请重新登录');
        }
      }
    }

    this.wsUser.set(ws, user.id);
    ws.token = token;
    if (!this.sockets.has(user.id)) this.sockets.set(user.id, new Set());
    this.sockets.get(user.id).add(ws);

    // 断线重连恢复房间
    let room = this.rooms.onUserReconnect(user.id);
    if (!room) room = this.rooms.currentRoomView(user.id);
    const matching = this.matchmaker.isQueued(user.id)
      ? { gameType: this.matchmaker.queue.get(user.id).gameType }
      : null;

    this.sendToUser(user.id, { type: EVT.AUTH_OK, user, token });
    this.sendToUser(user.id, {
      type: EVT.ME_STATE,
      user,
      room,
      matching,
    });
    this.sendToUser(user.id, { type: EVT.ROOM_LIST, rooms: this.rooms.listRooms() });
    if (room && room.status === 'playing' && room.game) {
      // 重连者立即拿到最新棋盘
    }
    this._broadcastLobbyChat();
    this._pushChat({ from: '系统', text: `${user.name} 进入大厅`, ts: Date.now(), scope: 'lobby' });
    this._refreshRankings();
    logger.info('auth', '鉴权成功', {
      userId: user.id,
      name: user.name,
      isGuest: user.isGuest,
      resumedRoom: room?.id ?? null,
      onlineSockets: this.sockets.get(user.id)?.size ?? 1,
    });
  }

  _detachSocket(ws, userId) {
    const set = this.sockets.get(userId);
    if (set) {
      set.delete(ws);
      if (set.size === 0) this.sockets.delete(userId);
    }
    this.wsUser.delete(ws);
    if (!this.sockets.has(userId)) {
      // 该用户已无在线连接
      this.matchmaker.removeUser(userId);
      const u = userApi.getUserById(userId);
      this.rooms.onUserOffline(userId, u?.isGuest ?? true);
    }
  }

  /** 顶号下线：先推送提示，再关闭连接（4001 = 被其他设备顶号） */
  _kickSocket(ws, message) {
    try {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: EVT.AUTH_KICKED, message }));
      }
      ws.close(4001, 'kicked');
    } catch {
      try { ws.terminate(); } catch { /* 忽略 */ }
    }
  }

  /** 管理员删除账号：把该账号所有在线连接顶下线（客户端会清除令牌并回到登录页） */
  kickUserAll(userId, message = '账号已被管理员删除，请重新注册') {
    const set = this.sockets.get(userId);
    if (!set) return;
    for (const ws of [...set]) {
      this._kickSocket(ws, message);
    }
  }

  _onClose(ws) {
    const userId = this.wsUser.get(ws);
    if (userId) {
      const u = userApi.getUserById(userId);
      this._detachSocket(ws, userId);
      if (u) this._pushChat({ from: '系统', text: `${u.name} 离开大厅`, ts: Date.now(), scope: 'lobby' });
      this._broadcastLobbyChat();
      logger.info('ws', '连接断开', {
        userId,
        name: u?.name ?? '?',
        remainingSockets: this.sockets.get(userId)?.size ?? 0,
        total: this.wss.clients.size,
      });
      globalThis.__onlineUsers = this.sockets.size;
    } else {
      logger.debug('ws', '未鉴权连接断开', { total: this.wss.clients.size });
    }
    this.wsAlive.delete(ws);
  }

  // ---------------- 消息路由 ----------------

  _onMessage(ws, data) {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return this._send(ws, { type: EVT.ERROR, code: ERR.BAD_REQUEST, message: '消息不是合法 JSON' });
    }
    const type = msg.type;
    const userId = this.wsUser.get(ws);
    logger.debug('ws', '收到请求', { type, userId: userId ?? null });

    // 鉴权请求无条件处理：允许在已登录状态下重新鉴权（如退出后再次登录/切换账号）
    switch (type) {
      case REQ.AUTH_REGISTER:
        return this._handleRegister(ws, msg);
      case REQ.AUTH_LOGIN:
        return this._handleLogin(ws, msg);
      case REQ.AUTH_GUEST:
        return this._handleGuest(ws);
    }

    // 其余请求需要先鉴权
    if (!userId) {
      return this._send(ws, { type: EVT.ERROR, code: ERR.AUTH_REQUIRED, message: '请先登录' });
    }

    const user = userApi.getUserById(userId);
    if (!user) {
      return this._send(ws, { type: EVT.ERROR, code: ERR.AUTH_FAILED, message: '账号不存在' });
    }

    switch (type) {
      case REQ.ME:
        return this._handleMe(user);
      case REQ.ROOM_LIST:
        return this._send(ws, { type: EVT.ROOM_LIST, rooms: this.rooms.listRooms() });
      case REQ.ROOM_CREATE:
        return this._handleRoomCreate(user, msg);
      case REQ.ROOM_JOIN:
        return this._handleRoomJoin(user, msg);
      case REQ.ROOM_QUICK_JOIN:
        return this._handleQuickJoin(user, msg);
      case REQ.ROOM_LEAVE:
        return this._handleRoomLeave(user);
      case REQ.ROOM_READY:
        return this._handleReady(user, msg);
      case REQ.ROOM_START:
        return this._handleStart(user);
      case REQ.ROOM_KICK:
        return this._handleKick(user, msg);
      case REQ.MATCH_ENQUEUE:
        return this._handleMatchEnqueue(user, msg);
      case REQ.MATCH_DEQUEUE:
        return this._handleMatchDequeue(user);
      case REQ.GAME_MOVE:
        return this._handleMove(user, msg);
      case REQ.GAME_RESTART:
        return this._handleRestart(user);
      case REQ.GAME_SURRENDER:
        return this._handleSurrender(user);
      case REQ.GAME_UNDO_REQUEST:
        return this._handleUndoRequest(user);
      case REQ.GAME_UNDO_RESPOND:
        return this._handleUndoRespond(user, msg);
      case REQ.CHAT_SEND:
        return this._handleChat(user, msg);
      case REQ.RANKING_GET:
        return this._send(ws, { type: EVT.RANKING, rankings: this.rankings });
      case REQ.MATCHES_GET:
        return this._handleMatchesGet(user, msg);
      default:
        return this._send(ws, { type: EVT.ERROR, code: ERR.BAD_REQUEST, message: `未知请求: ${type}` });
    }
  }

  _handleRegister(ws, msg) {
    const { user, error } = userApi.registerUser(msg.name, msg.password);
    if (error) {
      logger.warn('auth', '注册失败', { name: msg.name, error });
      return this._send(ws, { type: EVT.ERROR, code: error, message: msg.message || '注册失败' });
    }
    // 顶号策略：新登录前吊销该账号旧令牌（新注册账号无旧令牌，无副作用）
    userApi.revokeAllTokens(user.id);
    const token = userApi.issueSession(user.id);
    this._authSocket(ws, user, token);
    logger.info('auth', '新用户注册', { userId: user.id, name: user.name });
  }

  _handleLogin(ws, msg) {
    let user = null;
    let viaToken = false;
    let reconnectToken = null;
    if (typeof msg.token === 'string' && msg.token) {
      viaToken = true;
      reconnectToken = msg.token;
      const uid = userApi.resolveToken(msg.token);
      if (uid) user = userApi.getUserById(uid);
    } else if (msg.name && msg.password) {
      const res = userApi.loginUser(msg.name, msg.password);
      if (!res.error) user = res.user;
    }
    if (!user) {
      logger.warn('auth', '登录失败', { name: msg.name ?? '(token)', viaToken });
      if (viaToken) {
        // 令牌失效（已过期 / 被其他设备顶号）：让客户端清除本地令牌并重新登录
        return this._send(ws, { type: EVT.ERROR, code: ERR.AUTH_TOKEN_INVALID, message: '登录状态已失效，请重新登录' });
      }
      return this._send(ws, { type: EVT.ERROR, code: ERR.AUTH_FAILED, message: '登录失败，请检查昵称/密码' });
    }
    // 顶号策略：新登录前吊销该账号旧令牌，使旧设备无法再自动重登
    userApi.revokeAllTokens(user.id);
    const token = userApi.issueSession(user.id);
    this._authSocket(ws, user, token, reconnectToken);
    logger.info('auth', '用户登录', { userId: user.id, name: user.name, viaToken });
  }

  _handleGuest(ws) {
    const { user } = userApi.createGuest();
    userApi.revokeAllTokens(user.id); // 游客为全新账号，无旧令牌
    const token = userApi.issueSession(user.id);
    this._authSocket(ws, user, token);
    logger.info('auth', '游客进入', { userId: user.id, name: user.name });
  }

  _handleMe(user) {
    const room = this.rooms.currentRoomView(user.id);
    const matching = this.matchmaker.isQueued(user.id)
      ? { gameType: this.matchmaker.queue.get(user.id).gameType }
      : null;
    this.sendToUser(user.id, { type: EVT.ME_STATE, user, room, matching });
  }

  _handleRoomCreate(user, msg) {
    const res = this.rooms.createRoom(user, {
      gameType: msg.gameType,
      name: msg.name,
      password: msg.password || null,
      private: !!msg.private,
      vsAI: !!msg.vsAI,
    });
    if (!res.ok) {
      logger.warn('room', '创建房间失败', { userId: user.id, error: res.error, message: res.message });
      return this._sendError(user.id, res.error, res.message);
    }
    // 若之前在匹配队列，需退出
    this.matchmaker.removeUser(user.id);
    this.sendToUser(user.id, { type: EVT.ROOM_JOINED, room: res.room, inviteCode: res.inviteCode });
    this._refreshRoomsForLobby();
    logger.info('room', '创建房间', { userId: user.id, roomId: res.room.id, game: res.room.gameType });
  }

  _handleRoomJoin(user, msg) {
    const res = this.rooms.joinRoom(user, msg.roomId, msg.password);
    if (!res.ok) {
      logger.warn('room', '加入房间失败', { userId: user.id, roomId: msg.roomId, error: res.error, message: res.message });
      return this._sendError(user.id, res.error, res.message);
    }
    this.matchmaker.removeUser(user.id);
    this.sendToUser(user.id, {
      type: EVT.ROOM_JOINED,
      room: res.room,
      spectator: res.spectator,
    });
    this._refreshRoomsForLobby();
    logger.info('room', '加入房间', { userId: user.id, name: user.name, roomId: res.room.id, spectator: !!res.spectator });
  }

  _handleQuickJoin(user, msg) {
    const res = this.rooms.quickJoin(user, msg.gameType);
    if (!res.ok) {
      logger.warn('room', '快速加入失败', { userId: user.id, error: res.error, message: res.message });
      return this._sendError(user.id, res.error, res.message);
    }
    this.matchmaker.removeUser(user.id);
    this.sendToUser(user.id, { type: EVT.ROOM_JOINED, room: res.room, spectator: res.spectator });
    this._refreshRoomsForLobby();
    logger.info('room', '快速加入', { userId: user.id, roomId: res.room.id });
  }

  _handleRoomLeave(user) {
    const res = this.rooms.leaveRoom(user.id);
    if (res.ok) {
      this.sendToUser(user.id, { type: EVT.ROOM_LEFT, roomId: res.roomId });
      this._refreshRoomsForLobby();
      logger.info('room', '离开房间', { userId: user.id, roomId: res.roomId });
    }
  }

  _handleReady(user, msg) {
    const res = this.rooms.setReady(user.id, !!msg.ready);
    if (!res.ok) {
      logger.warn('room', '就绪操作失败', { userId: user.id, error: res.error, message: res.message });
      return this._sendError(user.id, res.error, res.message);
    }
    logger.debug('room', '就绪状态', { userId: user.id, ready: !!msg.ready });
  }

  _handleStart(user) {
    const res = this.rooms.startGame(user.id);
    if (!res.ok) {
      logger.warn('room', '开始对局失败', { userId: user.id, error: res.error, message: res.message });
      return this._sendError(user.id, res.error, res.message);
    }
    this._refreshRoomsForLobby();
    logger.info('room', '开始对局', { roomId: res.roomId ?? null, userId: user.id });
  }

  _handleKick(user, msg) {
    const res = this.rooms.kick(user.id, msg.targetId);
    if (!res.ok) {
      logger.warn('room', '踢人失败', { userId: user.id, targetId: msg.targetId, error: res.error, message: res.message });
      return this._sendError(user.id, res.error, res.message);
    }
    logger.info('room', '踢出玩家', { operatorId: user.id, targetId: msg.targetId });
  }

  _handleMatchEnqueue(user, msg) {
    const res = this.matchmaker.enqueue(user, msg.gameType);
    if (!res.ok) {
      logger.warn('match', '匹配入队失败', { userId: user.id, error: res.error, message: res.message });
      return this._sendError(user.id, res.error, res.message);
    }
    logger.info('match', '进入匹配队列', { userId: user.id, name: user.name, game: msg.gameType });
  }

  _handleMatchDequeue(user) {
    this.matchmaker.dequeue(user.id);
    logger.info('match', '退出匹配队列', { userId: user.id });
  }

  _handleMove(user, msg) {
    const res = this.rooms.applyMove(user.id, msg.move);
    if (!res.ok) {
      logger.warn('game', '走子被拒', { userId: user.id, move: msg.move, error: res.error, message: res.message });
      return this._sendError(user.id, res.error, res.message);
    }
    logger.debug('game', '走子', { userId: user.id, move: msg.move, gameOver: res.gameOver ?? false });
  }

  _handleRestart(user) {
    const res = this.rooms.restart(user.id);
    if (!res.ok) {
      logger.warn('game', '重开失败', { userId: user.id, error: res.error, message: res.message });
      return this._sendError(user.id, res.error, res.message);
    }
    logger.info('game', '重开一局', { userId: user.id, roomId: res.roomId ?? null });
  }

  _handleSurrender(user) {
    const res = this.rooms.surrender(user.id);
    if (!res.ok) {
      logger.warn('game', '认输失败', { userId: user.id, error: res.error, message: res.message });
      return this._sendError(user.id, res.error, res.message);
    }
    logger.info('game', '认输', { userId: user.id, name: user.name });
  }

  _handleUndoRequest(user) {
    const res = this.rooms.undoRequest(user.id);
    if (!res.ok) {
      logger.warn('game', '悔棋请求失败', { userId: user.id, error: res.error, message: res.message });
      return this._sendError(user.id, res.error, res.message);
    }
  }

  _handleUndoRespond(user, msg) {
    const res = this.rooms.undoRespond(user.id, !!msg.agree);
    if (!res.ok) {
      logger.warn('game', '悔棋回应失败', { userId: user.id, error: res.error, message: res.message });
      return this._sendError(user.id, res.error, res.message);
    }
  }

  _handleMatchesGet(user, msg) {
    const targetId = msg.userId || user.id;
    const limit = Math.min(Number(msg.limit) || 50, 200);
    const matches = userApi
      .getUserMatches(targetId, limit)
      .map((m) => userApi.buildMatchView(m, user.id));
    this.sendToUser(user.id, { type: EVT.MATCHES, matches });
    logger.debug('match', '查询个人战绩', { userId: user.id, targetId, count: matches.length });
  }

  _handleChat(user, msg) {
    const text = String(msg.text || '').trim().slice(0, 200);
    if (!text) return;
    const scope = msg.scope === 'room' ? 'room' : 'lobby';
    if (scope === 'room' && !this.rooms.inRoom(user.id)) {
      return this._sendError(user.id, ERR.NOT_IN_ROOM, '你不在房间中');
    }
    const chat = { from: user.name, fromId: user.id, text, ts: Date.now(), scope };
    if (scope === 'room') {
      const roomId = this.rooms.userRoom.get(user.id);
      const room = this.rooms.rooms.get(roomId);
      if (!room) return;
      this.sendToUsers(
        [...room.players.map((p) => p.id), ...room.spectators.map((s) => s.id)],
        { type: EVT.CHAT, ...chat }
      );
    } else {
      this.lobbyChat.push(chat);
      if (this.lobbyChat.length > LOBBY_CHAT_HISTORY) this.lobbyChat.shift();
      this.broadcastAll({ type: EVT.CHAT, ...chat });
    }
    logger.debug('chat', `${scope} 聊天`, { userId: user.id, from: user.name, text: text.slice(0, 60) });
  }

  // ---------------- 发送 ----------------

  _send(ws, msg) {
    if (ws.readyState === ws.OPEN) {
      try {
        ws.send(JSON.stringify(msg));
      } catch {
        /* 忽略 */
      }
    }
  }

  sendToUser(userId, msg) {
    const set = this.sockets.get(userId);
    if (!set) return;
    for (const ws of set) this._send(ws, msg);
  }

  sendToUsers(userIds, msg) {
    for (const id of userIds) this.sendToUser(id, msg);
  }

  broadcastAll(msg) {
    for (const set of this.sockets.values()) {
      for (const ws of set) this._send(ws, msg);
    }
  }

  _sendError(userId, code, message) {
    this.sendToUser(userId, { type: EVT.ERROR, code, message });
    logger.debug('ws', '下发错误', { userId, code, message });
  }

  // ---------------- 大厅数据刷新 ----------------

  _refreshRoomsForLobby() {
    this.broadcastAll({ type: EVT.ROOM_LIST, rooms: this.rooms.listRooms() });
  }

  _refreshRankings() {
    this.rankings = userApi.getLeaderboard(config.leaderboardTop);
    this.broadcastAll({ type: EVT.RANKING, rankings: this.rankings });
  }

  _broadcastLobbyChat() {
    this.broadcastAll({ type: EVT.CHAT_HISTORY, messages: this.lobbyChat });
  }

  _pushChat(chat) {
    this.lobbyChat.push(chat);
    if (this.lobbyChat.length > LOBBY_CHAT_HISTORY) this.lobbyChat.shift();
  }

  // ---------------- 心跳 ----------------

  startHeartbeat() {
    const timer = setInterval(() => {
      for (const ws of this.wss.clients) {
        if (!ws.isAlive) {
          ws.terminate();
          continue;
        }
        ws.isAlive = false;
        try {
          ws.ping();
        } catch {
          ws.terminate();
        }
      }
    }, config.heartbeatInterval);
    timer.unref();
    this._heartbeatTimer = timer;
  }

  stop() {
    if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);
    for (const ws of this.wss.clients) {
      try {
        ws.close(1001, 'server shutdown');
      } catch {
        /* 忽略 */
      }
    }
    this.wss.close();
  }
}
