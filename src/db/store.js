/**
 * 数据持久化：SQLite（Node 内置 node:sqlite，零外部依赖）
 *
 * 内存缓存 + 同步落盘：业务代码通过 store.data 读写（与原 JSON 版兼容），
 * 每次修改后调用 touch() 立即同步写入 SQLite（ACID，无需原子写/防抖）。
 *
 * 表：
 *   users   用户（含游客）
 *   matches 历史对局（仅保留最近 500 条）
 */
import { DatabaseSync } from 'node:sqlite';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config, paths } from '../config.js';
import { logger } from '../log/logger.js';

const MAX_MATCHES = 500;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  password_hash TEXT,
  salt          TEXT,
  is_guest      INTEGER NOT NULL DEFAULT 0,
  rating        INTEGER NOT NULL DEFAULT 1000,
  wins          INTEGER NOT NULL DEFAULT 0,
  losses        INTEGER NOT NULL DEFAULT 0,
  draws         INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  last_seen     INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS matches (
  id         INTEGER PRIMARY KEY,
  ts         INTEGER NOT NULL,
  game_type  TEXT NOT NULL,
  players    TEXT NOT NULL,
  winner_id  TEXT,
  is_draw    INTEGER NOT NULL DEFAULT 0,
  reason     TEXT,
  move_count INTEGER NOT NULL DEFAULT 0
);
`;

class SqliteStore {
  constructor() {
    this.db = null;
    this._checkpointTimer = null;
    this.data = {
      users: {},      // id -> user（camelCase，与业务代码一致）
      matches: [],    // 最近对局
      nextUserId: 1,
      nextMatchId: 1,
    };
  }

  /** 打开数据库、建表、加载数据 */
  async init() {
    await fsp.mkdir(config.dataDir, { recursive: true });
    this.db = new DatabaseSync(paths.dbFile);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
    this._load();
    // 周期自动 checkpoint：把 WAL 定期合并进主文件，
    // 避免主文件 platform.db 长时间不更新（便于直接查看/备份，即使强杀也不丢数据）
    this._checkpointTimer = setInterval(() => {
      try {
        this.db?.prepare('PRAGMA wal_checkpoint(PASSIVE)').get();
      } catch { /* 忽略：下次再试 */ }
    }, 10_000);
    this._checkpointTimer.unref?.();
    logger.info('store', 'SQLite 数据加载完成', {
      file: paths.dbFile,
      users: Object.keys(this.data.users).length,
      matches: this.data.matches.length,
    });
  }

  _load() {
    // 用户
    const rows = this.db.prepare('SELECT * FROM users').all();
    const users = {};
    for (const r of rows) {
      users[String(r.id)] = {
        id: String(r.id),
        name: r.name,
        passwordHash: r.password_hash ?? undefined,
        salt: r.salt ?? undefined,
        isGuest: !!r.is_guest,
        rating: r.rating,
        wins: r.wins,
        losses: r.losses,
        draws: r.draws,
        createdAt: r.created_at,
        lastSeen: r.last_seen,
      };
    }
    this.data.users = users;
    this.data.nextUserId = rows.length ? Math.max(...rows.map((r) => r.id)) + 1 : 1;

    // 对局（最近 500 条，按时间正序）
    const mrows = this.db
      .prepare('SELECT * FROM matches ORDER BY id DESC LIMIT ?')
      .all(MAX_MATCHES)
      .reverse();
    this.data.matches = mrows.map((r) => ({
      id: r.id,
      ts: r.ts,
      gameType: r.game_type,
      players: JSON.parse(r.players),
      winnerId: r.winner_id ?? null,
      isDraw: !!r.is_draw,
      reason: r.reason ?? null,
      moveCount: r.move_count,
    }));
    this.data.nextMatchId = mrows.length ? Math.max(...mrows.map((r) => r.id)) + 1 : 1;
  }

  /** 删除用户（内存 + SQLite 同步删除，避免重启后复活） */
  deleteUser(id) {
    delete this.data.users[id];
    if (!this.db) return;
    try {
      this.db.prepare('DELETE FROM users WHERE id = ?').run(Number(id));
    } catch (err) {
      logger.error('store', 'SQLite 删除用户失败', { error: err.message });
      throw err;
    }
  }

  /** 将内存状态同步写入 SQLite（业务代码在修改后调用） */
  touch() {
    if (!this.db) return;
    this.db.exec('BEGIN');
    try {
      const upsertUser = this.db.prepare(`
        INSERT INTO users (id, name, password_hash, salt, is_guest, rating, wins, losses, draws, created_at, last_seen)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          password_hash = excluded.password_hash,
          salt = excluded.salt,
          is_guest = excluded.is_guest,
          rating = excluded.rating,
          wins = excluded.wins,
          losses = excluded.losses,
          draws = excluded.draws,
          created_at = excluded.created_at,
          last_seen = excluded.last_seen
      `);
      for (const u of Object.values(this.data.users)) {
        upsertUser.run(
          Number(u.id), u.name, u.passwordHash ?? null, u.salt ?? null,
          u.isGuest ? 1 : 0, u.rating, u.wins, u.losses, u.draws,
          u.createdAt, u.lastSeen
        );
      }

      const upsertMatch = this.db.prepare(`
        INSERT INTO matches (id, ts, game_type, players, winner_id, is_draw, reason, move_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          ts = excluded.ts,
          game_type = excluded.game_type,
          players = excluded.players,
          winner_id = excluded.winner_id,
          is_draw = excluded.is_draw,
          reason = excluded.reason,
          move_count = excluded.move_count
      `);
      const recent = this.data.matches.slice(-MAX_MATCHES);
      for (const m of recent) {
        upsertMatch.run(
          m.id, m.ts, m.gameType, JSON.stringify(m.players),
          m.winnerId ?? null, m.isDraw ? 1 : 0, m.reason ?? null, m.moveCount
        );
      }
      // 清理超出保留上限的历史对局
      this.db.exec(`DELETE FROM matches WHERE id NOT IN (SELECT id FROM matches ORDER BY id DESC LIMIT ${MAX_MATCHES})`);
      this.db.exec('COMMIT');
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* 忽略 */ }
      logger.error('store', 'SQLite 写入失败', { error: err.message });
      throw err;
    }
  }

  /** 立即落盘（保持 API 兼容） */
  async flushNow() {
    this.touch();
  }

  /** 关闭数据库（先落盘 + 完整合并 WAL 到主文件） */
  async close() {
    this.touch();
    try {
      this.db?.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    } catch { /* 忽略 */ }
    if (this._checkpointTimer) {
      clearInterval(this._checkpointTimer);
      this._checkpointTimer = null;
    }
    try { this.db?.close(); } catch { /* 忽略 */ }
    this.db = null;
  }
}

export const store = new SqliteStore();

export { DatabaseSync };
