# PrismLive 前端契约文档

> 后端实现见 `server.js` / `db.js`（以代码为准，本文档是接口摘要）。
> 前端为**原生 HTML/CSS/JS（ES6+）**，无框架、无构建工具。

## 端口与静态目录

| 服务 | 地址 | 静态目录 |
|---|---|---|
| 观众端 | `http://localhost:8083` | `public/` |
| 中控后台 | `http://localhost:8084` | `admin/` |

- Socket.IO 客户端：`<script src="/socket.io/socket.io.js">`（服务端自动提供，页面同源引用即可）
- ECharts（仅后台需要）：`<script src="/vendor/echarts/echarts.min.js">`（服务端代理到 node_modules）
- hls.js（观众端）：`<script src="/vendor/hls.js/hls.min.js">`（服务端代理到 node_modules）
- mpegts.js（观众端，HTTP-FLV 引擎）：`<script src="/vendor/mpegts.js/mpegts.min.js">`（服务端代理到 node_modules；上游 dist 无 min 版，`mpegts.min.js` 为别名路由指向 `mpegts.js`）

## 观众端 REST（8083）

```
GET /api/config
→ { liveTitle, liveAnnouncement, liveEnabled, danmakuEnabled, streaming, srsStreaming, playEngine, hlsUrl, flvUrl }

GET /api/online
→ { online, peakOnline }

GET /api/health
→ { ok, uptime, streaming, mtxStreaming, srsStreaming }   // streaming 为 mtx/srs 任一活跃的合并判定, 后两者为分项增量字段
```

## 观众端 Socket.IO（8083）

**客户端 → 服务端：**

```
emit('join', { name, qq, avatar })   // avatar 为 QQ 头像 URL(可空)
  ack → { ok:true, user:{name,qq,avatar}, online, config }
      | { ok:false, error }
emit('danmaku', { text })
```

**服务端 → 客户端：**

```
danmaku    { id, user:{name,qq,avatar}, text, ts }        // 新弹幕广播
system     { type:'join'|'leave', text, user }            // 进出提示
online     { online }                                     // 在线人数变化
config_update { liveTitle, liveAnnouncement, liveEnabled, danmakuEnabled, streaming, srsStreaming, playEngine } // 后台改设置后推送; hlsUrl/flvUrl 被剔除 (M3 模式, 客户端保留 join ack 持有的地址); playEngine 变化时客户端 fetch /api/config 重建 (F2 模式)
```

## 后台 REST（8084）— 除 login 外均需 `Authorization: Bearer <token>`

```
POST /api/admin/login { password } → { token, expiresIn }

GET  /api/admin/state
→ { settings:{ liveTitle, liveAnnouncement, liveEnabled, danmakuEnabled, danmakuRateLimit, sensitiveWords, streamKey, hlsBaseUrl, flvBaseUrl, playEngine, flvUrl, rtmpUrl, hlsUrl },
    live:{ streaming, mtxStreaming, srsStreaming, bitrate, readers, mtxVersion, lastCheck },
    stats:{ online, peakOnline, todayViews, totalDanmaku, danmakuPerMin },
    system:{ node, platform, arch, memTotalMB, memFreeMB, serviceUptime, processUptime },
    blacklist:[ { id, ident, type, note, created_at } ] }

PUT  /api/admin/settings 部分字段即可
body 可含: { liveTitle, liveAnnouncement, liveEnabled(bool), danmakuEnabled(bool), danmakuRateLimit(数字), sensitiveWords, hlsBaseUrl, flvBaseUrl, playEngine('hls'|'flv') } → { ok:true }
校验规则 (非法字段静默忽略): danmakuRateLimit 需 1-100 整数; playEngine 仅限 'hls'/'flv'; flvBaseUrl 允许空串 (清空, 回默认 :8090 推导), 非空必须匹配 /^https?:\/\//i

PUT  /api/admin/password { oldPassword, newPassword } → { ok:true } | 400 {error}

POST /api/admin/key/reset → { streamKey, rtmpUrl, hlsUrl }   // 重置推流密钥

GET  /api/admin/blacklist → [ {id, ident, type, note, created_at} ]
POST /api/admin/blacklist { ident, type:'name'|'qq', note } → { ok:true } | 400 {error}
DELETE /api/admin/blacklist/:id → { ok:true }
```

## 后台 Socket.IO（8084）

```
emit('auth', token) → ack { ok:true }
服务端 → 客户端（已授权后每 2s 推送）:
stats_update {
  live:{ streaming, mtxStreaming, srsStreaming, bitrate, readers, mtxVersion, lastCheck },
  stats:{ online, peakOnline, todayViews, totalDanmaku, danmakuPerMin },
  system:{ node, platform, arch, memTotalMB, memFreeMB, serviceUptime, processUptime }
}
```

## 播放引擎与 HTTP-FLV（Task #13）

- **SRS 端口约定**（因本地环境端口冲突已变更）：RTMP 推流 `19350`、FLV/HLS 出流 HTTP `8090`、API `1986`（原 1935/8080/1985）
- **设置**：`playEngine`（后台“播放引擎”下拉，默认 `hls`）。`hls` = HLS（兼容，MediaMTX→hls.js）；`flv` = HTTP-FLV（低延迟，SRS→mpegts.js）
- **flvUrl 约定**：镜像 `hlsUrlFor` 结构。默认 `http://<host>:8090/live/<streamKey>.flv`（SRS HTTP 服务 :8090）；支持可选设置 `flvBaseUrl`（含 `<key>` 占位符，仅允许 http/https 协议，非法返空）
- **隧道限制**：经隧道/代理访问（`x-forwarded-proto` 为 http/https）且未配置 `flvBaseUrl` 时，`flvUrl` 返回空并告警——FLV 基于 HTTP 长连接持续拉流，无法经隧道转发；前端此时自动回退 HLS
- **SRS_API**：服务端探测环境变量 `SRS_API`（默认 `http://127.0.0.1:1986`），轮询 `GET /api/v1/streams/`，`streams` 中 `name === streamKey` 且 `publish.active` 即 `srsStreaming=true`；探测失败静默置 false（500ms 超时，与 MediaMTX 轮询并行，互不替换）
- **streaming 判定**：MediaMTX 或 SRS 任一活跃即为推流中
- **前端回退**：FLV 播放出错（mpegts ERROR）或浏览器不支持 MSE 直播时，会话级一次性回退 HLS（`flvFailed` 标记，流彻底停止后复位）
- **引擎切换**：`playEngine` 变化由 `config_update` 携带，客户端比对后 `fetch('/api/config')` 按自身 host 取正确地址重建（同 `stream_key_changed` 模式）

## 视觉设计规范（两个页面统一）

- **主题**：现代暗色。背景深蓝黑渐变（`#0b0f1a → #141a2e`），强调色品牌紫 `#7c5cff`（可搭配青 `#22d3ee` 做辅助/数据色）
- **卡片**：玻璃拟态（`rgba(255,255,255,.05)` 背景 + `backdrop-filter: blur(12px)` + `1px rgba(255,255,255,.08)` 边框 + 圆角 `14px`）
- **文字层级**：标题 700 / 正文 400 / 次要 `rgba(255,255,255,.55)`；系统字体栈 `-apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`
- **动效**：hover 轻抬升（`translateY(-2px)` + 阴影增强），transition 200ms；弹幕滚动用 CSS 动画
- **响应式**：桌面多列/侧边栏布局；`max-width:768px` 时切换单列卡片流，触控目标 ≥44px；后台页窄屏时侧边栏折叠为顶部横条
- **细节**：滚动条美化（细、半透明）；数字用等宽字体 `font-variant-numeric: tabular-nums` 避免跳动；中文文案；空态提示
- 所有 fetch 需处理失败（显示轻量 toast/提示），后台请求 401 时清除 token 回到登录页
