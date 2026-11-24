# PrismLive 私域直播平台

面向 QQ 群等私域场景的轻量直播平台：OBS 推流 → HLS 分发 → 浏览器原生播放 + 实时弹幕 + 中控后台。

## 架构

```
[OBS (RTMP 推流)]          [观众浏览器: <video> 播放 HLS + 弹幕]
        │                            ▲
        ▼                            │
[MediaMTX] ── HLS (m3u8+ts) ────────┘
  RTMP :1935 ──┐
  HTTP :8888   │
  API  :9997   ┘
               ▼
[Node.js 应用] :8083 观众端 (Express + Socket.IO 弹幕)
               :8084 中控后台 (设置 + ECharts 数据看板)
               SQLite 单文件存储 (data/prismlive.db)
```

## 端口规划

| 端口 | 用途 |
|---|---|
| 1935 | MediaMTX RTMP（OBS 推流） |
| 8888 | MediaMTX HLS 分发 |
| 9997 | MediaMTX 控制 API（Node 轮询状态用） |
| 8083 | 观众观看页 + 弹幕 Socket.IO |
| 8084 | 中控后台（默认密码 `admin123`，登录后请修改） |

## 快速启动

1. **安装 Node.js 依赖**（需 Node ≥ 22.5，内置 SQLite 免编译）：
   ```bat
   npm install
   ```
   > 若安装失败报 `ENOTFOUND`（IPv6 问题），执行：
   > `set NODE_OPTIONS=--dns-result-order=ipv4first && npm install`

2. **下载 MediaMTX**（Windows amd64，放项目根目录）：
   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\download-mediamtx.ps1
   ```

3. **一键启动**：
   ```bat
   start.bat
   ```
   或手动：先 `mediamtx.exe mediamtx.yml`，再 `node server.js`

## OBS 推流配置

| 设置 | 值 |
|---|---|
| 服务 | 自定义 |
| 服务器 | `rtmp://localhost:1935/live`（后台"推流信息"里可查看/复制） |
| 串流密钥 | 后台生成的一串随机密钥（可重置） |

画质建议：H.264 1080p60，码率 6000-9000 kbps，关键帧间隔 2s。
竖屏直播：OBS 画布用 1080×1920。

## 使用说明

- **观众**：浏览器打开 `http://localhost:8083`，输入昵称（或 QQ 号自动带出头像）即可进入，支持手机横屏/竖屏
- **主播/管理员**：打开 `http://localhost:8084`，管理直播间设置、弹幕、黑名单，查看实时数据看板

## 数据与存储

- 数据库：`data/prismlive.db`（SQLite 单文件，settings / blacklist / stats 三张表）
- 统计按天重置（今日观看人次等）；累计弹幕/峰值在线持久化
- 后台密码、推流密钥、敏感词等全部存于数据库

## 配置项

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `MTX_API` | `http://127.0.0.1:9997` | MediaMTX 控制 API 地址 |

后台设置里的 `HLS 基础地址` 留空时自动按请求主机推导播放地址；公网部署时建议填完整地址（如 `https://live.example.com/live/<key>/index.m3u8`）。

## 公网部署注意

- 域名 + HTTPS（HLS 在 HTTPS 下最稳，微信内播放也需要）
- MediaMTX 的 HLS 分片天然适合 CDN
- 1080p60 高码率 ≈ 10 Mbps/观众，人多时务必上 CDN 或控制码率
- 后台请务必修改默认密码
