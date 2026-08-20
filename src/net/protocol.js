/**
 * WebSocket 消息协议定义
 *
 * 所有消息均为 JSON：{ type: string, ...payload }
 * 服务端主动推送的 type 前缀为 "s."（server），客户端请求为普通字符串。
 */

/** 错误码 */
export const ERR = {
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  AUTH_FAILED: 'AUTH_FAILED',
  AUTH_TOKEN_INVALID: 'AUTH_TOKEN_INVALID', // 令牌失效（已过期 / 被其他设备顶号）
  NAME_TAKEN: 'NAME_TAKEN',
  NAME_INVALID: 'NAME_INVALID',
  PASSWORD_INVALID: 'PASSWORD_INVALID',
  NOT_FOUND: 'NOT_FOUND',
  ALREADY_IN_ROOM: 'ALREADY_IN_ROOM',
  ROOM_FULL: 'ROOM_FULL',
  ROOM_LOCKED: 'ROOM_LOCKED',
  WRONG_PASSWORD: 'WRONG_PASSWORD',
  NOT_IN_ROOM: 'NOT_IN_ROOM',
  NOT_OWNER: 'NOT_OWNER',
  NOT_YOUR_TURN: 'NOT_YOUR_TURN',
  INVALID_MOVE: 'INVALID_MOVE',
  GAME_NOT_STARTED: 'GAME_NOT_STARTED',
  GAME_ALREADY_STARTED: 'GAME_ALREADY_STARTED',
  ALREADY_MATCHING: 'ALREADY_MATCHING',
  NOT_MATCHING: 'NOT_MATCHING',
  BAD_REQUEST: 'BAD_REQUEST',
};

/**
 * 服务端 → 客户端 事件类型
 */
export const EVT = {
  WELCOME: 's.welcome',                 // 连接建立
  AUTH_OK: 's.auth.ok',                 // 登录成功 { user, token }
  ROOM_LIST: 's.room.list',             // 房间列表 { rooms }
  ROOM_JOINED: 's.room.joined',         // 加入房间 { room }
  ROOM_LEFT: 's.room.left',             // 离开房间 { roomId }
  ROOM_UPDATE: 's.room.update',         // 房间状态变化 { room }
  GAME_START: 's.game.start',           // 游戏开始 { roomId, game }
  GAME_STATE: 's.game.state',           // 游戏状态同步 { roomId, game }
  GAME_MOVE: 's.game.move',             // 走子 { playerId, move, turn, game }
  GAME_OVER: 's.game.over',             // 游戏结束 { winnerId, winnerName, reason, isDraw, game }
  GAME_RESTARTED: 's.game.restarted',   // 重开一局
  UNDO_REQUESTED: 's.undo.requested',   // 悔棋请求 { byUserId, byName, mine? }
  UNDO_RESPONSE: 's.undo.response',     // 悔棋回应 { agree, byName }
  UNDO_DONE: 's.undo.done',             // 悔棋成功（已撤销一步）{ byName, game }
  UNDO_CANCELLED: 's.undo.cancelled',   // 悔棋请求作废 { reason }
  RATING_UPDATE: 's.rating.update',     // 对局后评分/战绩更新 { users }
  MATCH_FOUND: 's.match.found',         // 匹配成功 { room }
  MATCH_QUEUED: 's.match.queued',       // 已进入队列 { gameType, position }
  MATCH_TIMEOUT: 's.match.timeout',     // 匹配超时
  MATCH_LEFT: 's.match.left',           // 退出队列
  CHAT: 's.chat',                       // 聊天 { from, text, ts, scope }
  CHAT_HISTORY: 's.chat.history',       // 大厅聊天历史 { messages }
  RANKING: 's.ranking',                 // 排行榜 { rankings }
  MATCHES: 's.matches',                 // 历史对局列表 { matches }
  ME_STATE: 's.me.state',               // 用户当前状态快照 { user, room, matching }
  AUTH_KICKED: 's.auth.kicked',         // 账号在其他设备登录，本连接被顶下线 { message }
  ERROR: 's.error',                     // 错误 { code, message }
};

/**
 * 客户端 → 服务端 请求类型
 */
export const REQ = {
  AUTH_REGISTER: 'auth.register',
  AUTH_LOGIN: 'auth.login',
  AUTH_GUEST: 'auth.guest',
  ME: 'me',

  ROOM_LIST: 'room.list',
  ROOM_CREATE: 'room.create',
  ROOM_JOIN: 'room.join',
  ROOM_LEAVE: 'room.leave',
  ROOM_READY: 'room.ready',
  ROOM_START: 'room.start',
  ROOM_KICK: 'room.kick',
  ROOM_QUICK_JOIN: 'room.quickJoin',

  MATCH_ENQUEUE: 'match.enqueue',
  MATCH_DEQUEUE: 'match.dequeue',

  GAME_MOVE: 'game.move',
  GAME_RESTART: 'game.restart',
  GAME_SURRENDER: 'game.surrender',
  GAME_UNDO_REQUEST: 'game.undoRequest',
  GAME_UNDO_RESPOND: 'game.undoRespond',

  CHAT_SEND: 'chat.send',
  RANKING_GET: 'ranking.get',
  MATCHES_GET: 'matches.get', // 查询个人历史对局 { userId? }
};

/** 可创建房间的游戏类型（当前仅中国象棋） */
export const GAME_TYPES = {
  XIANGQI: 'xiangqi',
};

export const GAME_NAMES = {
  [GAME_TYPES.XIANGQI]: '中国象棋',
};

export function isValidGameType(type) {
  return type === GAME_TYPES.XIANGQI;
}
