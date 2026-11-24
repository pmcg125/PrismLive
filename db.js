'use strict';

/**
 * PrismLive SQLite 数据层
 * 使用 Node.js 内置 node:sqlite (Node >= 22.5, 无需任何原生编译依赖)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new DatabaseSync(path.join(DATA_DIR, 'prismlive.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS blacklist (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ident      TEXT NOT NULL UNIQUE,
    type       TEXT NOT NULL DEFAULT 'name',
    note       TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS stats (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// ---------- 密码哈希 (scrypt, 零依赖) ----------

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

// ---------- settings (key-value) ----------

function seedDefaults() {
  const salt = crypto.randomBytes(16).toString('hex');
  const defaults = {
    liveTitle: 'PrismLive 直播间',
    liveAnnouncement: '欢迎来到直播间，请文明发言~',
    liveEnabled: 'true',
    danmakuEnabled: 'true',
    danmakuRateLimit: '5',
    sensitiveWords: '',
    streamKey: crypto.randomBytes(16).toString('hex'),
    adminPasswordHash: hashPassword('admin123', salt),
    adminPasswordSalt: salt,
    hlsBaseUrl: '',
    flvBaseUrl: '',
    // 播放引擎: hls=HLS(兼容, 默认) / flv=HTTP-FLV(低延迟, SRS)
    playEngine: 'hls',
  };
  const has = (k) => db.prepare('SELECT 1 FROM settings WHERE key = ?').get(k);
  for (const [k, v] of Object.entries(defaults)) {
    if (!has(k)) {
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(k, v);
    }
  }
}

seedDefaults();

// ---------- settings (带内存缓存) ----------

// 设置值内存缓存: 避免高频查询 (如后台轮询) 反复打 SQLite。
// 缓存通过 setSetting 写时失效，seedDefaults 后填充首值。
const settingCache = new Map();
for (const row of db.prepare('SELECT key, value FROM settings').all()) {
  settingCache.set(row.key, row.value);
}

function getSetting(key) {
  if (settingCache.has(key)) return settingCache.get(key);
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  const v = row ? row.value : null;
  settingCache.set(key, v);
  return v;
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
  settingCache.set(key, String(value));
}

// ---------- stats (key-value, 持久化统计) ----------

function getStat(key) {
  const row = db.prepare('SELECT value FROM stats WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setStat(key, value) {
  db.prepare(
    'INSERT INTO stats (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

// ---------- blacklist ----------

function listBlacklist() {
  return db.prepare('SELECT * FROM blacklist ORDER BY id DESC').all();
}

function addBlacklist(ident, type, note) {
  return db
    .prepare('INSERT INTO blacklist (ident, type, note, created_at) VALUES (?, ?, ?, ?)')
    .run(ident, type, note || '', Date.now());
}

function removeBlacklist(id) {
  return db.prepare('DELETE FROM blacklist WHERE id = ?').run(id);
}

function isBlacklisted(ident) {
  return !!db.prepare('SELECT 1 FROM blacklist WHERE ident = ?').get(ident);
}

module.exports = {
  db,
  getSetting,
  setSetting,
  getStat,
  setStat,
  listBlacklist,
  addBlacklist,
  removeBlacklist,
  isBlacklisted,
  hashPassword,
};
