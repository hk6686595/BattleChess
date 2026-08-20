/**
 * 用户系统：注册 / 登录 / 游客 / 会话令牌 / 积分
 *
 * 密码使用 crypto.scrypt 加盐哈希；会话令牌为随机 32 字节 hex。
 * 用户对象：{ id, name, passwordHash?, salt?, isGuest, rating, wins, losses, draws,
 *            createdAt, lastSeen }
 */
import crypto from 'node:crypto';
import { store } from '../db/store.js';
import { config, paths } from '../config.js';

const NAME_RE = /^[\w\u4e00-\u9fa5-]{2,16}$/;

function now() {
  return Date.now();
}

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 32).toString('hex');
  return { salt, hash };
}

export function verifyPassword(password, salt, expectedHash) {
  const { hash } = hashPassword(password, salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(expectedHash, 'hex'));
}

export function validateName(name) {
  if (typeof name !== 'string') return false;
  return NAME_RE.test(name);
}

export function validatePassword(pw) {
  return typeof pw === 'string' && pw.length >= 4 && pw.length <= 64;
}

/** 创建正式用户 */
export function registerUser(name, password) {
  if (!validateName(name)) {
    return { error: 'NAME_INVALID', message: '昵称需为 2-16 位中文/字母/数字/下划线/连字符' };
  }
  if (!validatePassword(password)) {
    return { error: 'PASSWORD_INVALID', message: '密码长度需为 4-64 位' };
  }
  const existing = Object.values(store.data.users).find(
    (u) => !u.isGuest && u.name.toLowerCase() === name.toLowerCase()
  );
  if (existing) {
    return { error: 'NAME_TAKEN', message: '该昵称已被注册' };
  }
  const { salt, hash } = hashPassword(password);
  const id = String(store.data.nextUserId++);
  const user = {
    id,
    name,
    passwordHash: hash,
    salt,
    isGuest: false,
    rating: 1000,
    wins: 0,
    losses: 0,
    draws: 0,
    createdAt: now(),
    lastSeen: now(),
  };
  store.data.users[id] = user;
  store.touch();
  return { user: publicUser(user) };
}

/** 登录：返回 { user } 或 { error } */
export function loginUser(name, password) {
  const user = Object.values(store.data.users).find(
    (u) => !u.isGuest && u.name.toLowerCase() === name.toLowerCase()
  );
  if (!user || !verifyPassword(password, user.salt, user.passwordHash)) {
    return { error: 'AUTH_FAILED', message: '昵称或密码错误' };
  }
  user.lastSeen = now();
  store.touch();
  return { user: publicUser(user) };
}

/** 游客账号：每次进入随机取名，不入排行榜（仅临时体验） */
export function createGuest() {
  const id = String(store.data.nextUserId++);
  const name = `游客${1000 + Math.floor(Math.random() * 9000)}`;
  const user = {
    id,
    name,
    isGuest: true,
    rating: 1000,
    wins: 0,
    losses: 0,
    draws: 0,
    createdAt: now(),
    lastSeen: now(),
  };
  store.data.users[id] = user;
  store.touch();
  return { user: publicUser(user) };
}

export function getUserById(id) {
  const u = store.data.users[id];
  return u ? publicUser(u) : null;
}

/** 对外暴露的用户信息（不含敏感字段） */
export function publicUser(u) {
  return {
    id: u.id,
    name: u.name,
    isGuest: u.isGuest,
    rating: u.rating,
    wins: u.wins,
    losses: u.losses,
    draws: u.draws,
    createdAt: u.createdAt,
  };
}

/** 生成会话令牌 */
export function createToken() {
  return crypto.randomBytes(32).toString('hex');
}

/** 对局结束后更新积分（ELO，K=32）与胜负统计 */
export function applyMatchResult(playerIds, winnerId, isDraw) {
  const players = playerIds.map((id) => store.data.users[id]).filter(Boolean);
  if (players.length < 2) return;

  if (isDraw) {
    for (const p of players) {
      p.draws += 1;
    }
  } else {
    const winner = store.data.users[winnerId];
    const loser = players.find((p) => p.id !== winnerId);
    if (winner && loser) {
      const expW = 1 / (1 + Math.pow(10, (loser.rating - winner.rating) / 400));
      const expL = 1 / (1 + Math.pow(10, (winner.rating - loser.rating) / 400));
      winner.rating = Math.round(winner.rating + 32 * (1 - expW));
      loser.rating = Math.round(loser.rating + 32 * (0 - expL));
      winner.wins += 1;
      loser.losses += 1;
    }
  }
  for (const p of players) p.lastSeen = now();
  store.touch();
}

/** 记录一局历史 */
export function recordMatch({ gameType, players, winnerId, isDraw, moves, reason }) {
  const rec = {
    id: store.data.nextMatchId++,
    ts: now(),
    gameType,
    players: players.map((p) => ({ id: p.id, name: p.name, rating: p.rating })),
    winnerId: isDraw ? null : winnerId,
    isDraw,
    reason,
    moveCount: moves.length,
  };
  store.data.matches.push(rec);
  store.touch();
  return rec;
}

export function getRecentMatches(limit = 20) {
  return store.data.matches.slice(-limit).reverse();
}

/** 查询指定用户的个人历史对局（按时间倒序） */
export function getUserMatches(userId, limit = 50) {
  return store.data.matches
    .filter((m) => m.players.some((p) => p.id === userId))
    .slice(-limit)
    .reverse();
}

/** 为客户端整理对局记录视图（含胜负归属） */
export function buildMatchView(m, viewerId) {
  const me = m.players.find((p) => p.id === viewerId);
  const opp = m.players.find((p) => p.id !== viewerId);
  let result = '平局';
  if (!m.isDraw) result = m.winnerId === viewerId ? '胜' : '负';
  return {
    id: m.id,
    ts: m.ts,
    gameType: m.gameType,
    result,
    moveCount: m.moveCount,
    reason: m.reason,
    opponent: opp ? { id: opp.id, name: opp.name, rating: opp.rating } : null,
    players: m.players,
  };
}

/** 排行榜：按积分排序，游客不参与 */
export function getLeaderboard(limit = config.leaderboardTop) {
  return Object.values(store.data.users)
    .filter((u) => !u.isGuest)
    .sort((a, b) => b.rating - a.rating || b.wins - a.wins)
    .slice(0, limit)
    .map((u, i) => ({ rank: i + 1, ...publicUser(u) }));
}

// ---------------- 管理后台查询 ----------------

/** 管理后台：创建正式用户（昵称/密码校验 + 查重，与注册规则一致） */
export function adminCreateUser(name, password) {
  if (!validateName(name)) {
    return { error: 'NAME_INVALID', message: '昵称需为 2-16 位中文/字母/数字/下划线/连字符' };
  }
  if (!validatePassword(password)) {
    return { error: 'PASSWORD_INVALID', message: '密码长度需为 4-64 位' };
  }
  const existing = Object.values(store.data.users).find(
    (u) => !u.isGuest && u.name.toLowerCase() === name.toLowerCase()
  );
  if (existing) {
    return { error: 'NAME_TAKEN', message: '该昵称已被注册' };
  }
  const { salt, hash } = hashPassword(password);
  const id = String(store.data.nextUserId++);
  const user = {
    id,
    name,
    passwordHash: hash,
    salt,
    isGuest: false,
    rating: 1000,
    wins: 0,
    losses: 0,
    draws: 0,
    createdAt: now(),
    lastSeen: now(),
  };
  store.data.users[id] = user;
  store.touch();
  return { user: publicUser(user) };
}

/** 管理后台：删除用户（正式/游客均可；保留其历史对局记录，账号随即无法登录） */
export function adminDeleteUser(userId) {
  const u = store.data.users[userId];
  if (!u) return { error: 'NOT_FOUND', message: '用户不存在' };
  revokeAllTokens(userId); // 使该账号全部会话令牌立即失效
  store.deleteUser(userId);
  return { ok: true, id: u.id, name: u.name, isGuest: u.isGuest };
}

/** 管理后台：用户列表（昵称搜索 + 分页，注册时间倒序） */
export function adminListUsers({ search = '', page = 1, pageSize = 20 } = {}) {
  let list = Object.values(store.data.users);
  const kw = String(search || '').trim().toLowerCase();
  if (kw) {
    list = list.filter((u) => u.name.toLowerCase().includes(kw) || u.id === kw);
  }
  list.sort((a, b) => b.createdAt - a.createdAt);
  const total = list.length;
  const start = (Number(page) - 1) * Number(pageSize);
  const users = list.slice(start, start + Number(pageSize)).map((u) => ({
    id: u.id,
    name: u.name,
    isGuest: u.isGuest,
    rating: u.rating,
    wins: u.wins,
    losses: u.losses,
    draws: u.draws,
    createdAt: u.createdAt,
    lastSeen: u.lastSeen,
  }));
  return { total, page: Number(page), pageSize: Number(pageSize), users };
}

/** 管理后台：对局列表（分页，最新在前） */
export function adminListMatches({ page = 1, pageSize = 20 } = {}) {
  const list = [...store.data.matches].reverse();
  const total = list.length;
  const start = (Number(page) - 1) * Number(pageSize);
  const matches = list.slice(start, start + Number(pageSize)).map((m) => ({
    id: m.id,
    ts: m.ts,
    gameType: m.gameType,
    players: m.players.map((p) => ({ id: p.id, name: p.name })),
    winnerId: m.winnerId,
    isDraw: m.isDraw,
    reason: m.reason,
    moveCount: m.moveCount,
  }));
  return { total, page: Number(page), pageSize: Number(pageSize), matches };
}

/** 管理后台：统计概览 */
export function adminStats() {
  const users = Object.values(store.data.users);
  return {
    totalUsers: users.length,
    registeredUsers: users.filter((u) => !u.isGuest).length,
    guestUsers: users.filter((u) => u.isGuest).length,
    totalMatches: store.data.matches.length,
    onlineUsers: globalThis.__onlineUsers ?? 0,
    dbFile: paths.dbFile,
  };
}

/** 创建/登录成功后签发会话（同一账号新登录会吊销旧令牌，保证单端在线） */
export function issueSession(userId) {
  const token = createToken();
  const sessions = globalThis.__sessions ??= new Map();
  sessions.set(token, { userId, expiresAt: Date.now() + config.sessionTtl });
  const userTokens = globalThis.__userTokens ??= new Map(); // userId -> Set<token>
  if (!userTokens.has(userId)) userTokens.set(userId, new Set());
  userTokens.get(userId).add(token);
  return token;
}

/** 校验会话令牌，返回 userId 或 null */
export function resolveToken(token) {
  if (typeof token !== 'string') return null;
  const sessions = globalThis.__sessions ??= new Map();
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expiresAt) {
    sessions.delete(token);
    globalThis.__userTokens?.get(s.userId)?.delete(token);
    return null;
  }
  return s.userId;
}

export function revokeToken(token) {
  const sessions = globalThis.__sessions;
  if (!sessions) return;
  const s = sessions.get(token);
  if (s) {
    globalThis.__userTokens?.get(s.userId)?.delete(token);
    sessions.delete(token);
  }
}

/** 吊销某账号全部会话令牌（顶号时调用，使旧设备的令牌立即失效） */
export function revokeAllTokens(userId) {
  const userTokens = globalThis.__userTokens;
  if (!userTokens) return;
  const set = userTokens.get(userId);
  if (!set || set.size === 0) return;
  const sessions = globalThis.__sessions;
  for (const t of set) sessions?.delete(t);
  set.clear();
  userTokens.delete(userId);
}
