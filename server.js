'use strict';

/**
 * PrismLive 主服务
 * - :8083 观众端 (页面 + Socket.IO 弹幕 + API)
 * - :8084 中控后台 (设置 + 数据看板 + 认证)
 * 依赖外部 MediaMTX (RTMP 收流 :1935, HLS 分发 :8888, 控制 API :9997)
 */

const path = require('path');
const crypto = require('crypto');
const os = require('os');
const http = require('http');

const express = require('express');
const { Server } = require('socket.io');

const db = require('./db');

// ==================== 常量 ====================

const PORT_WEB = Number(process.env.PORT_WEB) || 8083;
const PORT_ADMIN = Number(process.env.PORT_ADMIN) || 8084;
// 绑定地址：默认 127.0.0.1 仅本机访问；公网部署请通过反向代理，或显式设 HOST=0.0.0.0
const HOST = process.env.HOST || '127.0.0.1';
const MTX_API = (process.env.MTX_API || 'http://127.0.0.1:9997').replace(/\/+$/, '');
// SRS API (HTTP-FLV 引擎的推流状态探测, 与 MediaMTX 轮询并行, 互不阻塞)
const SRS_API = (process.env.SRS_API || 'http://127.0.0.1:1986').replace(/\/+$/, '');
const SRS_FETCH_TIMEOUT_MS = 500; // 探测超时: 失败静默置 false, 不拖慢主轮询
const ADMIN_TOKEN_TTL = 24 * 3600 * 1000;
const DANMAKU_MAX_LEN = 100;
const DANMAKU_USER_COOLDOWN_MS = 800;       // 单用户弹幕冷却
const DANMAKU_GLOBAL_WINDOW_MS = 1000;      // 全局速率窗口
const DANMAKU_RATE_MULTIPLIER = 1;          // danmakuRateLimit 即每秒全局上限
const CHAT_LIST_MAX = 100;                  // 观众端聊天列表上限
const MTX_POLL_INTERVAL_MS = 5000;
const MTX_FETCH_TIMEOUT_MS = 3000;
const ADMIN_STATS_INTERVAL_MS = 2000;
const STATS_PERSIST_INTERVAL_MS = 60000;
const ADMIN_TOKEN_SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const LOGIN_MAX_FAILS = 5;                  // 窗口内失败 5 次锁定
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_LOCK_MS = 10 * 60 * 1000;
// QQ 信息缓存: qq -> { nickname, avatarUrl, fetchedAt }
const qqInfoCache = new Map();
const QQ_INFO_CACHE_TTL = 60 * 60 * 1000;       // 1 小时
const QQ_INFO_CACHE_MAX = 500;                    // 最多缓存 500 条
// QQ 信息接口限频: ip -> { count, windowStart }
const qqInfoRateLimit = new Map();
const QQ_INFO_RATE_WINDOW_MS = 60 * 1000;        // 1 分钟窗口
const QQ_INFO_RATE_MAX = 10;                      // 每窗口最多 10 次
// 弹幕允许的颜色白名单 (避免任意颜色注入)
const DANMAKU_COLORS = ['#ffffff', '#ff4d6d', '#fb7299', '#7c5cff', '#22d3ee', '#22c55e', '#faad14', '#ff8c00'];

// ==================== 内存态 ====================

// 推流状态 (轮询刷新): MediaMTX 与 SRS 双探测, streaming = 任一活跃
const live = {
  streaming: false,
  mtxStreaming: false,   // MediaMTX 侧活跃 (HLS 链路)
  srsStreaming: false,   // SRS 侧活跃 (HTTP-FLV 链路)
  bitrate: 0,          // kbps (估算)
  readers: 0,          // 媒体层读者数
  mtxVersion: null,    // MediaMTX 版本 (v1.20 起 /v3/sysinfo 改为 /v3/info，仅含版本信息)
  lastCheck: null,
  bytesLast: 0,
  bytesAt: 0,
  streamStartAt: 0,    // 本次推流开始时间戳 (0=未推流), 用于推流时长
  totalBytes: 0,       // 本次推流累计上行字节数 (推流结束不清零, 供面板展示)
  mtxReachable: false, // MediaMTX API 最近一次探测是否可达
  srsReachable: false, // SRS API 最近一次探测是否可达
};

// 平台统计
const stats = {
  online: 0,
  peakOnline: 0,
  todayViews: 0,
  totalDanmaku: 0,
  totalLikes: 0,         // 累计点赞数 (持久化)
  danmakuTs: [],       // 最近弹幕时间戳 (环形缓冲，算速率)
  danmakuHead: 0,      // 环形缓冲头指针
  danmakuPerMin: 0,
  startedAt: Date.now(),
  today: todayStr(),
};

// 弹幕时间戳环形缓冲: 固定容量，避免无限增长
const DANMAKU_TS_CAPACITY = 2048;
const danmakuTsBuffer = new Array(DANMAKU_TS_CAPACITY).fill(0);
let danmakuTsHead = 0;
let danmakuTsCount = 0;

// 弹幕历史 (内存环形缓冲): join 时下发给新观众, 推流关闭时清空
const DANMAKU_HISTORY_MAX = 200;
const danmakuHistory = [];

function recordDanmaku(item) {
  danmakuHistory.push(item);
  if (danmakuHistory.length > DANMAKU_HISTORY_MAX) danmakuHistory.shift();
}

function clearDanmakuHistory() {
  danmakuHistory.length = 0;
}

// 点赞频率限制: 单用户 500ms 冷却, 防连点刷屏
const LIKE_USER_COOLDOWN_MS = 500;
const LIKE_GLOBAL_WINDOW_MS = 1000;
const LIKE_GLOBAL_MAX_PER_SEC = 30;   // 全局每秒最多 30 赞 (防机器人)
const LIKE_TS_CAPACITY = 512;
const likeTsBuffer = new Array(LIKE_TS_CAPACITY).fill(0);
let likeTsHead = 0;
let likeTsCount = 0;

function pushLikeTs(ts) {
  likeTsBuffer[likeTsHead] = ts;
  likeTsHead = (likeTsHead + 1) % LIKE_TS_CAPACITY;
  if (likeTsCount < LIKE_TS_CAPACITY) likeTsCount += 1;
}

function countRecentLikes() {
  const cutoff = now() - LIKE_GLOBAL_WINDOW_MS;
  let n = 0;
  // head 指向下一个写入位，最新元素在 head-1，从最新往旧遍历
  for (let i = 0; i < likeTsCount; i++) {
    const idx = (likeTsHead - 1 - i + LIKE_TS_CAPACITY) % LIKE_TS_CAPACITY;
    if (likeTsBuffer[idx] > cutoff) n += 1;
    else break; // 从最新往前，遇到 ≤ cutoff 即停止（时间戳单调）
  }
  return n;
}

// 从持久化恢复统计 (按天)
// 注意: 若服务跨天运行, stats.today 可能是昨天日期, 这里强制对齐当前日期,
// 避免 db.setStat('statsDay', 昨天) 导致次日恢复误判
(function restoreStats() {
  stats.today = todayStr();
  if (db.getStat('statsDay') === stats.today) {
    stats.todayViews = Number(db.getStat('todayViews') || 0);
    stats.peakOnline = Number(db.getStat('peakOnline') || 0);
    stats.totalDanmaku = Number(db.getStat('totalDanmaku') || 0);
    stats.totalLikes = Number(db.getStat('totalLikes') || 0);
  }
  db.setStat('statsDay', stats.today);
})();

// 后台登录 token -> 过期时间
const adminTokens = new Map();

// 登录防爆破: ip -> { fails, firstAt, lockedUntil }
const loginGuard = new Map();

// 过期 token 清理 (防止 Map 无限增长)
setInterval(() => {
  const t = now();
  for (const [k, exp] of adminTokens) {
    if (exp < t) adminTokens.delete(k);
  }
  // 顺便清理过期的 loginGuard 记录
  for (const [ip, g] of loginGuard) {
    if (g.lockedUntil && g.lockedUntil < t && now() - g.firstAt > LOGIN_WINDOW_MS) {
      loginGuard.delete(ip);
    }
  }
}, ADMIN_TOKEN_SWEEP_INTERVAL_MS).unref();

// ==================== 工具 ====================

const now = () => Date.now();

// 本地日期 (YYYY-MM-DD)，用于按天重置统计
function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// CPU 使用率采样: 两次采样间隔的繁忙时间占比
let _cpuPrev = null; // { idle, total, time }
function cpuUsage() {
  const cpus = os.cpus();
  let idle = 0, total = 0;
  for (const c of cpus) {
    idle += c.times.idle;
    total += c.times.idle + c.times.user + c.times.nice + c.times.sys + c.times.irq;
  }
  let usage = 0;
  if (_cpuPrev) {
    const dIdle = idle - _cpuPrev.idle;
    const dTotal = total - _cpuPrev.total;
    if (dTotal > 0) usage = Math.round((1 - dIdle / dTotal) * 100);
  }
  _cpuPrev = { idle, total, time: now() };
  return Math.max(0, Math.min(100, usage));
}

// 本机内网 IPv4 (非回环), 供面板展示 OBS 推流地址参考
function localIPv4() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const f of ifaces[name] || []) {
      if (f.family === 'IPv4' && !f.internal) return f.address;
    }
  }
  return '127.0.0.1';
}

function sysInfo() {
  const mem = process.memoryUsage();
  return {
    node: process.version,
    platform: os.platform(),
    arch: os.arch(),
    memTotalMB: Math.round(os.totalmem() / 1024 / 1024),
    memFreeMB: Math.round(os.freemem() / 1024 / 1024),
    serviceUptime: Math.round((now() - stats.startedAt) / 1000),
    processUptime: Math.round(process.uptime()),
    cpuUsage: cpuUsage(),
    cpuCount: os.cpus().length,
    cpuModel: (os.cpus()[0] && os.cpus()[0].model) || 'unknown',
    processRssMB: Math.round(mem.rss / 1024 / 1024),
    processHeapMB: Math.round(mem.heapUsed / 1024 / 1024),
    localIP: localIPv4(),
  };
}

function hostFrom(headers) {
  return String((headers && headers.host) || 'localhost').split(':')[0];
}

function clientIp(req) {
  return (
    String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket.remoteAddress ||
    'unknown'
  );
}

function hlsUrlFor(host, headers) {
  const key = db.getSetting('streamKey');
  const custom = (db.getSetting('hlsBaseUrl') || '').trim();
  // 自定义地址中的 <key> 占位符替换为实际流密钥
  if (custom) {
    const url = custom.split('<key>').join(key);
    // 仅允许 http/https 协议，防止 javascript: 等协议注入
    if (!/^https?:\/\//i.test(url)) return '';
    return url;
  }
  // 未配置 hlsBaseUrl 且经反向代理/隧道访问时, host 是外部域名,
  // 自动推导的 :8888 端口地址必然不可达 -> 返回空并告警, 避免观众拿到坏地址
  const proto = String((headers && headers['x-forwarded-proto']) || '');
  if (proto === 'http' || proto === 'https') {
    console.warn(`[PrismLive] 经隧道/代理访问但未配置 HLS 基础地址，hlsUrl 为空 (host=${host})`);
    return '';
  }
  return `http://${host}:8888/live/${key}/index.m3u8`;
}

function rtmpUrlFor(host) {
  return `rtmp://${host}:1935/live`;
}

// HTTP-FLV 播放地址 (Task #13): 镜像 hlsUrlFor 的结构。
// SRS 提供 FLV 服务在 :8090 (端口变更: 原 8080 与本地环境冲突), 路径 /live/<key>.flv
function flvUrlFor(host, headers) {
  const key = db.getSetting('streamKey');
  const custom = (db.getSetting('flvBaseUrl') || '').trim();
  // 自定义地址中的 <key> 占位符替换为实际流密钥
  if (custom) {
    const url = custom.split('<key>').join(key);
    // 仅允许 http/https 协议，防止 javascript: 等协议注入
    if (!/^https?:\/\//i.test(url)) return '';
    return url;
  }
  // 隧道守卫: FLV 是基于 HTTP 长连接的持续拉流, 无法经 CF 隧道转发
  // (隧道对长连接/大流量转发不可靠), 直接返回空并告警, 前端会自动回退 HLS
  const proto = String((headers && headers['x-forwarded-proto']) || '');
  if (proto === 'http' || proto === 'https') {
    console.warn(`[PrismLive] 经隧道/代理访问, HTTP-FLV 不可用, flvUrl 为空 (host=${host})`);
    return '';
  }
  return `http://${host}:8090/live/${key}.flv`;
}

function publicConfig(host, headers) {
  return {
    liveTitle: db.getSetting('liveTitle'),
    liveAnnouncement: db.getSetting('liveAnnouncement'),
    liveEnabled: db.getSetting('liveEnabled') === 'true',
    danmakuEnabled: db.getSetting('danmakuEnabled') === 'true',
    streaming: live.streaming,
    srsStreaming: live.srsStreaming,   // SRS 侧推流状态 (HTTP-FLV 链路)
    playEngine: db.getSetting('playEngine') || 'hls', // hls | flv
    hlsUrl: hlsUrlFor(host, headers),
    flvUrl: flvUrlFor(host, headers),
    danmakuColors: DANMAKU_COLORS,
  };
}

// 敏感词正则缓存 (仅在设置变更时重建)
let sensitiveRegex = null;
let sensitiveKey = '';

function buildSensitiveRegex() {
  const words = (db.getSetting('sensitiveWords') || '')
    .split(/[,，\s]+/)
    .filter(Boolean);
  const key = words.join('|');
  if (!key) { sensitiveRegex = null; return; }
  if (key === sensitiveKey && sensitiveRegex) return;
  sensitiveKey = key;
  // 转义正则特殊字符后拼接
  const escaped = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  sensitiveRegex = new RegExp(escaped, 'g');
}

function filterSensitive(text) {
  buildSensitiveRegex();
  if (!sensitiveRegex) return text;
  return text.replace(sensitiveRegex, (m) => '*'.repeat(m.length));
}

function computeDanmakuPerMin() {
  // 从环形缓冲尾部(最旧)开始，丢弃超过 60s 的时间戳
  const cutoff = now() - 60 * 1000;
  while (danmakuTsCount > 0) {
    const oldestIdx = (danmakuTsHead - danmakuTsCount + DANMAKU_TS_CAPACITY) % DANMAKU_TS_CAPACITY;
    if (danmakuTsBuffer[oldestIdx] > cutoff) break;
    danmakuTsCount -= 1;
  }
  stats.danmakuPerMin = danmakuTsCount;
  return danmakuTsCount;
}

// 记录一条弹幕时间戳 (环形缓冲)
function pushDanmakuTs(ts) {
  danmakuTsBuffer[danmakuTsHead] = ts;
  danmakuTsHead = (danmakuTsHead + 1) % DANMAKU_TS_CAPACITY;
  if (danmakuTsCount < DANMAKU_TS_CAPACITY) {
    danmakuTsCount += 1;
  }
  // 若环形缓冲已满（count == capacity），head 已覆盖最旧元素，count 保持满值
}

// 统计最近 1s 内的弹幕数（全局速率限制用）
function countRecentDanmaku() {
  const cutoff = now() - DANMAKU_GLOBAL_WINDOW_MS;
  let n = 0;
  // head 指向下一个写入位，最新元素在 head-1，从最新往旧遍历
  for (let i = 0; i < danmakuTsCount; i++) {
    const idx = (danmakuTsHead - 1 - i + DANMAKU_TS_CAPACITY) % DANMAKU_TS_CAPACITY;
    if (danmakuTsBuffer[idx] > cutoff) n += 1;
    else break; // 从最新往前，遇到 ≤ cutoff 即停止（时间戳单调）
  }
  return n;
}

// ==================== MediaMTX 轮询 ====================

async function pollMtx() {
  try {
    const [pathsRes, infoRes] = await Promise.all([
      fetch(`${MTX_API}/v3/paths/list`, { signal: AbortSignal.timeout(MTX_FETCH_TIMEOUT_MS) }),
      fetch(`${MTX_API}/v3/info`, { signal: AbortSignal.timeout(MTX_FETCH_TIMEOUT_MS) }),
    ]);
    if (pathsRes.ok) {
      const data = await pathsRes.json();
      const key = db.getSetting('streamKey');
      const p = (data.items || []).find((i) => i.name === `live/${key}`);
      if (p) {
        live.mtxStreaming = true;
        live.readers = Array.isArray(p.readers) ? p.readers.length : 0;
        const bytes = p.inboundBytes || 0;
        const t = Date.now();
        if (live.bytesAt) {
          const dt = (t - live.bytesAt) / 1000;
          // 防御: 若 bytes 倒退 (MediaMTX 重启计数器), 视为新基线, 不计码率
          if (dt > 0.5 && bytes >= live.bytesLast) {
            live.bitrate = Math.round(((bytes - live.bytesLast) * 8) / dt / 1000);
            live.totalBytes += (bytes - live.bytesLast);
          } else if (bytes < live.bytesLast) {
            live.bitrate = 0;
          }
        }
        live.bytesLast = bytes;
        live.bytesAt = t;
      } else {
        live.mtxStreaming = false;
        live.bitrate = 0;
        live.readers = 0;
        // 重置字节基线: 下次推流 inboundBytes 从 0 重新计数,
        // 不重置会导致 bytes - bytesLast 为负, 码率显示为负数
        live.bytesLast = 0;
        live.bytesAt = 0;
      }
      live.mtxReachable = true;
    } else {
      live.mtxReachable = false;
    }
    if (infoRes.ok) {
      const info = await infoRes.json();
      live.mtxVersion = info.version || null;
    }
    live.lastCheck = now();
  } catch (e) {
    live.mtxStreaming = false;
    live.bitrate = 0;
    live.readers = 0;
    live.mtxVersion = null;
    live.bytesLast = 0;
    live.bytesAt = 0;
    live.mtxReachable = false;
    live.lastCheck = now();
  }
  applyStreamingState();
}

// 重算合并推流状态 (MediaMTX 或 SRS 任一活跃), 状态变化时通知观众端
function applyStreamingState() {
  const was = live.streaming;
  live.streaming = !!(live.mtxStreaming || live.srsStreaming);
  // 推流状态变化时记录开始/结束时间戳 (供面板推流时长展示)
  if (!was && live.streaming) {
    live.streamStartAt = now();
  } else if (was && !live.streaming) {
    live.streamStartAt = 0;
  }
  // 开播/停播状态变化时通知观众端刷新配置
  // webIo 在模块后部定义，首次轮询(5s后)必然已初始化，但防御性判空避免极端时序崩溃
  if (was !== live.streaming && typeof webIo !== 'undefined') {
    webIo.emit('stream_state', { streaming: live.streaming });
    // 推流关闭: 清空弹幕历史, 并广播让观众端清屏
    if (!live.streaming) {
      clearDanmakuHistory();
      webIo.emit('danmaku_cleared', { reason: '推流已结束，弹幕已清空' });
    }
  }
}

// SRS 推流状态探测 (Task #13, HTTP-FLV 链路): 与 pollMtx 各自独立定时, 互不阻塞。
// streams 中存在 name === streamKey 且 publish.active 即视为活跃;
// 不影响 HLS 链路与主轮询。
// F2 修复: 失败去抖 —— 500ms 超时偏激进, SRS 高负载时 API 变慢会造成
// 单次探测失败即翻转全局 streaming (mtx||srs), 触发全场观众端播放拆建。
// 现要求连续失败 >= 2 次才置 false; 探测成功立即生效 (false→true 恢复无延迟)
let srsFailStreak = 0;
async function pollSrs() {
  try {
    const res = await fetch(`${SRS_API}/api/v1/streams/`, {
      signal: AbortSignal.timeout(SRS_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`SRS API ${res.status}`);
    const data = await res.json();
    const key = db.getSetting('streamKey');
    // 探测成功: 清零失败计数, 直接应用结果
    srsFailStreak = 0;
    live.srsStreaming = (data.streams || []).some(
      (s) => s && s.name === key && s.publish && s.publish.active
    );
    live.srsReachable = true;
  } catch (e) {
    // 失败 (超时/非200/解析错): 连续失败 < 2 次保持原值, 防单次抖动翻转全局状态
    srsFailStreak += 1;
    if (srsFailStreak >= 2) {
      live.srsStreaming = false; // SRS 确认不可达: 静默降级
      live.srsReachable = false;
    }
  }
  applyStreamingState();
}

setInterval(pollMtx, MTX_POLL_INTERVAL_MS).unref();
setInterval(pollSrs, MTX_POLL_INTERVAL_MS).unref();

// ==================== 链路诊断探测 (frp 跳板 / ESA·CF 域名, 15s) ====================
// 探测 frp 跳板 23.147.68.27 的 8888/8090 端口可达性, 以及 ESA/CF 域名解析 + HTTPS 可达性。
// 仅中控面板展示用, 不影响推流/播放主链路; 探测失败静默记录, 不抛错。
const LINK_DIAG_INTERVAL_MS = 15000;
const FRP_HOST = '23.147.68.27';
const FRP_PROBE_TIMEOUT_MS = 3000;
const DOMAIN_PROBE_TIMEOUT_MS = 5000;

const linkDiag = {
  frp: {
    hls: { ok: false, latency: 0, lastCheck: 0, status: '' },
    flv: { ok: false, latency: 0, lastCheck: 0, status: '' },
  },
  domains: {
    flv: { ok: false, latency: 0, ip: '', lastCheck: 0, status: '', cert: '' },
    stream: { ok: false, latency: 0, ip: '', lastCheck: 0, status: '', cert: '' },
    live: { ok: false, latency: 0, ip: '', lastCheck: 0, status: '', cert: '' },
  },
};

// 探测 frp 跳板端口: HTTP HEAD 请求, 关注 TCP 可达 + 有 HTTP 响应 (状态码不要求 200)
async function probeFrpPort(port, label) {
  const t0 = Date.now();
  try {
    const res = await fetch(`http://${FRP_HOST}:${port}/`, {
      method: 'HEAD',
      signal: AbortSignal.timeout(FRP_PROBE_TIMEOUT_MS),
      redirect: 'manual',
    });
    const latency = Date.now() - t0;
    return { ok: true, latency, lastCheck: now(), status: `HTTP ${res.status}` };
  } catch (e) {
    const latency = Date.now() - t0;
    // SRS 无流挂起会超时, 但 TCP 已连 = 端口可达; 区分超时与连接拒绝
    const isTimeout = e.name === 'TimeoutError' || e.name === 'AbortError';
    return {
      ok: isTimeout, // 超时视为端口可达(TCP 已连, 应用层无响应)
      latency,
      lastCheck: now(),
      status: isTimeout ? 'TCP可达(应用层超时)' : '连接失败',
    };
  }
}

// 探测 ESA/CF 域名: HTTPS 请求, 关注解析 IP + TLS 握手 + HTTP 响应
async function probeDomain(host) {
  const t0 = Date.now();
  try {
    const res = await fetch(`https://${host}/`, {
      method: 'HEAD',
      signal: AbortSignal.timeout(DOMAIN_PROBE_TIMEOUT_MS),
      redirect: 'manual',
    });
    const latency = Date.now() - t0;
    return { ok: true, latency, ip: '', lastCheck: now(), status: `HTTP ${res.status}`, cert: '' };
  } catch (e) {
    const latency = Date.now() - t0;
    const msg = String(e && e.message || '');
    // TLS/证书错误也说明域名解析成功 + 节点可达, 仅证书层异常
    const tlsReachable = /ssl|tls|certificate|cert/i.test(msg);
    return {
      ok: tlsReachable,
      latency,
      ip: '',
      lastCheck: now(),
      status: tlsReachable ? '节点可达(TLS异常)' : '不可达',
      cert: msg.slice(0, 60),
    };
  }
}

async function pollLinkDiag() {
  // 并行探测全部 5 个目标 (frp:8888, frp:8090, flv, stream, live)
  const [frp8888, frp8090, flv, stream, liveD] = await Promise.allSettled([
    probeFrpPort(8888, 'HLS'),
    probeFrpPort(8090, 'FLV'),
    probeDomain('flv.silvegg.top'),
    probeDomain('stream.silvegg.top'),
    probeDomain('live.silvegg.top'),
  ]);
  if (frp8888.status === 'fulfilled') linkDiag.frp.hls = frp8888.value;
  if (frp8090.status === 'fulfilled') linkDiag.frp.flv = frp8090.value;
  if (flv.status === 'fulfilled') linkDiag.domains.flv = flv.value;
  if (stream.status === 'fulfilled') linkDiag.domains.stream = stream.value;
  if (liveD.status === 'fulfilled') linkDiag.domains.live = liveD.value;
}

// 首次探测延迟 3s 启动 (避免与服务启动抢资源), 之后固定间隔
setTimeout(() => {
  pollLinkDiag();
  setInterval(pollLinkDiag, LINK_DIAG_INTERVAL_MS).unref();
}, 3000).unref();

// ==================== 观众端 :8083 ====================

const webApp = express();
// 请求体限制: 防超大 body DoS (弹幕/配置类接口都是小体积)
webApp.use(express.json({ limit: '10kb' }));

// 简单请求日志 (仅 /api 接口, 避免静态资源刷屏)
webApp.use('/api', (req, _res, next) => {
  console.log(`[web:${req.method}] ${req.originalUrl}`);
  next();
});

webApp.use(
  '/vendor/hls.js',
  express.static(path.join(__dirname, 'node_modules', 'hls.js', 'dist'), {
    maxAge: '7d', // 静态库内容不变, 长缓存减少隧道带宽
    immutable: true,
  })
);
// mpegts.js (HTTP-FLV 播放引擎, Task #13): 同样从 node_modules 代理。
// 官方 dist 未提供 min 版, 用别名路由把 mpegts.min.js 指到 mpegts.js,
// 保持前端引用路径与 vendor 命名习惯一致
webApp.use(
  '/vendor/mpegts.js',
  express.static(path.join(__dirname, 'node_modules', 'mpegts.js', 'dist'), {
    maxAge: '7d',
    immutable: true,
  })
);
webApp.get('/vendor/mpegts.js/mpegts.min.js', (req, res) => {
  // F6 修复: 别名路由不走 express.static, 需手动补缓存头,
  // 与 hls.js vendor 路由的 7d immutable 约定对齐
  res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
  res.sendFile(path.join(__dirname, 'node_modules', 'mpegts.js', 'dist', 'mpegts.js'));
});

webApp.get('/api/config', (req, res) => {
  res.json(publicConfig(hostFrom(req.headers), req.headers));
});

webApp.get('/api/online', (req, res) => {
  res.json({ online: stats.online, peakOnline: stats.peakOnline });
});

// QQ 信息限频检查
function checkQQInfoRateLimit(ip) {
  const t = now();
  const entry = qqInfoRateLimit.get(ip);
  if (!entry || t - entry.windowStart > QQ_INFO_RATE_WINDOW_MS) {
    qqInfoRateLimit.set(ip, { count: 1, windowStart: t });
    return true;
  }
  if (entry.count >= QQ_INFO_RATE_MAX) return false;
  entry.count += 1;
  return true;
}

// 定期清理 QQ 信息缓存与限频记录
setInterval(() => {
  const t = now();
  for (const [qq, info] of qqInfoCache) {
    if (t - info.fetchedAt > QQ_INFO_CACHE_TTL) qqInfoCache.delete(qq);
  }
  for (const [ip, entry] of qqInfoRateLimit) {
    if (t - entry.windowStart > QQ_INFO_RATE_WINDOW_MS) qqInfoRateLimit.delete(ip);
  }
}, 5 * 60 * 1000).unref();

// QQ 信息代理: 通过 QQ 号获取昵称 + 头像 (避免浏览器 CORS)
webApp.get('/api/qqinfo', async (req, res) => {
  const qq = String((req.query.qq || '')).trim();
  if (!qq || !/^\d{5,12}$/.test(qq)) {
    return res.status(400).json({ error: 'QQ 号格式不正确' });
  }
  const ip = clientIp(req);
  if (!checkQQInfoRateLimit(ip)) {
    return res.status(429).json({ error: '请求太频繁，请稍候再试' });
  }
  // 命中缓存直接返回
  const cached = qqInfoCache.get(qq);
  if (cached && now() - cached.fetchedAt < QQ_INFO_CACHE_TTL) {
    return res.json(cached);
  }
  try {
    // 优先使用 uapis.cn (稳定, 返回正确 UTF-8 中文昵称, 无需 key)
    const resp = await fetch(
      `https://uapis.cn/api/v1/social/qq/userinfo?qq=${qq}`,
      {
        headers: { 'User-Agent': 'PrismLive/1.0' },
        signal: AbortSignal.timeout(5000),
      }
    );
    if (!resp.ok) throw new Error(`uapis ${resp.status}`);
    const data = await resp.json();
    const nickname = (data && (data.nickname || data.nick)) || '';
    const result = {
      qq,
      nickname,
      avatarUrl: `https://q1.qlogo.cn/g?b=qq&nk=${qq}&s=640`,
    };
    // 缓存 (含有效昵称时才缓存, 避免缓存空结果)
    if (nickname) {
      qqInfoCache.set(qq, { ...result, fetchedAt: now() });
      if (qqInfoCache.size > QQ_INFO_CACHE_MAX) {
        // 淘汰最旧条目
        const oldest = qqInfoCache.keys().next().value;
        qqInfoCache.delete(oldest);
      }
    }
    res.json(result);
  } catch (e) {
    console.warn('[PrismLive] QQ 信息查询失败:', e.message);
    // 兆底: 尝试 QQ 空间接口 (编码可能损坏, 但头像始终可用)
    try {
      const resp2 = await fetch(
        `https://users.qzone.qq.com/fcg-bin/cgi_get_portrait.fcg?uins=${qq}`,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': 'https://user.qzone.qq.com/',
          },
          signal: AbortSignal.timeout(5000),
        }
      );
      const buf = await resp2.arrayBuffer();
      const text = new TextDecoder('gbk').decode(buf);
      const match = text.match(/portraitCallBack\((.+)\)/);
      if (match) {
        const data2 = JSON.parse(match[1]);
        const arr = data2[qq];
        let nickname = (arr && typeof arr[6] === 'string') ? arr[6] : '';
        if (nickname && /[\uFFFD]/.test(nickname)) nickname = '';
        if (nickname && /锟斤拷/.test(nickname)) nickname = '';
        return res.json({ qq, nickname, avatarUrl: `https://q1.qlogo.cn/g?b=qq&nk=${qq}&s=640` });
      }
    } catch (e2) { /* 兆底也失败, 静默 */ }
    res.json({ qq, nickname: '', avatarUrl: `https://q1.qlogo.cn/g?b=qq&nk=${qq}&s=640` });
  }
});

webApp.use(express.static(path.join(__dirname, 'public')));

// ==================== 中控后台 :8084 ====================

const adminApp = express();
adminApp.use(express.json({ limit: '10kb' }));

adminApp.use('/api', (req, _res, next) => {
  console.log(`[admin:${req.method}] ${req.originalUrl}`);
  next();
});

adminApp.use(
  '/vendor/echarts',
  express.static(path.join(__dirname, 'node_modules', 'echarts', 'dist'), {
    maxAge: '7d',
    immutable: true,
  })
);
adminApp.use(express.static(path.join(__dirname, 'admin')));

function requireAuth(req, res, next) {
  const token = String((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  const exp = adminTokens.get(token);
  if (!exp || exp < now()) {
    return res.status(401).json({ error: '未登录或登录已过期' });
  }
  req.adminToken = token;
  next();
}

adminApp.post('/api/admin/login', (req, res) => {
  const ip = clientIp(req);
  const guard = loginGuard.get(ip) || { fails: 0, firstAt: 0, lockedUntil: 0 };

  // 锁定期间直接拒绝
  if (guard.lockedUntil > now()) {
    const remainMs = guard.lockedUntil - now();
    const remainMin = Math.ceil(remainMs / 60000);
    return res.status(429).json({ error: `登录失败次数过多，请 ${remainMin} 分钟后再试` });
  }

  const { password } = req.body || {};
  const salt = db.getSetting('adminPasswordSalt');
  const hash = db.getSetting('adminPasswordHash');
  if (!password || db.hashPassword(password, salt) !== hash) {
    // 记录失败
    guard.fails += 1;
    if (guard.fails === 1) guard.firstAt = now();
    // 窗口外重置计数
    if (now() - guard.firstAt > LOGIN_WINDOW_MS) {
      guard.fails = 1;
      guard.firstAt = now();
    }
    // 达到阈值则锁定
    if (guard.fails >= LOGIN_MAX_FAILS) {
      guard.lockedUntil = now() + LOGIN_LOCK_MS;
      loginGuard.set(ip, guard);
      return res.status(429).json({ error: '登录失败次数过多，已锁定 10 分钟' });
    }
    loginGuard.set(ip, guard);
    const left = LOGIN_MAX_FAILS - guard.fails;
    return res.status(401).json({ error: `密码错误，剩余尝试次数 ${left} 次` });
  }

  // 登录成功：清除该 IP 的失败记录
  loginGuard.delete(ip);
  const token = crypto.randomBytes(32).toString('hex');
  adminTokens.set(token, now() + ADMIN_TOKEN_TTL);
  res.json({ token, expiresIn: ADMIN_TOKEN_TTL });
});

adminApp.get('/api/admin/state', requireAuth, (req, res) => {
  const host = hostFrom(req.headers);
  res.json({
    settings: {
      liveTitle: db.getSetting('liveTitle'),
      liveAnnouncement: db.getSetting('liveAnnouncement'),
      liveEnabled: db.getSetting('liveEnabled') === 'true',
      danmakuEnabled: db.getSetting('danmakuEnabled') === 'true',
      danmakuRateLimit: Number(db.getSetting('danmakuRateLimit') || 5),
      sensitiveWords: db.getSetting('sensitiveWords') || '',
      streamKey: db.getSetting('streamKey'),
      hlsBaseUrl: db.getSetting('hlsBaseUrl') || '',
      flvBaseUrl: db.getSetting('flvBaseUrl') || '',
      playEngine: db.getSetting('playEngine') || 'hls',
      flvUrl: flvUrlFor(host, req.headers),
      rtmpUrl: rtmpUrlFor(host),
      hlsUrl: hlsUrlFor(host, req.headers),
    },
    live,
    stats: {
      online: stats.online,
      peakOnline: stats.peakOnline,
      todayViews: stats.todayViews,
      totalDanmaku: stats.totalDanmaku,
      totalLikes: stats.totalLikes,
      danmakuPerMin: stats.danmakuPerMin,
    },
    system: sysInfo(),
    linkDiag,
    blacklist: db.listBlacklist(),
  });
});

const SETTING_KEYS = [
  'liveTitle',
  'liveAnnouncement',
  'liveEnabled',
  'danmakuEnabled',
  'danmakuRateLimit',
  'sensitiveWords',
  'hlsBaseUrl',
  'flvBaseUrl',
  'playEngine',
];

adminApp.put('/api/admin/settings', requireAuth, (req, res) => {
  const body = req.body || {};
  for (const k of SETTING_KEYS) {
    if (k in body) {
      let v = String(body[k]).trim();
      if (k === 'liveEnabled' || k === 'danmakuEnabled') v = body[k] ? 'true' : 'false';
      if (k === 'danmakuRateLimit') {
        const n = Number(v);
        if (!Number.isFinite(n) || n < 1 || n > 100) continue;
        v = String(Math.round(n));
      }
      // 播放引擎白名单校验 (Task #13): 只接受 hls/flv, 非法值忽略
      if (k === 'playEngine' && v !== 'hls' && v !== 'flv') continue;
      // Task #16: FLV 基础地址校验 —— 允许空串 (清空, 回默认 :8090 推导),
      // 非空必须为 http/https 协议, 否则忽略该字段 (与 hlsUrlFor/flvUrlFor
      // 的协议校验对齐, 防止 javascript: 等协议注入)
      if (k === 'flvBaseUrl' && v !== '' && !/^https?:\/\//i.test(v)) continue;
      db.setSetting(k, v);
    }
  }
  // 通知观众端刷新配置
  // M3 修复: config_update 广播不再携带 hlsUrl —— publicConfig 的地址按
  // 管理员请求 host 构造 (本机保存设置时是 localhost:8888), 广播出去会把
  // 远程观众的播放地址换成不可达地址并触发无限重试。
  // 客户端收到后保留 join ack 时已持有的播放地址、不重建播放
  // (见 app.js config_update 处理器), 两端契约对齐。
  const configUpdate = publicConfig(hostFrom(req.headers), req.headers);
  delete configUpdate.hlsUrl;
  // Task #13: flvUrl 同样按管理员请求 host 构造, 广播同理剔除 (M3 模式);
  // playEngine 保留 —— 客户端比对到引擎变化后自行 fetch /api/config 重建
  delete configUpdate.flvUrl;
  webIo.emit('config_update', configUpdate);
  res.json({ ok: true });
});

adminApp.put('/api/admin/password', requireAuth, (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  const salt = db.getSetting('adminPasswordSalt');
  const hash = db.getSetting('adminPasswordHash');
  if (!oldPassword || db.hashPassword(oldPassword, salt) !== hash) {
    return res.status(400).json({ error: '原密码错误' });
  }
  if (!newPassword || String(newPassword).length < 6) {
    return res.status(400).json({ error: '新密码至少 6 位' });
  }
  const newSalt = crypto.randomBytes(16).toString('hex');
  db.setSetting('adminPasswordSalt', newSalt);
  db.setSetting('adminPasswordHash', db.hashPassword(newPassword, newSalt));
  res.json({ ok: true });
});

adminApp.post('/api/admin/key/reset', requireAuth, (req, res) => {
  db.setSetting('streamKey', crypto.randomBytes(16).toString('hex'));
  const host = hostFrom(req.headers);
  // F2 修复: 广播轻量换流事件, 给观众端重建播放的通道。
  // 背景: M3 修复后 config_update 不再携带 hlsUrl, 若此处只回包不广播,
  // 观众端旧 manifest 会 404 → 重试耗尽后永久停在"直播信号异常"。
  // 注意: 事件不携带任何按管理员请求 host 构造的地址 (避免重蹈 localhost
  // 坏地址覆辙), 观众端收到后自行 fetch /api/config 按自身 host 取
  // 正确地址 (见 app.js stream_key_changed 监听)。
  webIo.emit('stream_key_changed', {});
  res.json({
    streamKey: db.getSetting('streamKey'),
    rtmpUrl: rtmpUrlFor(host),
    hlsUrl: hlsUrlFor(host, req.headers),
  });
});

adminApp.get('/api/admin/blacklist', requireAuth, (req, res) => {
  res.json(db.listBlacklist());
});

adminApp.post('/api/admin/blacklist', requireAuth, (req, res) => {
  const { ident, type, note } = req.body || {};
  if (!ident || !String(ident).trim()) return res.status(400).json({ error: '缺少封禁对象' });
  try {
    db.addBlacklist(String(ident).trim(), type === 'qq' ? 'qq' : 'name', String(note || '').trim());
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: '该对象已在黑名单中' });
  }
});

adminApp.delete('/api/admin/blacklist/:id', requireAuth, (req, res) => {
  db.removeBlacklist(Number(req.params.id));
  res.json({ ok: true });
});

// ---------- 在线用户管理 ----------

adminApp.get('/api/admin/users', requireAuth, (req, res) => {
  const list = [];
  for (const [socketId, u] of users) {
    list.push({
      socketId,
      name: u.name,
      qq: u.qq,
      avatar: u.avatar,
      joinedAt: u.joinedAt,
      duration: Math.round((now() - u.joinedAt) / 1000),
    });
  }
  // 按 join 时间倒序
  list.sort((a, b) => b.joinedAt - a.joinedAt);
  res.json(list);
});

adminApp.post('/api/admin/users/:socketId/kick', requireAuth, (req, res) => {
  const sid = String(req.params.socketId);
  const u = users.get(sid);
  const s = webIo.sockets.sockets.get(sid);
  if (!u || !s) return res.status(404).json({ error: '用户不在线或已离开' });
  // 通知该用户被踢
  s.emit('kicked', { reason: '您已被管理员移出直播间' });
  s.disconnect(true);
  res.json({ ok: true });
});

// ==================== Socket.IO: 观众端 ====================

const webHttp = http.createServer(webApp);
const webIo = new Server(webHttp, {
  // 仅允许同源连接，避免跨站 Socket.IO CSRF
  cors: { origin: false },
  // 心跳调优: 隧道场景下默认 25s 心跳可能假死, 缩短到 15s 检测
  pingInterval: 15000,
  pingTimeout: 10000,
});

const users = new Map(); // socketId -> { name, qq, avatar, joinedAt }

// 构造观众列表 (广播用, 不含 socketId)
function getViewerList() {
  const list = [];
  for (const [, u] of users) {
    list.push({ name: u.name, qq: u.qq, avatar: u.avatar });
  }
  return list;
}

webIo.on('connection', (socket) => {
  socket.on('join', (payload, cb) => {
    const name = String((payload && payload.name) || '').trim().slice(0, 20);
    const qq = String((payload && payload.qq) || '').trim().slice(0, 20);
    // m7 修复: 重连 rejoin 标记 (客户端重连时附 rejoin:true, 见 app.js)。
    // 重连会生成新 socket.id 走完整 join 路径, 不加标记会让每次网络抖动
    // 重复累加 todayViews 并重复广播"进入了直播间"。
    // 信任边界说明: rejoin 来自客户端自报, 理论上可伪造以规避观看计数;
    // 本项目为个人直播场景, 统计非安全关键指标, 接受现状不做服务端校验。
    const isRejoin = !!(payload && payload.rejoin);
    if (!name) return cb && cb({ ok: false, error: '昵称不能为空' });
    if (users.has(socket.id)) return cb && cb({ ok: false, error: '请勿重复进入' });
    if (db.isBlacklisted(name) || (qq && db.isBlacklisted(qq))) {
      return cb && cb({ ok: false, error: '您已被移出直播间' });
    }

    const rawAvatar = payload && payload.avatar ? String(payload.avatar).slice(0, 300) : '';
    // 仅允许 http(s) 的 QQ 头像等合法 URL，拒绝 javascript:/data: 等协议
    const avatar = rawAvatar && /^https?:\/\//i.test(rawAvatar) ? rawAvatar : '';
    const user = { name, qq, avatar, joinedAt: Date.now() };
    users.set(socket.id, user);
    socket.data.user = user;
    stats.online = users.size;
    if (stats.online > stats.peakOnline) stats.peakOnline = stats.online;
    if (!isRejoin) {
      // 首次 join 才计今日观看并广播进场; rejoin 只恢复身份, 不重复
      stats.todayViews += 1;
      webIo.emit('system', { type: 'join', text: `${name} 进入了直播间`, user });
    }
    webIo.emit('online', { online: stats.online });
    // 广播更新后的观众列表
    webIo.emit('viewer_list', getViewerList());

    cb && cb({
      ok: true,
      user,
      online: stats.online,
      config: publicConfig(hostFrom(socket.handshake.headers), socket.handshake.headers),
      // 弹幕历史: 新观众进入时可看到此前的弹幕 (仅推流中才有历史, 关闭后为空)
      danmakuHistory,
      // 全局点赞总数: 新观众进入时显示已有点赞数
      totalLikes: stats.totalLikes,
      // 当前观众列表 (进入时即可看到其他观众)
      viewerList: getViewerList(),
    });
  });

  socket.on('danmaku', (payload, cb) => {
    const user = socket.data.user;
    if (!user) { cb && cb({ ok: false, error: '未加入直播间' }); return; }
    if (db.getSetting('danmakuEnabled') !== 'true') { cb && cb({ ok: false, error: '弹幕功能已关闭' }); return; }
    const text = String((payload && payload.text) || '').trim().slice(0, DANMAKU_MAX_LEN);
    if (!text) { cb && cb({ ok: false, error: '内容为空' }); return; }

    // 每用户冷却 + 全局速率上限 (danmakuRateLimit = 每秒全局条数)
    const since = socket.data.lastDanmakuAt || 0;
    if (now() - since < DANMAKU_USER_COOLDOWN_MS) {
      cb && cb({ ok: false, error: '发送太快，请稍候' });
      return;
    }
    const limit = Number(db.getSetting('danmakuRateLimit') || 5);
    const recent = countRecentDanmaku();
    if (recent >= limit * DANMAKU_RATE_MULTIPLIER) {
      cb && cb({ ok: false, error: '当前弹幕太密集，请稍候' });
      return;
    }

    // 弹幕颜色 (仅白名单)
    const color = String((payload && payload.color) || '').toLowerCase();
    const finalColor = DANMAKU_COLORS.includes(color) ? color : '#ffffff';

    socket.data.lastDanmakuAt = now();
    pushDanmakuTs(now());
    stats.totalDanmaku += 1;

    const dmItem = {
      id: crypto.randomBytes(6).toString('hex'),
      user,
      text: filterSensitive(text),
      color: finalColor,
      ts: Date.now(),
    };
    recordDanmaku(dmItem);
    webIo.emit('danmaku', dmItem);
    cb && cb({ ok: true });
  });

  // ===== 点赞 (全局同步) =====
  socket.on('like', (payload, cb) => {
    const user = socket.data.user;
    if (!user) { cb && cb({ ok: false, error: '未加入直播间' }); return; }
    // 单用户冷却
    const since = socket.data.lastLikeAt || 0;
    if (now() - since < LIKE_USER_COOLDOWN_MS) return; // 静默忽略连点
    // 全局速率限制
    if (countRecentLikes() >= LIKE_GLOBAL_MAX_PER_SEC) return;

    socket.data.lastLikeAt = now();
    pushLikeTs(now());
    stats.totalLikes += 1;

    // 广播点赞事件 (气泡用) + 总数更新
    webIo.emit('like_bubble', { user, ts: now() });
    webIo.emit('like_update', { total: stats.totalLikes });
    cb && cb({ ok: true, total: stats.totalLikes });
  });

  socket.on('disconnect', () => {
    // TODO(已知问题, 本轮不做): 隧道/弱网下的瞬时断连会立即广播"离开",
    // 客户端重连 rejoin 成功后又广播"进入", 产生孤儿"离开"消息。
    // 需要服务端 grace period 设计 (延迟 N 秒确认离线再广播), 属增量需求。
    const user = users.get(socket.id);
    if (user) {
      users.delete(socket.id);
      stats.online = users.size;
      webIo.emit('system', { type: 'leave', text: `${user.name} 离开了直播间`, user });
      webIo.emit('online', { online: stats.online });
      // 广播更新后的观众列表
      webIo.emit('viewer_list', getViewerList());
    }
  });
});

// ==================== Socket.IO: 中控后台 ====================

const adminHttp = http.createServer(adminApp);
const adminIo = new Server(adminHttp, {
  cors: { origin: false },
  pingInterval: 15000,
  pingTimeout: 10000,
});

adminIo.on('connection', (socket) => {
  socket.on('auth', (token, cb) => {
    const exp = adminTokens.get(String(token || ''));
    if (!exp || exp < now()) return cb && cb({ ok: false });
    socket.data.authorized = true;
    cb && cb({ ok: true });
  });
});

// 后台看板实时推送 (2s)
setInterval(() => {
  // 无已授权订阅者时跳过计算和广播
  let hasSubscribers = false;
  for (const s of adminIo.sockets.sockets.values()) {
    if (s.data.authorized) { hasSubscribers = true; break; }
  }
  if (!hasSubscribers) return;

  stats.danmakuPerMin = computeDanmakuPerMin();
  const payload = {
    live,
    stats: {
      online: stats.online,
      peakOnline: stats.peakOnline,
      todayViews: stats.todayViews,
      totalDanmaku: stats.totalDanmaku,
      totalLikes: stats.totalLikes,
      danmakuPerMin: stats.danmakuPerMin,
    },
    system: sysInfo(),
    linkDiag,
  };
  for (const s of adminIo.sockets.sockets.values()) {
    if (s.data.authorized) s.emit('stats_update', payload);
  }
}, ADMIN_STATS_INTERVAL_MS).unref();

// ==================== 统计持久化 (60s) + 跨天重置 ====================

setInterval(() => {
  const today = todayStr();
  if (today !== stats.today) {
    // 跨天：重置当日统计
    stats.today = today;
    stats.todayViews = 0;
    stats.peakOnline = stats.online;
    danmakuTsBuffer.fill(0);
    danmakuTsHead = 0;
    danmakuTsCount = 0;
    stats.danmakuPerMin = 0;
    // 同步重置点赞速率环形缓冲 (避免跨天后残留昨日时间戳)
    likeTsBuffer.fill(0);
    likeTsHead = 0;
    likeTsCount = 0;
  }
  db.setStat('statsDay', stats.today);
  db.setStat('todayViews', stats.todayViews);
  db.setStat('peakOnline', stats.peakOnline);
  db.setStat('totalDanmaku', stats.totalDanmaku);
  db.setStat('totalLikes', stats.totalLikes);
}, STATS_PERSIST_INTERVAL_MS).unref();

// ==================== 健康检查端点 ====================

webApp.get('/api/health', (_req, res) => {
  // F8: 增量字段 mtxStreaming/srsStreaming (不改原 streaming 语义:
  // streaming 仍是两者任一活跃的合并判定)
  res.json({
    ok: true,
    uptime: process.uptime(),
    streaming: live.streaming,
    mtxStreaming: live.mtxStreaming,
    srsStreaming: live.srsStreaming,
  });
});
adminApp.get('/api/health', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

// ==================== 统一 JSON 错误处理 ====================

function jsonErrorHandler(err, _req, res, _next) {
  // body 解析失败 (json 格式错误 / 超限)
  if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
    return res.status(400).json({ error: err.type === 'entity.too.large' ? '请求体过大' : '请求体格式错误' });
  }
  console.error('[PrismLive] 未处理错误:', err.message, err.stack);
  res.status(500).json({ error: '服务器内部错误' });
}
webApp.use('/api', jsonErrorHandler);
adminApp.use('/api', jsonErrorHandler);

// ==================== 启动 ====================

function onListenError(name, port) {
  return (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[PrismLive] 端口 ${port} 已被占用，请检查是否已有实例运行 (${name})`);
    } else {
      console.error(`[PrismLive] ${name} 监听失败:`, err.message);
    }
    process.exit(1);
  };
}

webHttp.on('error', onListenError('观众端', PORT_WEB));
adminHttp.on('error', onListenError('中控后台', PORT_ADMIN));

webHttp.listen(PORT_WEB, HOST, () => {
  console.log(`[PrismLive] 观众端   http://${HOST}:${PORT_WEB}`);
});
adminHttp.listen(PORT_ADMIN, HOST, () => {
  console.log(`[PrismLive] 中控后台 http://${HOST}:${PORT_ADMIN}  (默认密码: admin123)`);
  console.log(`[PrismLive] 请及时修改后台密码`);
});
console.log(`[PrismLive] MediaMTX API: ${MTX_API}`);
console.log(`[PrismLive] SQLite 数据库: data/prismlive.db`);
if (HOST === '0.0.0.0') {
  console.log(`[PrismLive] 警告: 已绑定 0.0.0.0，后台端口将对外暴露，请确保已通过反向代理/防火墙保护`);
}

// ==================== Graceful Shutdown ====================

function shutdown(signal) {
  console.log(`\n[PrismLive] 收到 ${signal}，正在关闭...`);
  // 持久化最终统计
  db.setStat('statsDay', stats.today);
  db.setStat('todayViews', stats.todayViews);
  db.setStat('peakOnline', stats.peakOnline);
  db.setStat('totalDanmaku', stats.totalDanmaku);
  db.setStat('totalLikes', stats.totalLikes);
  // 关闭连接
  webIo.close();
  adminIo.close();
  webHttp.close();
  adminHttp.close();
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ==================== 未捕获异常兜底 ====================

// 未捕获异常: 记录日志并优雅退出(避免进程处于未知状态继续服务)
// 退出前先持久化统计
process.on('uncaughtException', (err) => {
  console.error('[PrismLive] 未捕获异常:', err.message, err.stack);
  try {
    db.setStat('statsDay', stats.today);
    db.setStat('todayViews', stats.todayViews);
    db.setStat('peakOnline', stats.peakOnline);
    db.setStat('totalDanmaku', stats.totalDanmaku);
    db.setStat('totalLikes', stats.totalLikes);
  } catch (e) { /* 持久化失败则直接退出 */ }
  process.exit(1);
});

// 未处理的 Promise 拒绝: 记日志, 不崩溃 (异步回调抛错常见)
process.on('unhandledRejection', (reason) => {
  console.error('[PrismLive] 未处理的 Promise 拒绝:', reason);
});
