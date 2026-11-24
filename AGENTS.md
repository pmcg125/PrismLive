# PrismLive 项目环境约束(长期记忆)

> 本项目所有工作必须遵守以下约束,违反即视为错误。

## 关键约束(不可违反)

1. **端口 8080 / 80 有重要业务运行,严禁使用**。分配任何新端口、配置任何服务、测试任何监听时,必须避开 80 和 8080(以及已被本项目占用的 1935/8888/9997/8083/8084/8090/19350/1986)。

2. **所有涉及下载国外文件的操作,优先使用镜像网站**:
   - GitHub 文件/Release:优先 `gh-proxy.com`、`gitcode.com` 等镜像
   - 若镜像不可用或不确定,必须先向用户确认后再直连
   - 严禁默认直接访问 github.com / 国外 CDN 下载

3. **ffmpeg 全量版已写入系统环境变量**,可直接在命令行使用 `ffmpeg` / `ffprobe`(gyan.dev full build)。

## 部署环境要点

- 本机**无公网 IP**,访问靠 Cloudflare 隧道(cloudflared,token 模式,Windows 服务)+ frp 转发
- 顶级域名 `silvegg.top`(DNS 托管 Cloudflare)
  - `live.silvegg.top` -> CF 隧道 -> 观众端 Node :8083(页面+弹幕,流量小保持 CF)
  - `stream.silvegg.top` -> **阿里云 ESA** -> frp:8888 -> MediaMTX(HLS,2026-08-10 上线,承担大流量分发)
  - `flv.silvegg.top` -> **阿里云 ESA** -> frp:8090 -> SRS(FLV 主链路,2026-08-10 上线)
  - ESA 接入:CNAME 模式(站点 silvegg.top);源站 `23.147.68.27`(A 记录);回源协议 HTTP,回源端口规则 flv=8090/stream=8888;证书 Let's Encrypt 泛域名 `*.silvegg.top`(自动续期);CF 侧 flv/stream 记录为**灰色仅 DNS**(CNAME 指向 `*.a1.initzz.com`),live 保持橙色代理
  - ⚠️ **ESA 缓存规则待配**:`*.m3u8`/`*.flv` 不缓存(始终回源),`*.ts` 缓存 15~30s;未配则默认点播式缓存会导致直播卡顿
- frp:跳板 `23.147.68.27:5443`,映射 8888、8090;配置文件在 `C:\Users\Administrator\Desktop\frp_0.70.1_windows_amd64\`
- FLV 核心:SRS 8.0.10 运行于 WSL Ubuntu,RTMP :19350 / FLV/HLS :8090 / API :1986
  - 配置 `/root/srs/srs.conf`,二进制 `/usr/local/srs/objs/srs`,日志 `/root/srs/srs.log`
  - sudo 密码 `mcl2009223`(允许接管 WSL)
- MediaMTX(Windows 本机):RTMP :1935 / HLS :8888 / API :9997

## 已知技术决策

- **播放引擎双模式**:`hls`(MediaMTX→hls.js,默认)/ `flv`(SRS→mpegts.js);**`playEngine=flv` 为有意选择**(2026-08-09 用户确认,SRS/FLV 直播效果好),勿改回
- **数据库流地址已切 CF 域名**(2026-08-09):`flvBaseUrl=https://flv.silvegg.top/live/<key>.flv`,`hlsBaseUrl=https://stream.silvegg.top/live/<key>/index.m3u8`(此前为 `http://23.147.68.27:8090/8888` frp IP,已弃用)
- **SRS http_server 无流挂起已知问题**(2026-08-09):`http_server`(:8090)对**不存在流的 FLV 请求**(`/live/<key>.flv`)会挂起不响应(TCP 已连、请求已记日志但无响应,无流时 API 路径正常);**推流状态下 FLV 拉流完全正常**(本地/CF/frp 均 200)。属 SRS 单线程构建(`--single-thread=on`)下 remux 协程无流时卡死,非本项目故障,记录备查
- MediaMTX `forward` 已配置转发到 SRS(`rtmp://127.0.0.1:19350/$MTX_PATH`),使 OBS 单推 MediaMTX 即可同时供给 FLV 链路
- OBS 推流地址:`rtmp://192.168.1.6:1935/live`(仅推 MediaMTX)
- **SRS 自启已集成进 `start.ps1`**(2026-08-09):启动时若 WSL 内 SRS 未运行则自动拉起,停止时优雅关闭 SRS 但**不关闭 WSL**;`-SkipSrs` 可跳过
  - SRS 以 `daemon off` + `nohup` 方式运行(无 systemd/crontab 自启),`srs.pid` 在 `/usr/local/srs/objs/srs.pid`
  - SRS sudo 密码可通过 `$env:SRS_SUDO_PW` 预设,避免脚本交互输入
  - SRS 双 HTTP:`http_api` 在 **1986**(API,如 `/api/v1/streams/`),`http_server` 在 **8090**(FLV 拉流,无 API)——查 SRS 流状态务必用 1986
- **DNS 已迁移到 Cloudflare**(2026-08-09):注册局 NS 为 `daphne`/`joaquin.ns.cloudflare.com`,阿里云 hichina NS 已删除;NS 变更传播中阿里 DNS(223.5.5.5)可能仍有旧缓存,国内观众解析可能暂时失败
- **`start.bat` 已废弃**(2026-08-09),统一使用 `start.ps1` 启动
- **frp 90 秒重连问题已修复**(2026-08-09):根因是 `tcpMux=true` 时 frp 0.7x 默认禁用应用层心跳(置 -1),而远端 frps 心跳超时=90s 收不到 Ping 就静默断连。修复:在 `frpc.toml` 显式设置 `transport.heartbeatInterval = 30` / `transport.heartbeatTimeout = 90`,强制客户端发心跳。修改前备份在 `frpc.toml.bak-20260809`
