(function() {
    'use strict';

    // ==================== 常量 ====================

    const EMOJI_LIST = [
        '😀','😂','🤣','😊','😍','🥰','😘','😜','🤔','😎',
        '🥳','😭','😡','🤯','🥶','🤡','👍','👎','👏','🙌',
        '🤝','🙏','💪','🔥','❤️','💖','💔','🎉','🎁','✨',
        '🌟','💯','🚀','🎯','🎮','🎵','🍺','🍕','🍰','🍿',
        '🐶','🐱','🦊','🐼','🐷','🐸','🐙','🦄','🌈','☀️',
        '🌙','⭐','⚡','💧','🌊','🌸','🌹','🎤','🎧','📷'
    ];

    const DANMAKU_HISTORY_MAX = 20;
    const DANMAKU_OVERLAY_MAX = 200;
    const DANMAKU_SPEED = 180; // px/s
    const DANMAKU_TRACK_HEIGHT = 42;
    const DANMAKU_TRACK_MARGIN_MS = 200;
    const JOIN_TIMEOUT_MS = 10000;
    const CHAT_ITEM_LIMIT = 100;
    // F9 修复: FLV 主线程 transmuxer 长直播内存累积的回收周期。
    // mpegts.js enableWorker 在本项目加载路径下必然回退 inline (主线程),
    // 长时间直播会累积内存/GC 压力导致"开播一段时间后频繁缓冲且随时间恶化"。
    // 每 FLV_RECYCLE_INTERVAL_MS 强制销毁重建一次播放器, 释放累积, 代价是
    // 重建瞬间约 1-2s 短暂续播。0 = 禁用 (仅在需要时显式开启)。
    const FLV_RECYCLE_INTERVAL_MS = 20 * 60 * 1000;

    // 本地存储 key
    const LS_NAME = 'prismlive_name';
    const LS_QQ = 'prismlive_qq';
    const LS_HISTORY = 'prismlive_danmaku_history';
    const LS_SETTINGS = 'prismlive_viewer_settings';

    // ==================== 状态 ====================

    let socket = null;
    let currentUser = null;
    let config = null;
    let peakOnline = 0;
    let currentOnline = 0;   // 当前在线人数 (区别于 peakOnline 峰值)
    let joinPayload = null;
    let reconnectCount = 0;
    let currentColor = '#ffffff';
    let inputHistory = [];
    let historyIndex = -1;
    let danmakuTracks = [];
    let isLiveRoomVisible = false;
    let shownEmojiPanel = false;
    let shownColorPanel = false;
    let shownSettingsPanel = false;
    let kickedByAdmin = false;
    let hls = null; // hls.js 实例 (Chrome/FF 等无原生 HLS 的浏览器)
    // 卡顿恢复状态 (提升到模块作用域: setupBufferUI 有一次性守卫, 闭包变量
    // 全生命周期只创建一次, 必须在 stopStream 里重置, 否则会残留到下一场次)
    let wasWaiting = false;          // 是否刚从 waiting 状态恢复 (一次性标记)
    let lastRecoverySeekAt = 0;      // 上次恢复 seek 时间戳 (15s 冷却用)
    // 播放错误恢复计数 (每次 playStream 新开播放会话时归零):
    let netRetryCount = 0;           // m3: fatal NETWORK_ERROR 后 startLoad 重试次数
    let mediaRecoverCount = 0;       // m4: recoverMediaError 尝试次数
    let nativeReloadCount = 0;       // F7: Safari 原生路径 error 自愈重载次数
    let nativeReloadSeq = 0;         // F7: 自愈序号, stopStream 递增以取消挂起重载
    let bannerHideTimer = null;      // F6: 横幅自动隐藏定时器 id
    // Task #13: HTTP-FLV 播放状态 (mpegts.js)
    let flvPlayer = null;            // mpegts.js 播放器实例
    let flvFailed = false;           // 会话级一次性回退标记: FLV 出错后本场不再重试,
                                     // 流彻底停止 (isStreaming 转 false) 后复位
    let currentFlvUrl = null;        // FLV 同地址守卫用的当前地址
                                     // (独立变量, 不占用 dataset.currentSrc —— 避免
                                     // F7 原生 HLS 自愈把 FLV 地址当原生 HLS 误重载)
    let flvStartWatchdog = null;     // Task #15: FLV 起播看门狗定时器 id
                                     // (防御静默失败: 到期未起播则回退 HLS)
    let flvRecycleTimer = null;      // F9: FLV 周期性重建定时器 id (长直播内存回收)
    let configFetchSeq = 0;          // 最终修复轮 F3: 引擎切换 fetch 单调序号,
                                     // 丢弃过期响应, 防乱序覆盖新配置
    let qqFetchTimer = null;          // QQ 号输入防抖定时器
    let lastFetchedQQ = '';           // 上次成功获取的 QQ 号 (避免重复请求)
    let lastQQNickname = '';          // 上次成功获取的 QQ 昵称 (提交时兆底)
    let viewerList = [];              // 当前在线观众列表
    let viewerListVisible = false;    // 观众列表面板是否显示

    const viewerSettings = loadViewerSettings();

    // ==================== DOM 引用 ====================

    const elements = {
        toastContainer: document.getElementById('toast-container'),
        entryGate: document.getElementById('entry-gate'),
        liveRoom: document.getElementById('live-room'),
        entryForm: document.getElementById('entry-form'),
        nameInput: document.getElementById('name-input'),
        qqInput: document.getElementById('qq-input'),
        avatarPreview: document.getElementById('avatar-preview'),
        avatarImg: document.getElementById('avatar-img'),
        joinBtn: document.getElementById('join-btn'),
        userAvatar: document.getElementById('user-avatar'),
        liveTitle: document.getElementById('live-title'),
        liveAnnouncement: document.getElementById('live-announcement'),
        liveStatusDot: document.getElementById('live-status-dot'),
        liveBadge: document.getElementById('live-badge'),
        onlineCount: document.getElementById('online-count'),
        peakCount: document.getElementById('peak-count'),
        disconnectedBanner: document.getElementById('disconnected-banner'),
        bannerText: document.getElementById('banner-text'),
        liveVideo: document.getElementById('live-video'),
        videoContainer: document.getElementById('video-container'),
        videoSkeleton: document.getElementById('video-skeleton'),
        notStreaming: document.getElementById('not-streaming'),
        notStreamingTitle: document.getElementById('not-streaming-title'),
        notStreamingDesc: document.getElementById('not-streaming-desc'),
        backToGate: document.getElementById('back-to-gate'),
        bufferOverlay: document.getElementById('buffer-overlay'),
        bufferText: document.getElementById('buffer-text'),
        catchUpBtn: document.getElementById('catch-up-btn'),
        playerControls: document.getElementById('player-controls'),
        pcLiveBadge: document.getElementById('pc-live-badge'),
        pcTime: document.getElementById('pc-time'),
        pcDelay: document.getElementById('pc-delay'),
        pcMuteBtn: document.getElementById('pc-mute-btn'),
        pcVolOn: document.getElementById('pc-vol-on'),
        pcVolOff: document.getElementById('pc-vol-off'),
        pcFullscreenBtn: document.getElementById('pc-fullscreen-btn'),
        pcFsEnter: document.getElementById('pc-fs-enter'),
        pcFsExit: document.getElementById('pc-fs-exit'),
        pcVolume: document.getElementById('pc-volume'),
        danmakuOverlay: document.getElementById('danmaku-overlay'),
        systemMessages: document.getElementById('system-messages'),
        chatList: document.getElementById('chat-list'),
        danmakuInputContainer: document.getElementById('danmaku-input-container'),
        danmakuInput: document.getElementById('danmaku-input'),
        sendBtn: document.getElementById('send-btn'),
        danmakuDisabled: document.getElementById('danmaku-disabled'),
        likeBtn: document.getElementById('like-btn'),
        likeCountEl: document.getElementById('like-count'),
        likeBubbles: document.getElementById('like-bubbles'),
        emojiBtn: document.getElementById('emoji-btn'),
        colorBtn: document.getElementById('color-btn'),
        currentColorDot: document.getElementById('current-color-dot'),
        emojiPanel: document.getElementById('emoji-panel'),
        colorPalette: document.getElementById('color-palette'),
        settingsBtn: document.getElementById('danmaku-settings-btn'),
        settingsPanel: document.getElementById('danmaku-settings-panel'),
        fontSizeControl: document.getElementById('font-size-control'),
        danmakuOpacity: document.getElementById('danmaku-opacity'),
        opacityValue: document.getElementById('opacity-value'),
        areaControl: document.getElementById('area-control'),
        // 观众列表
        viewerListToggle: document.getElementById('viewer-list-toggle'),
        viewerListPanel: document.getElementById('viewer-list-panel'),
        viewerListCount: document.getElementById('viewer-list-count'),
        viewerListBody: document.getElementById('viewer-list-body'),
        viewerListClose: document.getElementById('viewer-list-close')
    };

    // ==================== 工具函数 ====================

    function showToast(message, type = 'info') {
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.textContent = message;
        elements.toastContainer.appendChild(toast);
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateX(20px)';
            toast.style.transition = '0.3s ease';
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text == null ? '' : String(text);
        return div.innerHTML;
    }

    function avatarFallback(name) {
        const ch = (name && name[0]) ? name[0].toUpperCase() : '?';
        const safe = ch.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
        return 'data:image/svg+xml,' + encodeURIComponent(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
            '<circle cx="50" cy="50" r="50" fill="#7c5cff"/>' +
            '<text x="50" y="68" text-anchor="middle" fill="white" font-size="44" font-family="sans-serif">' + safe + '</text>' +
            '</svg>'
        );
    }

    function getAvatarUrl(qq) {
        if (!qq || !/^\d{5,}$/.test(qq.trim())) return '';
        return `https://q1.qlogo.cn/g?b=qq&nk=${qq.trim()}&s=640`;
    }

    // 通过服务端代理获取 QQ 昵称 + 头像
    async function fetchQQInfo(qq) {
        if (!qq || !/^\d{5,12}$/.test(qq)) return null;
        try {
            const res = await fetch(`/api/qqinfo?qq=${encodeURIComponent(qq)}`, {
                signal: AbortSignal.timeout(8000),
            });
            if (!res.ok) return null;
            return await res.json();
        } catch (e) {
            return null;
        }
    }

    // QQ 号输入变化时: 防抖获取昵称 + 头像
    async function onQQInputChange() {
        const qq = elements.qqInput.value.trim();
        if (!qq || !/^\d{5,12}$/.test(qq)) {
            elements.avatarPreview.classList.add('hidden');
            elements.nameInput.value = '';
            return;
        }
        // 头像即时更新 (无需等接口)
        const avatarUrl = getAvatarUrl(qq);
        if (avatarUrl) {
            elements.avatarImg.src = avatarUrl;
            elements.avatarPreview.classList.remove('hidden');
        }
        // 已获取过且 QQ 号没变, 跳过
        if (qq === lastFetchedQQ) return;
        // 防抖 800ms
        if (qqFetchTimer) clearTimeout(qqFetchTimer);
        qqFetchTimer = setTimeout(async () => {
            qqFetchTimer = null;
            elements.nameInput.value = '';
            elements.nameInput.placeholder = '正在获取昵称…';
            const info = await fetchQQInfo(qq);
            elements.nameInput.placeholder = '输入 QQ 号后自动获取';
            if (info && info.nickname) {
                lastFetchedQQ = qq;
                lastQQNickname = info.nickname;
                elements.nameInput.value = info.nickname;
            } else if (info) {
                // 接口成功但无昵称, 用 QQ 号作为昵称
                lastFetchedQQ = qq;
                lastQQNickname = `QQ${qq}`;
                elements.nameInput.value = lastQQNickname;
            } else {
                // 获取失败, 用 QQ 号作为昵称兆底
                lastFetchedQQ = qq;
                lastQQNickname = `QQ${qq}`;
                elements.nameInput.value = lastQQNickname;
            }
        }, 800);
    }

    function saveUserInfo(name, qq) {
        localStorage.setItem(LS_QQ, qq);
        // 不再缓存昵称 (昵称始终从 QQ 接口实时获取)
        localStorage.removeItem(LS_NAME);
    }

    function loadUserInfo() {
        return {
            qq: localStorage.getItem(LS_QQ) || ''
        };
    }

    // 主动清空客户端缓存 (会话级数据)
    function clearClientCache() {
        localStorage.removeItem(LS_QQ);
        localStorage.removeItem(LS_NAME);   // 清理可能残留的旧版昵称缓存
        localStorage.removeItem(LS_HISTORY); // 弹幕输入历史
        // 保留 LS_SETTINGS (用户偏好设置: 字号/透明度/区埣, 跨会话保留)
    }

    function loadViewerSettings() {
        const defaults = { fontSize: 'medium', opacity: 100, area: 'full' };
        try {
            const raw = localStorage.getItem(LS_SETTINGS);
            if (raw) {
                const s = JSON.parse(raw) || {};
                // m8 修复: 逐字段校验兜底 —— localStorage 被篡改成非法值时
                // (如 opacity 为 NaN) 回退默认, 不让脏数据污染弹幕样式
                const opacity = Number(s.opacity);
                return {
                    fontSize: ['small', 'medium', 'large'].indexOf(s.fontSize) >= 0 ? s.fontSize : defaults.fontSize,
                    opacity: Number.isFinite(opacity) && opacity >= 0 && opacity <= 100 ? opacity : defaults.opacity,
                    area: ['full', 'half'].indexOf(s.area) >= 0 ? s.area : defaults.area,
                };
            }
        } catch (e) { /* ignore */ }
        return defaults;
    }

    function saveViewerSettings() {
        localStorage.setItem(LS_SETTINGS, JSON.stringify(viewerSettings));
    }

    function loadInputHistory() {
        try {
            const raw = localStorage.getItem(LS_HISTORY);
            if (raw) return JSON.parse(raw);
        } catch (e) { /* ignore */ }
        return [];
    }

    function saveInputHistory() {
        localStorage.setItem(LS_HISTORY, JSON.stringify(inputHistory.slice(-DANMAKU_HISTORY_MAX)));
    }

    function pushInputHistory(text) {
        if (!text) return;
        if (inputHistory[inputHistory.length - 1] === text) return;
        inputHistory.push(text);
        if (inputHistory.length > DANMAKU_HISTORY_MAX) inputHistory.shift();
        saveInputHistory();
        historyIndex = -1;
    }

    function animateNumber(el, from, to) {
        if (!el) return;
        from = Number(from) || 0;
        to = Number(to) || 0;
        if (from === to) { el.textContent = to; return; }
        const duration = 450;
        const start = performance.now();
        function step(now) {
            const t = Math.min((now - start) / duration, 1);
            const ease = 1 - Math.pow(1 - t, 3);
            const val = Math.round(from + (to - from) * ease);
            el.textContent = val;
            if (t < 1) requestAnimationFrame(step);
        }
        requestAnimationFrame(step);
    }

    // ==================== 入口页 ====================

    function initEntryGate() {
        const saved = loadUserInfo();
        if (saved.qq) {
            elements.qqInput.value = saved.qq;
            // 触发 QQ 信息获取 (昵称 + 头像)
            onQQInputChange();
        }

        elements.qqInput.addEventListener('input', function() {
            onQQInputChange();
        });

        elements.entryForm.addEventListener('submit', function(e) {
            e.preventDefault();
            const qq = elements.qqInput.value.trim();
            if (!qq || !/^\d{5,12}$/.test(qq)) {
                showToast('请输入正确的 QQ 号', 'error');
                return;
            }
            const name = elements.nameInput.value.trim();
            if (!name) {
                showToast('正在获取 QQ 信息，请稍候', 'error');
                return;
            }
            enterRoom(name, qq, lastQQNickname);
        });

        // 点击面板外部关闭（全局只绑定一次）
        setupGlobalClickHandlers();
    }

    function updateAvatarPreview(qq) {
        const url = getAvatarUrl(qq);
        if (url) {
            elements.avatarImg.src = url;
            elements.avatarPreview.classList.remove('hidden');
        } else {
            elements.avatarPreview.classList.add('hidden');
        }
    }

    // ==================== 进入直播间 ====================

    async function enterRoom(name, qq, qqNickname) {
        // 昵称优先级: 手动输入 > QQ 昵称 > 默认
        const displayName = name || qqNickname || 'QQ用户';
        elements.joinBtn.disabled = true;
        const originalText = elements.joinBtn.querySelector('.btn-text').textContent;
        elements.joinBtn.querySelector('.btn-text').textContent = '进入中…';

        try {
            const res = await fetch('/api/online');
            const onlineData = await res.json();
            peakOnline = onlineData.peakOnline;

            socket = io({ transports: ['websocket', 'polling'], reconnectionDelay: 1000 });
            // F1 修复: 用局部变量钉住本次会话的 socket 实例。
            // 弱网下超时/ack 回调可能迟到数秒, 此时用户可能已重新提交建了新
            // socket B —— 回调若直接操作模块级 socket 会摧毁 B, 导致按钮永久
            // 停在"进入中…"。所有回调先做同一性校验 (socket === s)。
            const s = socket;
            const avatar = getAvatarUrl(qq);
            joinPayload = { name: displayName, qq, avatar };

            // 先注册事件监听
            setupSocketListeners();

            // 清理本次会话实例: 仅当 s 仍是当前会话时才置空模块变量,
            // 否则只断开 s 自己, 绝不动新会话
            const cleanupSession = () => {
                s.removeAllListeners();
                s.disconnect();
                if (socket === s) socket = null;
            };

            const joinTimeout = setTimeout(() => {
                // 已被新会话替换: 静默清理旧实例即可, 不弹提示不动按钮
                if (socket !== s) { cleanupSession(); return; }
                showToast('连接服务器超时，请稍后重试', 'error');
                resetJoinButton(originalText);
                // 彻底清理: 断开 + 移除监听器 + 置空, 避免残留 socket 在重连时触发 join
                cleanupSession();
                // F3: 失败退出归零重连计数, 防止下次全新进入误闪"已恢复连接"横幅
                reconnectCount = 0;
            }, JOIN_TIMEOUT_MS);

            s.emit('join', joinPayload, function(response) {
                clearTimeout(joinTimeout);
                if (!response || !response.ok) {
                    // 已被新会话替换: 只清理 s 自己, 提示与按钮交给新会话
                    if (socket !== s) { cleanupSession(); return; }
                    showToast((response && response.error) || '进入失败', 'error');
                    resetJoinButton(originalText);
                    // M1 修复: 与超时分支相同的三步清理 —— 失败 (被拒/黑名单) 后
                    // 残留 socket 仍会收全局广播, 用户换昵称重进再建新 socket
                    // 会导致弹幕/系统消息双份渲染
                    cleanupSession();
                    // F3: 同上
                    reconnectCount = 0;
                    return;
                }

                // 成功 ack 迟到防护: 若已换新会话, 丢弃本次结果并清理 s,
                // 绝不覆盖新会话状态
                if (socket !== s) { cleanupSession(); return; }

                currentUser = response.user;
                config = response.config;
                currentOnline = response.online;
                peakOnline = Math.max(peakOnline, response.online);
                inputHistory = loadInputHistory();

                // 首次进入: 渲染服务端下发的弹幕历史 (保留此前弹幕)
                if (Array.isArray(response.danmakuHistory) && response.danmakuHistory.length) {
                    renderHistoryMessages(response.danmakuHistory);
                }

                // 初始化观众列表 (进入时即可看到其他观众)
                if (Array.isArray(response.viewerList)) {
                    updateViewerList(response.viewerList);
                }

                // 初始化全局点赞数 (服务端累计)
                if (typeof response.totalLikes === 'number') {
                    elements.likeCountEl.textContent = response.totalLikes;
                }

                saveUserInfo(displayName, qq);
                showLiveRoom();
            });
        } catch (error) {
            showToast('网络错误，请稍后重试', 'error');
            resetJoinButton(originalText);
        }
    }

    function resetJoinButton(text) {
        elements.joinBtn.disabled = false;
        elements.joinBtn.querySelector('.btn-text').textContent = text;
    }

    // ==================== Socket 事件 ====================

    function setupSocketListeners() {
        socket.on('connect', function() {
            // m1 修复: Socket.IO v4 不再触发 'reconnect' 事件, 恢复横幅改在
            // 'connect' 里按 reconnectCount>0 判断短暂显示
            if (reconnectCount > 0) {
                showDisconnectedBanner('已恢复连接', true);
            } else {
                hideDisconnectedBanner(true);
            }
            if (currentUser && joinPayload) {
                reconnectCount = 0;
                // 重连: 不渲染 danmakuHistory (前端已保留弹幕, 避免重复显示)
                // 附 rejoin 标记: 服务端据此不重复计今日观看/不重复广播进场
                // (见 server.js join 处理器, m7 修复)
                socket.emit('join', Object.assign({}, joinPayload, { rejoin: true }), function(response) {
                    if (response && response.ok) {
                        currentUser = response.user;
                        config = response.config;
                        updateRoomConfig();
                    } else {
                        // m5 修复: rejoin 被拒 (如会话期间被拉黑) 不能静默吞掉,
                        // 否则用户停留在假在线状态; 回入口页并提示原因
                        showToast((response && response.error) || '重连被拒绝，请重新进入', 'error');
                        backToGate();
                    }
                });
            }
        });

        socket.on('disconnect', function() {
            // 被管理员踢出时不显示重连提示
            if (kickedByAdmin) {
                kickedByAdmin = false;
                hideDisconnectedBanner(true);
                return;
            }
            reconnectCount += 1;
            showDisconnectedBanner(`连接中断，重连中（第 ${reconnectCount} 次）…`);
        });

        // 注: 原 socket.on('reconnect') 监听已移除 —— Socket.IO v4 中该事件
        // 永不触发 (恢复横幅逻辑合并到上方 'connect' 处理器)

        socket.on('danmaku', function(data) {
            addDanmaku(data);
        });

        // 点赞: 其他观众点赞时本机显示气泡 + 全局总数更新
        socket.on('like_bubble', function() {
            handleLikeBubble();
        });
        socket.on('like_update', function(data) {
            handleLikeUpdate(data);
        });

        socket.on('system', function(data) {
            addSystemMessage(data.text);
        });

        // 推流关闭时服务端广播: 清空所有弹幕
        socket.on('danmaku_cleared', function(data) {
            clearAllDanmaku();
            if (data && data.reason) addSystemMessage(data.reason);
        });

        socket.on('online', function(data) {
            const oldOnline = Number(elements.onlineCount.textContent) || 0;
            currentOnline = data.online;
            animateNumber(elements.onlineCount, oldOnline, data.online);
            if (data.online > peakOnline) {
                animateNumber(elements.peakCount, peakOnline, data.online);
                peakOnline = data.online;
            }
        });

        // 观众列表更新
        socket.on('viewer_list', function(list) {
            updateViewerList(list);
        });

        socket.on('config_update', function(newConfig) {
            // M3 修复: 广播载荷不再携带 hlsUrl (服务端按管理员请求 host 构造,
            // 可能广播出 localhost:8888 等远程观众不可达的地址)。
            // 保留 join ack 时已持有的播放地址, 不重建播放 ——
            // 仅更新标题/公告/开关等; 与服务端广播改动对齐 (见 server.js)
            if (config && config.hlsUrl && !newConfig.hlsUrl) {
                newConfig.hlsUrl = config.hlsUrl;
            }
            // Task #13: flvUrl 同理被剔除 (M3 模式), 保留 join ack 持有的地址
            if (config && config.flvUrl && !newConfig.flvUrl) {
                newConfig.flvUrl = config.flvUrl;
            }
            // Task #13: 引擎切换通道 (F2 模式) —— playEngine 变化时旧地址不可复用,
            // 需 fetch /api/config 按观众自身 host 取正确地址重建
            // (参照 stream_key_changed 处理器的写法)
            if (config && config.playEngine !== newConfig.playEngine) {
                // F3 修复: 单调序号保护 —— 连续多次引擎切换时 fetch 乱序返回,
                // 只应用最新一次, 过期响应丢弃 (回调内比对序号)
                const seq = ++configFetchSeq;
                fetch('/api/config')
                    .then(function(res) { return res.json(); })
                    .then(function(fresh) {
                        if (seq !== configFetchSeq) return; // 过期响应, 丢弃
                        if (!fresh) return;
                        config = fresh;
                        updateRoomConfig();
                    })
                    .catch(function() { /* 拉取失败保持现状, 等待下次配置/状态事件 */ });
                return;
            }
            config = newConfig;
            updateRoomConfig();
        });

        socket.on('stream_state', function(state) {
            if (config) {
                config.streaming = !!state.streaming;
                updateRoomConfig();
            }
        });

        // F2 修复: 推流密钥重置后的换流通道。
        // 背景: M3 修复后 config_update 不再携带 hlsUrl, 而 key reset 只回包
        // 不广播 → 观众端旧 manifest 404, m3 重试耗尽后永久停在"直播信号异常"。
        // 服务端广播本事件时不携带任何按请求 host 构造的地址,
        // 客户端主动 fetch /api/config —— HTTP 请求按观众自身 host 推导出
        // 正确的 hlsUrl, 再走 updateRoomConfig → playStream 重建
        // (同 URL 早退守卫保证误触发无害)。与服务端广播对齐 (见 server.js)
        socket.on('stream_key_changed', function() {
            fetch('/api/config')
                .then(function(res) { return res.json(); })
                .then(function(newConfig) {
                    if (!newConfig) return;
                    config = newConfig;
                    updateRoomConfig();
                })
                .catch(function() { /* 拉取失败保持现状, 等待下次配置/状态事件 */ });
        });

        socket.on('kicked', function(data) {
            const reason = (data && data.reason) || '您已被移出直播间';
            showToast(reason, 'error');
            kickedByAdmin = true;
            socket.disconnect();
            backToGate();
        });
    }

    function showDisconnectedBanner(text, reconnected = false) {
        // F6: 显示新横幅前先清掉上一次的自动隐藏定时器 —— 否则"已恢复连接"
        // 的 1.8s 隐藏定时器会吞掉随后出现的"连接中断"横幅
        if (bannerHideTimer) { clearTimeout(bannerHideTimer); bannerHideTimer = null; }
        elements.disconnectedBanner.classList.remove('hidden');
        elements.disconnectedBanner.classList.toggle('reconnected', reconnected);
        elements.bannerText.textContent = text;
        if (reconnected) {
            bannerHideTimer = setTimeout(() => {
                bannerHideTimer = null;
                hideDisconnectedBanner(false);
            }, 1800);
        }
    }

    function hideDisconnectedBanner(clearText) {
        // F6: 隐藏时同样取消挂起的自动隐藏定时器, 保持状态单一
        if (bannerHideTimer) { clearTimeout(bannerHideTimer); bannerHideTimer = null; }
        elements.disconnectedBanner.classList.add('hidden');
        elements.disconnectedBanner.classList.remove('reconnected');
        if (clearText) elements.bannerText.textContent = '连接中断，重连中…';
    }

    // ==================== 直播间渲染 ====================

    function showLiveRoom() {
        elements.entryGate.classList.add('hidden');
        elements.liveRoom.classList.remove('hidden');
        isLiveRoomVisible = true;

        elements.userAvatar.src = currentUser.avatar || avatarFallback(currentUser.name);
        animateNumber(elements.onlineCount, 0, currentOnline);
        animateNumber(elements.peakCount, 0, peakOnline);
        // 重置点赞计数显示 (join ack 会下发正确值)
        elements.likeCountEl.textContent = '0';

        elements.videoSkeleton.classList.remove('hidden');

        updateRoomConfig();
        setupDanmakuInput();
        setupLikeButton();
        setupEmojiPanel();
        setupColorPalette();
        setupDanmakuSettings();
        setupCustomPlayer();
        setupBufferUI();
        setupBackToGate();
        setupViewerList();

        setTimeout(() => {
            elements.videoSkeleton.classList.add('hidden');
            // 首次进入引导: 提示双击可全屏 (延迟显示, 避免被骨架屏遮挡)
            showToast('双击视频可全屏', 'info');
        }, 500);
    }

    function updateRoomConfig() {
        if (!config) return;

        const title = config.liveTitle || 'PrismLive 直播间';
        const announcement = config.liveAnnouncement || '';

        elements.liveTitle.textContent = title;
        document.title = title;
        elements.liveAnnouncement.textContent = announcement;

        // Task #13: 引擎分叉 —— 仅当 playEngine='flv' 且 flvUrl 可用且本会话未回退
        // 时走 FLV; 否则走原 HLS 路径 (默认 playEngine='hls' 时与原逻辑逐字节等价)
        const flvReady = config.playEngine === 'flv' && !!config.flvUrl && !flvFailed;
        const isStreaming = config.liveEnabled && config.streaming && (flvReady ? config.flvUrl : config.hlsUrl);
        elements.liveStatusDot.classList.toggle('live', isStreaming);
        elements.liveBadge.classList.toggle('hidden', !isStreaming);
        // 播放器品牌光晕: 推流中点亮边框
        if (elements.videoContainer) elements.videoContainer.classList.toggle('is-live', isStreaming);
        // 控制条内直播徽章同步
        if (elements.pcLiveBadge) elements.pcLiveBadge.classList.toggle('hidden', !isStreaming);

        if (isStreaming) {
            elements.notStreaming.classList.add('hidden');
            // Task #13: 引擎分叉 —— FLV 可用时优先 FLV, 否则走原 HLS 路径
            if (flvReady) {
                playFLV(config.flvUrl);
            } else {
                playStream(config.hlsUrl);
            }
            elements.notStreamingTitle.textContent = '主播还没开播';
            elements.notStreamingDesc.textContent = '请稍后再来，或等待主播开播通知';
        } else {
            stopStream();
            // Task #13: 流彻底停止后复位回退标记, 允许下一场次重试 FLV
            flvFailed = false;
            elements.notStreaming.classList.remove('hidden');
            if (!config.liveEnabled) {
                elements.notStreamingTitle.textContent = '直播间已关闭';
                elements.notStreamingDesc.textContent = '当前直播间未开启，请联系管理员';
            } else if (config.streaming && !config.hlsUrl) {
                // m8 修复: 推流中但播放地址缺失 (如隧道模式未配置 hlsBaseUrl
                // 推导失败) 时给出明确提示, 不再静默黑屏伪装成"未开播"
                elements.notStreamingTitle.textContent = '播放地址未配置';
                elements.notStreamingDesc.textContent = '请联系主播检查 HLS 播放地址配置';
            } else {
                elements.notStreamingTitle.textContent = '主播还没开播';
                elements.notStreamingDesc.textContent = '请稍后再来，或等待主播开播通知';
            }
            elements.liveVideo.removeAttribute('src');
            elements.liveVideo.load();
        }

        if (config.danmakuEnabled) {
            elements.danmakuInputContainer.classList.remove('hidden');
            elements.danmakuDisabled.classList.remove('visible');
        } else {
            elements.danmakuInputContainer.classList.add('hidden');
            elements.danmakuDisabled.classList.add('visible');
        }

        applyViewerSettings();
    }

    // ==================== HLS 播放 (hls.js + 原生回退) ====================

    // 停止当前播放并清理 hls.js 实例
    function stopStream() {
        // Task #13: 回收 FLV 播放器 (幂等: flvPlayer 为空时无操作)
        stopFLV();
        // 清理延迟守护定时器
        if (window.__latencyGuardTimer) {
            clearInterval(window.__latencyGuardTimer);
            window.__latencyGuardTimer = null;
        }
        // 重置卡顿恢复状态: 停播/被踢/换流重建/fatal 错误都走这里,
        // 防止冷却残留拦截新场次首次应有的恢复 seek、防止 wasWaiting 脏状态
        wasWaiting = false;
        lastRecoverySeekAt = 0;
        nativeReloadCount = 0;   // F7: 自愈额度随场次重置
        nativeReloadSeq += 1;    // F7: 取消挂起的自愈重载 (序号失效)
        if (hls) {
            hls.destroy();
            hls = null;
        }
        if (elements.liveVideo && elements.liveVideo.src) {
            elements.liveVideo.removeAttribute('src');
            elements.liveVideo.load();
        }
        // 清除原生播放地址记录 (M2 同地址守卫), 防止残留拦截新场次起播
        if (elements.liveVideo) elements.liveVideo.dataset.currentSrc = '';
    }

    // ===== HTTP-FLV 播放 (mpegts.js, Task #13) =====

    // 停止 FLV 播放并释放 mpegts.js 实例 (回收纪律参照 stopStream)
    function stopFLV() {
        // Task #15: 清起播看门狗, 防止跨场次/回退后误触发
        if (flvStartWatchdog) {
            clearTimeout(flvStartWatchdog);
            flvStartWatchdog = null;
        }
        // F9: 清周期性重建定时器 (任何停 FLV 的路径都要回收, 防泄漏)
        if (flvRecycleTimer) {
            clearInterval(flvRecycleTimer);
            flvRecycleTimer = null;
        }
        if (flvPlayer) {
            try {
                flvPlayer.pause();
                flvPlayer.unload();
                flvPlayer.detachMediaElement();
                flvPlayer.destroy();
            } catch (e) { /* 释放期异常忽略 */ }
            flvPlayer = null;
        }
        currentFlvUrl = null;
    }

    // FLV 失败一次性回退: 标记本会话、释放 FLV; 流仍活跃则立即切 HLS。
    // flvFailed 在流彻底停止 (isStreaming 转 false) 后复位, 允许下场重试 FLV
    function fallbackToHls() {
        flvFailed = true;
        stopFLV();
        if (config && config.liveEnabled && config.streaming && config.hlsUrl) {
            playStream(config.hlsUrl);
        }
    }

    function playFLV(url) {
        const video = elements.liveVideo;
        if (!video || !url) return;
        // 同地址守卫 (M2 模式): 用独立 currentFlvUrl, 不占用 dataset.currentSrc,
        // 避免 F7 原生 HLS 自愈误把 FLV 地址重载
        if (flvPlayer && currentFlvUrl === url) return;
        stopFLV();
        // 引擎切换: 先回收 HLS 实例, 避免双引擎同时占用同一 video 元素
        if (hls) stopStream();
        // F5 修复: 清原生播放地址记录 —— 若上一段是 Safari 原生 HLS,
        // dataset.currentSrc 残留会使 F7 自愈/同址守卫误判 FLV 会话状态
        if (elements.liveVideo) elements.liveVideo.dataset.currentSrc = '';

        if (!window.mpegts || !window.mpegts.getFeatureList().mseLivePlayback) {
            console.warn('[PrismLive] 浏览器不支持 MSE 直播播放, 回退 HLS');
            fallbackToHls();
            return;
        }

        flvPlayer = window.mpegts.createPlayer(
            { type: 'flv', isLive: true, url: url },
            {
                // Task #15 修复: vendor 别名路由下 mpegts.js 无法定位自身 worker
                // 脚本, enableWorker:true 会在 MSE onSourceOpen 后静默挂死
                // (不发 .flv 请求、readyState 恒 0、无 ERROR 事件 → 回退永不触发)。
                // 浏览器对照实验验证 false 可正常起播, 故禁用 worker 模式。
                enableWorker: false,
                // F10 修复: 主线程 transmuxer 长直播缓冲累积 (Chrome QuotaExceededError)
                // 根因: mpegts.js autoCleanup 默认向后保留 180s, 高码率 (6Mbps≈750KB/s)
                //      累积 135MB 顶到 Chrome SourceBuffer 内存上限 → appendBuffer 抛
                //      QuotaExceededError → 播放中断 → "开播一段时间后频繁缓冲且随时间恶化"。
                // 修复: 收紧清理阈值 (B站 flv.js 官方直播配置思路):
                //   - autoCleanupMaxBackwardDuration 180→30s: 向后缓冲超 30s 即清理
                //   - autoCleanupMinBackwardDuration 120→10s: 清理后保留 10s 回看
                //   - enableStashBuffer false: 关 IO 暂存, 减少主线程滞留量 (B站推荐)
                //   - liveBufferLatencyMaxLatency 收紧到 10s: 延迟超 10s 强制追帧
                lazyLoad: false,
                enableStashBuffer: false,
                stashInitialSize: 128,
                autoCleanupSourceBuffer: true,
                autoCleanupMaxBackwardDuration: 30,
                autoCleanupMinBackwardDuration: 10,
                liveBufferLatencyChasing: true,
                liveBufferLatencyMaxLatency: 10,
                liveBufferLatencyMinRemain: 2,
            }
        );
        currentFlvUrl = url;
        flvPlayer.on(window.mpegts.Events.ERROR, (errType, errDetail, errInfo) => {
            console.warn('[PrismLive] FLV 播放错误, 回退 HLS:', errType, errDetail, errInfo);
            fallbackToHls();
        });
        flvPlayer.attachMediaElement(video);

        // Task #15: 起播看门狗 —— 防御未来再出现静默失败 (无 ERROR 事件、
        // 加载器不启动): 12s 内未真正起播 (readyState < 2 且未在暂停自愈中)
        // 则判定起播失败, 回退 HLS; 起播成功 ('playing') 后清除
        const onPlaying = () => {
            if (flvStartWatchdog) {
                clearTimeout(flvStartWatchdog);
                flvStartWatchdog = null;
            }
        };
        video.addEventListener('playing', onPlaying, { once: true });
        flvStartWatchdog = setTimeout(() => {
            flvStartWatchdog = null;
            video.removeEventListener('playing', onPlaying);
            // 已有足够数据起播 ('playing' 监听未触发的边角情况, 双保险);
            // 注: autoplay 被拦截时数据已就绪 readyState 也 >= 2, 同样不判失败
            if (video.readyState >= 2) return;
            console.warn('[PrismLive] FLV 起播超时 (12s 看门狗, readyState=' + video.readyState + '), 回退 HLS');
            stopFLV();
            fallbackToHls();
        }, 12000);

        flvPlayer.load();
        flvPlayer.play().catch(() => {});

        // F9: 周期性重建 —— 主线程 transmuxer 长直播内存累积的兜底回收。
        // 重建时直接用当前地址重播: stopFLV() 清空 flvPlayer/currentFlvUrl
        // 后同地址守卫放行, 无需经过 updateRoomConfig (避免依赖全局状态)。
        // 仅当 FLV 会话仍活跃 (未回退 HLS) 时执行, 防止重建后又被错误回收。
        if (FLV_RECYCLE_INTERVAL_MS > 0 && !flvRecycleTimer) {
            flvRecycleTimer = setInterval(() => {
                // 会话守卫: 已回退 HLS / 播放器已停 / 页面不可见时跳过
                if (flvFailed || !flvPlayer || !currentFlvUrl || document.hidden) return;
                const recycleUrl = currentFlvUrl;
                const wasPlaying = !video.paused;
                console.log('[PrismLive] FLV 周期性重建 (释放主线程累积, 20min)');
                stopFLV();      // destroy 旧实例, 释放累积内存 (同时清掉本定时器)
                // stopFLV 已清 flvRecycleTimer, 重建时 playFLV 会重新启动
                if (config && config.liveEnabled && config.streaming) {
                    playFLV(recycleUrl);
                    // 重建后恢复到播放态 (playFLV 的 play() 可能被 autoplay 策略
                    // 拦截, 用户已在看直播的场景下应保持播放)
                    if (wasPlaying && elements.liveVideo) {
                        elements.liveVideo.play().catch(() => {});
                    }
                }
            }, FLV_RECYCLE_INTERVAL_MS);
        }
    }

    // ===== 延迟守护 (延迟徽章 + 追帧): 独立函数, 随播放会话创建 =====
    // C1 修复: 定时器原本只在有一次性守卫的 setupCustomPlayer 里创建,
    // 而 stopStream 每次都 clearInterval 置 null → 停播再开播 (或返回入口再进入)
    // 后延迟徽章/自动追帧/手动追帧按钮永久失效。
    // 现由 playStream 起播路径调用 (创建前先 clearInterval 防重复),
    // 与 stopStream 的清理一一对应; 回调内自带 !hls 空转保护。
    function startLatencyGuard() {
        // 自动追帧冷却: 两次自动追帧至少间隔 15s, 防止追帧后缓冲未恢复又追帧形成循环
        let lastAutoCatchUpAt = 0;
        if (window.__latencyGuardTimer) clearInterval(window.__latencyGuardTimer);
        window.__latencyGuardTimer = setInterval(() => {
            if (!hls || !hls.media) return;
            const pos = hls.liveSyncPosition;
            const media = hls.media;
            if (!pos || media.paused || media.seeking) return;
            const delay = Math.round(pos - media.currentTime);
            const el = elements.pcDelay;
            if (el) {
                if (delay > 3) {
                    el.textContent = `延迟 ${delay}s`;
                    el.classList.remove('hidden');
                } else {
                    el.classList.add('hidden');
                }
            }
            // 直播强制追帧 (落后同步点超 18s 才自动跳)
            // 阈值过低会导致追帧振荡: 追帧→清空缓冲→重新缓冲→waiting→更落后→再追帧
            // 加 15s 冷却: 追帧后缓冲需要时间重建, 连续追帧只会让缓冲永远建不起来
            // 注: 同步距离调为 9s 后, 各阈值均相对同步点计算, 含义不变仍合理:
            //     >3s 徽章只是提示; 10~18s 手动区给了 9s 底仓之上的观察余地;
            //     >18s 自动追帧早于 hls.js 内置回拉 (liveMaxLatencyDuration:30 →
            //     同步点延迟 21s 才触发), 追帧决策统一由本守护负责。
            if (pos - media.currentTime > 18 && Date.now() - lastAutoCatchUpAt > 15000) {
                lastAutoCatchUpAt = Date.now();
                if (window.__markAutoSeek) window.__markAutoSeek();
                media.currentTime = pos - 2;
                if (elements.catchUpBtn) elements.catchUpBtn.classList.add('hidden');
            } else if (pos - media.currentTime > 10) {
                // 落后 10-18s: 显示手动追帧按钮 (让观众决定是否跳帧)
                if (elements.catchUpBtn && elements.catchUpBtn.classList.contains('hidden')) {
                    elements.catchUpBtn.classList.remove('hidden');
                }
            } else {
                if (elements.catchUpBtn) elements.catchUpBtn.classList.add('hidden');
            }
        }, 5000);
    }

    // 播放失败统一出口 (m3/m4): 停播并复用未开播占位区给出明确提示,
    // 避免黑屏静默无限重试
    function showPlaybackError(desc) {
        stopStream();
        elements.notStreaming.classList.remove('hidden');
        elements.notStreamingTitle.textContent = '直播信号异常，请刷新重试';
        elements.notStreamingDesc.textContent = desc || '请稍后再试';
    }

    // 播放 HLS 流: Chrome/FF 等用 hls.js, Safari 用原生
    function playStream(url) {
        const video = elements.liveVideo;
        if (!video || !url) return;

        // F1 修复: flv→hls 引擎切换时幂等回收 mpegts 实例 (与 playFLV 里
        // if (hls) stopStream() 对称)。不回收会导致 flv→hls→flv 往返切换后
        // FLV 同址守卫早退 (flvPlayer 残留 + currentFlvUrl 相同), 无法重建播放
        if (flvPlayer) stopFLV();

        // 若已在播放同一地址, 且 hls 实例正常, 无需重建
        if (hls) {
            if (hls.url === url) return;
            stopStream();
        }

        // 新开播放会话: 错误重试计数归零 (m3/m4/F7)
        netRetryCount = 0;
        mediaRecoverCount = 0;
        nativeReloadCount = 0;

        if (window.Hls && window.Hls.isSupported()) {
            // Chrome / Edge / Firefox: 用 hls.js 通过 MSE 播放 (fetch 走 CORS, 避免 ORB 拦截)
            // ===== 稳定优先策略 (减少转圈) =====
            // 关键: liveSyncDuration 必须远小于服务端 hlsSegmentCount * hlsSegmentDuration
            //       (服务端 15 片 × 2s = 30s 可用内容), 否则同步点超出可用范围,
            //       播放器只能贴边缘播, 缓冲极薄, 内网也频繁转圈。
            hls = new window.Hls({
                enableWorker: true,
                maxBufferLength: 20,           // 目标缓冲 20s (服务端有 30s 分片可用, 足够填满)
                maxMaxBufferLength: 60,        // 允许缓冲增长到 60s (空闲带宽时多存)
                // ===== 稳定性调优: 加大缓冲底仓, 以少量延迟换抗抖能力 =====
                // 同步点从边缘后退 6s→9s: 起播/恢复后前方有 9s 数据底仓,
                // 瞬时网络抖动 (2-3s) 不再直接穿透缓冲触发 waiting。
                // 代价是常态延迟多 ~3s —— 本项目目标: 延迟可忍、卡顿零容忍。
                // 9s 仍远小于服务端 30s 可用范围, 同步点不会超出分片窗口。
                liveSyncDuration: 9,           // 起播落后直播边缘 9s (缓冲底仓)
                // 15→30, 与同步距离 9s 重新对齐 (已核对本地 hls.min.js 源码):
                // synchronizeToLiveEdge 的回拉判定是 n < edge - liveMaxLatencyDuration,
                // 即按"距直播边缘的延迟"计算, 命中后直接 currentTime = liveSyncPosition。
                // 换算成同步点延迟 = liveMaxLatencyDuration - liveSyncDuration:
                //   旧值 15 - 6 = 9s; 若保持 15, 新同步距离下变成 15 - 9 = 6s,
                //   会在手动追帧区 (10~18s) 之前就硬跳清空缓冲, 破坏追帧分层设计。
                // 取 30 → 同步点延迟 21s 才触发, 晚于自定义守护的 >18s 自动追帧,
                // 内置回拉退化为纯兜底 (追帧决策统一交给延迟守护, 避免双路追帧竞争);
                // 30s 恰为服务端分片窗口长度, 播放点不可能更靠后, 不会超出可用范围。
                liveMaxLatencyDuration: 30,
                backBufferLength: 30,          // 回看缓冲 30s
                // ===== 网络容错 =====
                fragLoadingMaxRetry: 10,
                manifestLoadingMaxRetry: 6,
                levelLoadingMaxRetry: 6,
                fragLoadingRetryDelay: 500,
                fragLoadingTimeOut: 15000,
                manifestLoadingTimeOut: 15000,
                // ===== 起播策略 =====
                startPosition: -1,
                lowLatencyMode: false,
                // ===== 缓冲空洞容忍 (减少误触发 waiting) =====
                maxBufferHole: 0.5,
            });
            // 走 hls.js 路径时清掉原生播放地址记录, 避免 M2 守卫状态残留
            video.dataset.currentSrc = '';
            hls.loadSource(url);
            hls.attachMedia(video);
            hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
                // 成功拉到清单: 网络重试计数归零, 给后续抖动留足重试额度
                netRetryCount = 0;
                video.play().catch(() => {});
            });
            hls.on(window.Hls.Events.ERROR, (event, data) => {
                if (!data) return;
                // 非致命缓冲停滞: 重新加载恢复
                if (data.details === window.Hls.ErrorDetails.BUFFER_STALLED_ERROR && !data.fatal) {
                    if (hls) hls.startLoad();
                    return;
                }
                if (!data.fatal) return;
                if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
                    // 网络错误: 延迟 1.5s 重试, 避免密集重连加剧网络压力
                    // m3 修复: 重试加上限 (8 次 ≈ 12s), 超限停播并给出占位提示,
                    // 不再无限重试 (信号确实中断时避免空转)
                    if (netRetryCount >= 8) {
                        showPlaybackError('播放重试多次失败，请刷新页面或稍后再试');
                        return;
                    }
                    netRetryCount += 1;
                    // F4: 钉住本次实例并做同一性校验 —— 1.5s 延迟期间若已
                    // stopStream/换流重建, 不能把 startLoad 打进新场次实例
                    const inst = hls;
                    setTimeout(() => {
                        if (hls === inst) inst.startLoad();
                    }, 1500);
                } else if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
                    // 媒体错误: 按 hls.js 官方恢复模式 (m4 修复) ——
                    // recoverMediaError 最多 2 次 → swapAudioCodec 后再 recover 1 次,
                    // 仍失败则停播 + 占位提示, 不再无限 recover
                    if (mediaRecoverCount < 2) {
                        mediaRecoverCount += 1;
                        hls.recoverMediaError();
                    } else if (mediaRecoverCount === 2) {
                        mediaRecoverCount += 1;
                        hls.swapAudioCodec();
                        hls.recoverMediaError();
                    } else {
                        showPlaybackError('媒体解码异常，请刷新页面重试');
                    }
                } else {
                    stopStream();
                }
            });

            // C1 修复: 延迟守护随播放会话创建 (原来只在一次性守卫的
            // setupCustomPlayer 里创建, stopStream 清掉后不会重建 → 永久失效)
            startLatencyGuard();
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
            // Safari / 原生 HLS 支持
            // M2 修复: 同地址守卫 —— config_update/重连会重复调 playStream,
            // 无守卫会无条件重设 src 导致黑屏重载 (对齐 hls.js 分支的
            // hls.url === url 早退)。地址记录由 stopStream 清除。
            if (video.dataset.currentSrc === url) return;
            video.src = url;
            video.dataset.currentSrc = url;
            video.load();
            video.play().catch(() => {});
        } else {
            console.warn('[PrismLive] 当前浏览器不支持 HLS 播放');
        }
    }

    function backToGate() {
        isLiveRoomVisible = false;
        // F5: 先摘掉全部监听再断开 —— 主动 disconnect 会触发 'disconnect' 事件,
        // 若不先移除监听, 主动退出也会弹"连接中断"横幅并使 reconnectCount 自增
        if (socket) {
            socket.removeAllListeners();
            socket.disconnect();
            socket = null;
        }
        currentUser = null;
        config = null;
        // F4 修复: 返回入口重进视为新会话 —— 复位 FLV 一次性回退标记与
        // 同址守卫, 否则上一场 FLV 失败后重进直播间永远无法再尝试 FLV
        flvFailed = false;
        currentFlvUrl = null;
        lastFetchedQQ = '';
        lastQQNickname = '';
        joinPayload = null;
        reconnectCount = 0;
        currentOnline = 0;
        kickedByAdmin = false;
        // 清理观众列表
        viewerList = [];
        viewerListVisible = false;
        if (elements.viewerListPanel) elements.viewerListPanel.classList.add('hidden');
        // 清理点赞气泡残留 + 重置计数显示
        if (elements.likeBubbles) elements.likeBubbles.innerHTML = '';
        elements.likeCountEl.textContent = '0';
        stopStream();
        // F5: 清横幅残留 (如 rejoin 被拒回入口页时还挂着"连接中断"横幅)
        hideDisconnectedBanner(true);
        // 清空聊天列表 + 弹幕滚动层 + 轨道状态 (复用 clearAllDanmaku 避免遗漏 overlay)
        clearAllDanmaku();
        // 主动清空客户端缓存 (离开直播间视为会话结束)
        clearClientCache();
        // 强制清空入口表单 (QQ 号 + 昵称)
        elements.qqInput.value = '';
        elements.nameInput.value = '';
        elements.avatarPreview.classList.add('hidden');
        elements.liveRoom.classList.add('hidden');
        elements.entryGate.classList.remove('hidden');
        resetJoinButton('进入直播间');
    }

    let backToGateInitialized = false;  // 防止重复绑定

    function setupBackToGate() {
        if (backToGateInitialized) return;
        backToGateInitialized = true;
        if (elements.backToGate) {
            elements.backToGate.addEventListener('click', backToGate);
        }
    }

    // ==================== 观众列表 ====================

    let viewerListInitialized = false;

    function setupViewerList() {
        if (viewerListInitialized) return;
        viewerListInitialized = true;
        // 点击在线人数徽章切换列表面板
        elements.viewerListToggle.addEventListener('click', function(e) {
            e.stopPropagation();
            toggleViewerList();
        });
        // 关闭按钮
        elements.viewerListClose.addEventListener('click', function() {
            hideViewerList();
        });
        // 点击面板外部关闭
        document.addEventListener('click', function(e) {
            if (viewerListVisible &&
                !elements.viewerListPanel.contains(e.target) &&
                !elements.viewerListToggle.contains(e.target)) {
                hideViewerList();
            }
        });
    }

    function toggleViewerList() {
        if (viewerListVisible) {
            hideViewerList();
        } else {
            showViewerList();
        }
    }

    function showViewerList() {
        viewerListVisible = true;
        elements.viewerListPanel.classList.remove('hidden');
        renderViewerList();
    }

    function hideViewerList() {
        viewerListVisible = false;
        elements.viewerListPanel.classList.add('hidden');
    }

    function renderViewerList() {
        elements.viewerListCount.textContent = viewerList.length;
        if (viewerList.length === 0) {
            elements.viewerListBody.innerHTML = '<div class="viewer-list-empty">暂无观众</div>';
            return;
        }
        let html = '';
        for (const v of viewerList) {
            const avatarSrc = v.avatar || avatarFallback(v.name);
            const isMe = currentUser && v.qq === currentUser.qq && v.name === currentUser.name;
            const meClass = isMe ? ' viewer-item-me' : '';
            html += `<div class="viewer-item${meClass}">` +
                `<img class="viewer-avatar" src="${escapeHtml(avatarSrc)}" alt="" onerror="this.src='${avatarFallback(v.name)}'">` +
                `<span class="viewer-name">${escapeHtml(v.name)}</span>` +
                (isMe ? '<span class="viewer-me-tag">我</span>' : '') +
                `</div>`;
        }
        elements.viewerListBody.innerHTML = html;
    }

    function updateViewerList(list) {
        viewerList = Array.isArray(list) ? list : [];
        // 如果面板已显示, 即时更新内容
        if (viewerListVisible) {
            renderViewerList();
        }
    }

    // ==================== 输入与弹幕发送 ====================

    let danmakuInputInitialized = false;  // 防止 showLiveRoom 重复调用导致监听器累积

    function setupDanmakuInput() {
        if (danmakuInputInitialized) return;
        danmakuInputInitialized = true;
        elements.sendBtn.addEventListener('click', sendDanmaku);

        elements.danmakuInput.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                sendDanmaku();
                return;
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (inputHistory.length === 0) return;
                if (historyIndex === -1) historyIndex = inputHistory.length;
                historyIndex = Math.max(0, historyIndex - 1);
                elements.danmakuInput.value = inputHistory[historyIndex];
                moveCursorToEnd(elements.danmakuInput);
                return;
            }
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                if (historyIndex === -1) return;
                historyIndex = Math.min(inputHistory.length, historyIndex + 1);
                if (historyIndex === inputHistory.length) {
                    elements.danmakuInput.value = '';
                    historyIndex = -1;
                } else {
                    elements.danmakuInput.value = inputHistory[historyIndex];
                }
                moveCursorToEnd(elements.danmakuInput);
                return;
            }
        });
    }

    // 点击外部关闭弹幕工具面板（只绑定一次，避免重复进入直播间时重复监听）
    function setupGlobalClickHandlers() {
        document.addEventListener('click', function(e) {
            if (!elements.emojiPanel.contains(e.target) && e.target !== elements.emojiBtn) {
                elements.emojiPanel.classList.add('hidden');
                elements.emojiBtn.classList.remove('active');
                shownEmojiPanel = false;
            }
            if (!elements.colorPalette.contains(e.target) && e.target !== elements.colorBtn && !elements.colorBtn.contains(e.target)) {
                elements.colorPalette.classList.add('hidden');
                shownColorPanel = false;
            }
            if (!elements.settingsPanel.contains(e.target) && e.target !== elements.settingsBtn && !elements.settingsBtn.contains(e.target)) {
                elements.settingsPanel.classList.add('hidden');
                shownSettingsPanel = false;
            }
        });
    }

    function moveCursorToEnd(input) {
        const len = input.value.length;
        input.setSelectionRange(len, len);
    }

    function sendDanmaku() {
        const text = elements.danmakuInput.value.trim();
        if (!text) return;
        if (!config || !config.danmakuEnabled) {
            showToast('弹幕功能已关闭', 'error');
            return;
        }
        if (!currentUser) {
            showToast('请先进入直播间', 'error');
            return;
        }
        // m2 修复: 断线期间 Socket.IO 会把 emit 缓冲进发送队列, 重连后先于
        // rejoin 到达服务端, 因"未加入直播间"被拒。未连接时直接提示,
        // 保留输入框内容让用户重连后重发
        if (!socket || !socket.connected) {
            showToast('连接中，稍后再试', 'error');
            return;
        }
        socket.emit('danmaku', { text, color: currentColor }, function(response) {
            if (response && response.ok) {
                pushInputHistory(text);
                elements.danmakuInput.value = '';
                historyIndex = -1;
            } else {
                showToast((response && response.error) || '发送失败', 'error');
            }
        });
    }

    // ==================== Emoji 面板 ====================

    let emojiPanelInitialized = false;  // 防止重复绑定

    function setupEmojiPanel() {
        if (emojiPanelInitialized) return;
        emojiPanelInitialized = true;
        elements.emojiPanel.innerHTML = '';
        EMOJI_LIST.forEach((emoji) => {
            const btn = document.createElement('button');
            btn.textContent = emoji;
            btn.title = emoji;
            btn.addEventListener('click', () => insertAtCursor(elements.danmakuInput, emoji));
            elements.emojiPanel.appendChild(btn);
        });

        elements.emojiBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            shownEmojiPanel = !shownEmojiPanel;
            elements.emojiPanel.classList.toggle('hidden', !shownEmojiPanel);
            this.classList.toggle('active', shownEmojiPanel);
            if (shownEmojiPanel) {
                elements.colorPalette.classList.add('hidden');
                shownColorPanel = false;
            }
        });
    }

    function insertAtCursor(input, text) {
        const start = input.selectionStart || 0;
        const end = input.selectionEnd || 0;
        const val = input.value;
        input.value = val.slice(0, start) + text + val.slice(end);
        input.focus();
        const pos = start + text.length;
        input.setSelectionRange(pos, pos);
    }

    // ==================== 颜色选择 ====================

    let colorPaletteInitialized = false;  // 防止重复绑定

    function setupColorPalette() {
        if (colorPaletteInitialized) return;
        colorPaletteInitialized = true;
        const colors = (config && config.danmakuColors) || ['#ffffff'];
        elements.colorPalette.innerHTML = '';
        colors.forEach((color) => {
            const dot = document.createElement('span');
            dot.className = 'color-dot';
            dot.style.backgroundColor = color;
            dot.dataset.color = color;
            if (color === currentColor) dot.classList.add('active');
            dot.addEventListener('click', (e) => {
                e.stopPropagation();
                setDanmakuColor(color);
            });
            elements.colorPalette.appendChild(dot);
        });
        updateCurrentColorDot();

        elements.colorBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            shownColorPanel = !shownColorPanel;
            elements.colorPalette.classList.toggle('hidden', !shownColorPanel);
            if (shownColorPanel) {
                elements.emojiPanel.classList.add('hidden');
                elements.emojiBtn.classList.remove('active');
                shownEmojiPanel = false;
            }
        });
    }

    function setDanmakuColor(color) {
        currentColor = color;
        updateCurrentColorDot();
        elements.colorPalette.querySelectorAll('.color-dot').forEach((d) => {
            d.classList.toggle('active', d.dataset.color === color);
        });
    }

    function updateCurrentColorDot() {
        elements.currentColorDot.style.backgroundColor = currentColor;
        elements.currentColorDot.style.color = currentColor;
    }

    // ==================== 弹幕显示设置 ====================

    let danmakuSettingsInitialized = false;  // 防止重复绑定

    function setupDanmakuSettings() {
        if (danmakuSettingsInitialized) return;
        danmakuSettingsInitialized = true;
        elements.settingsBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            shownSettingsPanel = !shownSettingsPanel;
            elements.settingsPanel.classList.toggle('hidden', !shownSettingsPanel);
        });

        elements.fontSizeControl.querySelectorAll('button').forEach((btn) => {
            btn.addEventListener('click', () => {
                viewerSettings.fontSize = btn.dataset.size;
                saveViewerSettings();
                applyViewerSettings();
                updateSegmentActive(elements.fontSizeControl, btn.dataset.size);
            });
        });

        elements.danmakuOpacity.addEventListener('input', function() {
            viewerSettings.opacity = Number(this.value);
            elements.opacityValue.textContent = this.value + '%';
            saveViewerSettings();
            applyViewerSettings();
        });

        elements.areaControl.querySelectorAll('button').forEach((btn) => {
            btn.addEventListener('click', () => {
                viewerSettings.area = btn.dataset.area;
                saveViewerSettings();
                applyViewerSettings();
                updateSegmentActive(elements.areaControl, btn.dataset.area);
            });
        });

        // 初始化 UI 状态
        updateSegmentActive(elements.fontSizeControl, viewerSettings.fontSize);
        updateSegmentActive(elements.areaControl, viewerSettings.area);
        elements.danmakuOpacity.value = viewerSettings.opacity;
        elements.opacityValue.textContent = viewerSettings.opacity + '%';
        applyViewerSettings();
    }

    function updateSegmentActive(container, value) {
        container.querySelectorAll('button').forEach((btn) => {
            btn.classList.toggle('active', btn.dataset.size === value || btn.dataset.area === value);
        });
    }

    function applyViewerSettings() {
        elements.danmakuOverlay.classList.toggle('area-half', viewerSettings.area === 'half');
        elements.danmakuOverlay.style.opacity = String(viewerSettings.opacity / 100);
        elements.danmakuOverlay.dataset.fontSize = viewerSettings.fontSize;
    }

    // ==================== 缓冲状态 UI ====================

    // 缓冲状态控制: 防抖 + 区分"首次加载"和"播放中卡顿"
    let bufferTimer = null;
    let bufferUIInitialized = false;   // 防止 showLiveRoom 重复调用导致监听器累积

    function showBuffer(text) {
        if (!elements.bufferOverlay) return;
        elements.bufferText.textContent = text || '缓冲中…';
        elements.bufferOverlay.classList.remove('hidden');
    }

    function hideBuffer() {
        if (!elements.bufferOverlay) return;
        elements.bufferOverlay.classList.add('hidden');
    }

    function setupBufferUI() {
        if (bufferUIInitialized) return;
        bufferUIInitialized = true;
        const video = elements.liveVideo;
        // 首次加载 (currentTime=0) 立即显示转圈; 播放中卡顿防抖 400ms 避免闪烁
        const BUFFER_DEBOUNCE_MS = 400;

        // ===== 卡顿恢复后的安全缓冲位检查 (防二次转圈) =====
        // 背景: waiting 恢复只靠 playing/canplay 隐藏转圈, 若恢复时播放点贴着
        // 直播边缘 (前方缓冲不足), 数据一断流会立刻二次转圈, 形成反复卡顿。
        // 策略: 从 waiting 恢复时检查前方缓冲余量, 不足则复用手动追帧同款逻辑
        // seek 到同步点附近重建缓冲底仓。
        // 防振荡 (项目历史重点调优过 seek 振荡, 此处严格遵守):
        //   1) __markAutoSeek 标记本次 seek, 避免 seeking 监听弹"不支持拖动"toast;
        //   2) wasWaiting 一次性标记: 一次卡顿最多只做一次恢复评估, seek 引发的
        //      新 waiting/playing 不会再次触发 (标记已被消费重置);
        //   3) 15s 冷却 (与延迟守护的追帧冷却风格一致): seek 后缓冲需时间重建,
        //      冷却期内即使再次卡顿也只提示不跳, 防止 seek→清空缓冲→再 seek 循环;
        //   4) 要求落后同步点 ≥6s 才跳: 落后少时前方本就无法再推进,
        //      seek 只会无谓清空缓冲、自造卡顿; 目标点 sync-1 保证跳后仍有底仓。
        // 注: wasWaiting/lastRecoverySeekAt 已提升到模块作用域 (与 let hls 并列),
        //     由 stopStream() 统一重置, 避免跨场次残留 (本函数有一次性守卫,
        //     闭包局部变量无法随场次重建)。
        const SAFE_FORWARD_BUFFER = 3;   // 前方缓冲安全阈值 (s), 低于则重建底仓
        const MIN_LAG_TO_RECOVER = 6;    // 落后同步点至少 6s 才值得恢复 seek
        const RECOVERY_COOLDOWN_MS = 15000;
        // 不变量: 所有自动 seek 目标距同步点的偏移必须小于 MIN_LAG_TO_RECOVER
        // (当前: 恢复 seek pos-1, 延迟守护自动追帧 pos-2, 均 < 6)。
        // 否则 seek 落点距同步点 ≥ MIN_LAG_TO_RECOVER, 下一次恢复路径评估时
        // 条件仍成立, 会在对方 seek 完成后二次触发, 形成振荡。
        // 未来调整任一偏移或阈值时必须维持该不变量。

        // 计算播放点前方 (向直播边缘方向) 的已缓冲余量
        function forwardBuffered() {
            const buf = video.buffered;
            const t = video.currentTime;
            for (let i = 0; i < buf.length; i++) {
                // start 加 0.5s 容差: currentTime 落在 ≤maxBufferHole(0.5s) 的
                // 小空洞或两个 range 之间时仍能命中紧邻的缓冲段, 避免把实际
                // 可用的前方缓冲误判为 0 → 触发本可避免的恢复 seek 冲掉缓冲
                if (t >= buf.start(i) - 0.5 && t <= buf.end(i)) {
                    return buf.end(i) - t;
                }
            }
            return 0;
        }

        // waiting: 视频等待数据 (转圈)
        // 防抖: 播放中短暂 waiting (400ms 内恢复) 不显示转圈, 减少视觉干扰
        video.addEventListener('waiting', () => {
            // 排除首次起播 (currentTime=0): 起播阶段同步点/缓冲都在建立, 不参与恢复评估
            if (video.currentTime > 0) wasWaiting = true;
            clearTimeout(bufferTimer);
            if (video.currentTime === 0) {
                // 首次加载立即显示, 不防抖
                showBuffer('加载中…');
            } else {
                bufferTimer = setTimeout(() => {
                    showBuffer('网络缓冲中…');
                }, BUFFER_DEBOUNCE_MS);
            }
        });

        // 恢复路径共用的安全缓冲检查 (playing/canplay 都可能触发, 标记只消费一次)
        function onPlaybackResumed() {
            clearTimeout(bufferTimer);
            hideBuffer();
            if (!wasWaiting) return;
            wasWaiting = false;   // 先重置: 无论后续是否 seek, 本次卡顿只评估一次
            const pos = hls && hls.liveSyncPosition;
            // 无同步点直接早退: Safari 原生 HLS 路径没有 hls 实例 (hls=null),
            // 恢复检查仅在 hls.js 路径生效; 同步点暂未就绪 (刚起播) 时同理跳过
            if (!pos || video.seeking || video.paused) return;
            if (Date.now() - lastRecoverySeekAt < RECOVERY_COOLDOWN_MS) return;
            const lag = pos - video.currentTime;   // 落后同步点的秒数 (>0 表示有余地前移)
            // 前方缓冲不足安全阈值 且 落后足够多 (有余地重建底仓) 才跳
            if (forwardBuffered() < SAFE_FORWARD_BUFFER && lag >= MIN_LAG_TO_RECOVER) {
                lastRecoverySeekAt = Date.now();
                if (window.__markAutoSeek) window.__markAutoSeek();
                video.currentTime = pos - 1;       // 与手动追帧同款目标点, 跳后留 1s 余量
                if (elements.catchUpBtn) elements.catchUpBtn.classList.add('hidden');
            }
        }

        // playing: 恢复播放, 清除防抖定时器
        video.addEventListener('playing', onPlaybackResumed);
        // canplay: 缓冲足够恢复播放 (兜底, 某些浏览器 playing 后才触发)
        video.addEventListener('canplay', onPlaybackResumed);
        // 缓冲停滞超时: 仅提示网络缓慢
        // 事件边界: stalled 不置 wasWaiting、不参与恢复 seek —— 它不代表真正的
        // 卡顿等待态 (可能随即恢复), 恢复判定只认 waiting→playing/canplay 路径
        video.addEventListener('stalled', () => {
            clearTimeout(bufferTimer);
            bufferTimer = setTimeout(() => {
                if (video.readyState < 3) showBuffer('加载缓慢，请检查网络');
            }, 5000);
        });
        // 保险: 媒体源被清空 (换源/重新 load) 时清掉脏标记,
        // 兜住 stopStream 之外罕见的直接 load 路径
        video.addEventListener('emptied', () => {
            wasWaiting = false;
        });

        // 手动追帧按钮: 跳到直播最新画面
        if (elements.catchUpBtn) {
            elements.catchUpBtn.addEventListener('click', () => {
                if (hls && hls.liveSyncPosition) {
                    if (window.__markAutoSeek) window.__markAutoSeek();
                    video.currentTime = hls.liveSyncPosition - 1;
                    elements.catchUpBtn.classList.add('hidden');
                    hideBuffer();
                }
            });
        }
    }

    // ==================== 定制播放器 (直播: 禁暂停/禁seek) ====================

    let controlsVisible = false;
    let controlsTimer = null;
    let customPlayerInitialized = false;  // 防止 showLiveRoom 重复调用导致监听器累积

    function setupCustomPlayer() {
        // 防止累积: 如果已初始化则跳过 (backToGate → re-enter 时不会重复注册)
        if (customPlayerInitialized) return;
        customPlayerInitialized = true;

        const video = elements.liveVideo;
        const controls = elements.playerControls;

        // ===== 直播强制: 拦截暂停 =====
        // 使用 _pauseRetryCount 限制重试, 防止 pause→play→pause 连锁循环
        let pauseRetryCount = 0;
        const MAX_PAUSE_RETRIES = 3;
        video.addEventListener('pause', function() {
            if (video.seeking) return;
            // 重置计数器: 新的暂停事件
            pauseRetryCount = 0;
            const resume = () => {
                if (pauseRetryCount >= MAX_PAUSE_RETRIES) return;
                if (video.paused && !video.seeking) {
                    pauseRetryCount += 1;
                    video.play().catch(() => {});
                }
            };
            resume();
            setTimeout(resume, 150);
            setTimeout(resume, 600);
            setTimeout(resume, 1500);
        });

        // ===== 直播强制: 拦截 seek =====
        // 用户拖动进度时只提示, 不强制拉回。
        // 旧实现用 video.currentTime = liveSyncPosition - 2 拉回, 但 liveSyncPosition
        // 是动态前移值, 拉回后仍可能落后 → 延迟守护再次追帧 → seeking 事件被判定为
        // "用户拖动"(时间窗口已过) → 再次拉回 + 弹 toast → 形成无限循环卡死。
        // 改为: 仅提示, 由延迟守护统一管理追帧 (落后 18s 才自动跳)。
        let lastAutoSeekAt = 0;
        let lastSeekToastAt = 0;
        video.addEventListener('seeking', function() {
            // 自动追帧(延迟守护/追帧按钮)触发的 seek 不提示
            if (Date.now() - lastAutoSeekAt < 2000) return;
            // 防止 toast 风暴: 3s 内只提示一次
            if (Date.now() - lastSeekToastAt < 3000) return;
            lastSeekToastAt = Date.now();
            showToast('直播不支持拖动进度', 'info');
        });

        // 标记一次自动追帧 (延迟守护/追帧按钮调用)
        window.__markAutoSeek = function() {
            lastAutoSeekAt = Date.now();
        };

        // ===== 控制条显隐: 单击视频切换 =====
        video.addEventListener('click', function(e) {
            // 避免点击控制条按钮时触发 (按钮在 video 上层, 不会冒泡到 video)
            toggleControls();
        });
        video.addEventListener('dblclick', function() {
            toggleFullscreen();
        });

        // ===== 控制条按钮 =====
        elements.pcMuteBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            video.muted = !video.muted;
            updateVolumeIcon();
        });
        elements.pcFullscreenBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            toggleFullscreen();
        });

        // 全屏状态监听
        document.addEventListener('fullscreenchange', function() {
            elements.pcFsEnter.classList.toggle('hidden', !!document.fullscreenElement);
            elements.pcFsExit.classList.toggle('hidden', !document.fullscreenElement);
            // 全屏切换提示 (双击/F/按钮触发都会走到这里)
            if (document.fullscreenElement) {
                showToast('已进入全屏 · 双击退出', 'info');
            } else {
                showToast('已退出全屏', 'info');
            }
        });

        // 音量变化监听
        video.addEventListener('volumechange', updateVolumeIcon);

        // 音量滑条
        if (elements.pcVolume) {
            // 初始同步
            elements.pcVolume.value = Math.round(video.volume * 100);
            elements.pcVolume.addEventListener('input', function() {
                video.volume = Number(this.value) / 100;
                if (video.volume > 0 && video.muted) video.muted = false;
                updateVolumeIcon();
            });
        }

        // ===== 键盘快捷键 (直播适配: 无暂停/无快进快退) =====
        document.addEventListener('keydown', function(e) {
            if (!isLiveRoomVisible) return;
            if (document.activeElement === elements.danmakuInput || document.activeElement === elements.nameInput) return;

            switch (e.key) {
                case 'f': case 'F':
                    e.preventDefault();
                    toggleFullscreen();
                    break;
                case 'm': case 'M':
                    e.preventDefault();
                    video.muted = !video.muted;
                    updateVolumeIcon();
                    break;
                case 'ArrowUp':
                    e.preventDefault();
                    video.volume = Math.min(1, video.volume + 0.1);
                    break;
                case 'ArrowDown':
                    e.preventDefault();
                    video.volume = Math.max(0, video.volume - 0.1);
                    break;
                // 空格/←/→ 在直播模式下无效 (禁暂停/禁seek)
            }
        });

        // ===== 状态更新 =====
        video.addEventListener('timeupdate', updatePlayerTime);
        // F7: Safari 原生路径自愈 —— M2 的同址早退同时移除了原生路径卡死后的
        // 重载自愈, 此处补最小实现 (仅原生路径有意义: hls.js 路径视频错误由
        // hls.js 的 ERROR 事件体系处理, 这里靠 hls 实例存在与否分流)。
        // 清掉 dataset.currentSrc 再重载同址, 绕过 M2 同址早退; 上限 2 次防循环,
        // 计数随播放会话归零 (stopStream/playStream)。
        video.addEventListener('error', function() {
            if (hls) return;                                    // hls.js 路径不处理
            const src = video.dataset.currentSrc;
            if (!src) return;                                   // 无原生播放地址 (已停播)
            if (nativeReloadCount >= 2) return;                 // 重试上限, 防无限重载循环
            nativeReloadCount += 1;
            video.dataset.currentSrc = '';                      // 允许重载通过同址守卫
            const seq = ++nativeReloadSeq;                      // 钉住本次自愈序号
            setTimeout(() => {
                // 序号已变 = 期间 stopStream/换流发生, 放弃本次自愈
                if (seq !== nativeReloadSeq) return;
                // 延迟期间若已被其他路径设上新地址, 同样放弃
                if (hls || video.dataset.currentSrc) return;
                video.src = src;
                video.dataset.currentSrc = src;
                video.load();
                video.play().catch(() => {});
            }, 1500);
        });
        // 直播徽章跟随推流状态
        elements.liveStatusDot.addEventListener('streaming-change', function() {});
        // ===== 延迟守护定时器已迁移至 startLatencyGuard() (C1 修复) =====
        // 原因: 本函数有一次性守卫, 定时器只创建一次, 而 stopStream 每次都
        // clearInterval → 停播再开播后延迟徽章/追帧永久失效。现定时器随
        // playStream 播放会话创建/随 stopStream 销毁, 本函数只保留一次性绑定。
    }

    // 控制条显隐 (带自动隐藏)
    function toggleControls() {
        controlsVisible = !controlsVisible;
        elements.playerControls.classList.toggle('hidden', !controlsVisible);
        if (controlsVisible) {
            clearTimeout(controlsTimer);
            controlsTimer = setTimeout(() => {
                elements.playerControls.classList.add('hidden');
                controlsVisible = false;
            }, 3000);
        }
    }

    function updatePlayerTime() {
        const v = elements.liveVideo;
        if (!v || isNaN(v.currentTime)) return;
        const t = v.currentTime;
        const p = (n) => String(Math.floor(n)).padStart(2, '0');
        elements.pcTime.textContent = `${p(t / 60)}:${p(t % 60)}`;
    }

    function updateVolumeIcon() {
        const muted = elements.liveVideo.muted;
        elements.pcVolOn.classList.toggle('hidden', muted);
        elements.pcVolOff.classList.toggle('hidden', !muted);
    }

    function toggleFullscreen() {
        const el = elements.liveVideo;
        if (!document.fullscreenElement) {
            el.requestFullscreen ? el.requestFullscreen().catch(() => {}) :
            el.webkitRequestFullscreen ? el.webkitRequestFullscreen() :
            el.msRequestFullscreen ? el.msRequestFullscreen() : {};
        } else {
            document.exitFullscreen ? document.exitFullscreen().catch(() => {}) :
            document.webkitExitFullscreen ? document.webkitExitFullscreen() :
            document.msExitFullscreen ? document.msExitFullscreen() : {};
        }
    }

    // ==================== 点赞 (全局同步) ====================

    let likeButtonInitialized = false;  // 防止重复绑定

    function setupLikeButton() {
        if (likeButtonInitialized) return;
        likeButtonInitialized = true;
        elements.likeBtn.addEventListener('click', function() {
            if (!socket || !currentUser) return;
            // m2 修复: 断线时静默忽略 —— 离线 emit 会被 Socket.IO 缓冲,
            // 重连后先于 rejoin 到达被服务端拒; 点赞是轻量交互, 不弹 toast 打扰
            if (!socket.connected) return;
            // 发送点赞到服务端, 由服务端广播全局计数 (本地不直接 +1)
            socket.emit('like', {}, function(response) {
                if (response && response.ok && typeof response.total === 'number') {
                    // 更新全局计数 (服务端确认)
                    animateNumber(elements.likeCountEl, Number(elements.likeCountEl.textContent) || 0, response.total);
                }
            });
            // 本地气泡效果即时反馈 (不受服务端确认延迟影响)
            this.classList.add('liked');
            setTimeout(() => this.classList.remove('liked'), 450);
            createLikeBubble();
        });
    }

    // 服务端广播点赞气泡 (其他观众点赞时, 本机也显示气泡)
    function handleLikeBubble() {
        createLikeBubble();
    }

    // 服务端广播全局点赞总数更新
    function handleLikeUpdate(data) {
        if (!data || typeof data.total !== 'number') return;
        const cur = Number(elements.likeCountEl.textContent) || 0;
        if (data.total !== cur) {
            animateNumber(elements.likeCountEl, cur, data.total);
        }
    }

    const LIKE_EMOJIS = ['❤️','💖','💕','💗','💓','✨','🌟','⭐','🔥','💜','💙','💚','🧡','💛'];

    function createLikeBubble() {
        const bubble = document.createElement('div');
        bubble.className = 'like-bubble';
        bubble.textContent = LIKE_EMOJIS[Math.floor(Math.random() * LIKE_EMOJIS.length)];
        const tx = (Math.random() * 80 - 40) + 'px';
        const ty = -(180 + Math.random() * 80) + 'px';
        const rot = (Math.random() * 30 - 15) + 'deg';
        const dur = (1.4 + Math.random() * 0.5) + 's';
        bubble.style.setProperty('--tx', tx);
        bubble.style.setProperty('--ty', ty);
        bubble.style.setProperty('--rot', rot);
        bubble.style.setProperty('--duration', dur);
        bubble.style.left = (35 + Math.random() * 30) + '%';
        elements.likeBubbles.appendChild(bubble);
        setTimeout(() => bubble.remove(), 2100);
    }

    // ==================== 弹幕处理 ====================

    function addDanmaku(data) {
        renderDanmaku(data);
        addChatItem(data);
    }

    // 渲染服务端下发的弹幕历史 (仅聊天列表, 不滚动播放)
    function renderHistoryMessages(history) {
        for (const data of history) {
            addChatItem(data);
        }
    }

    // 清空所有弹幕 (推流关闭时): 清聊天列表 + 弹幕历史数组 + 轨道状态
    function clearAllDanmaku() {
        // 清空聊天列表, 恢复空态
        if (elements.chatList) {
            elements.chatList.innerHTML =
                '<div class="empty-state">' +
                '<svg class="empty-icon" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>' +
                '<div class="empty-text">还没有弹幕，来发第一条吧</div></div>';
        }
        // 清空弹幕滚动层
        if (elements.danmakuOverlay) {
            elements.danmakuOverlay.innerHTML = '';
        }
        // 重置轨道状态
        danmakuTracks.length = 0;
    }

    function renderDanmaku(data) {
        const overlay = elements.danmakuOverlay;
        if (overlay.children.length > DANMAKU_OVERLAY_MAX) {
            overlay.removeChild(overlay.firstChild);
        }

        const item = document.createElement('div');
        item.className = 'danmaku-item';
        item.classList.add('size-' + viewerSettings.fontSize);
        item.textContent = `${data.user.name}: ${data.text}`;
        item.style.color = data.color || '#ffffff';
        overlay.appendChild(item);

        const width = item.offsetWidth;
        const overlayWidth = overlay.offsetWidth;
        const overlayHeight = overlay.offsetHeight;
        const distance = width + overlayWidth;
        const duration = distance / DANMAKU_SPEED;

        const maxTracks = Math.max(1, Math.floor(overlayHeight / DANMAKU_TRACK_HEIGHT));
        const now = Date.now();
        let track = -1;
        for (let i = 0; i < maxTracks; i++) {
            const t = danmakuTracks[i];
            if (!t || now >= t.freeAt) { track = i; break; }
        }
        if (track === -1) {
            let earliest = Infinity;
            for (let i = 0; i < maxTracks; i++) {
                if (danmakuTracks[i] && danmakuTracks[i].freeAt < earliest) {
                    earliest = danmakuTracks[i].freeAt;
                    track = i;
                }
            }
            if (track === -1) track = 0;
        }

        const headEnterMs = (width / DANMAKU_SPEED) * 1000;
        danmakuTracks[track] = { freeAt: now + headEnterMs + DANMAKU_TRACK_MARGIN_MS };

        item.style.top = (track * DANMAKU_TRACK_HEIGHT + 4) + 'px';
        item.style.left = '100%';
        item.style.animationDuration = duration + 's';

        setTimeout(() => item.remove(), duration * 1000 + 100);
    }

    function addChatItem(data) {
        const emptyState = elements.chatList.querySelector('.empty-state');
        if (emptyState) emptyState.remove();

        const item = document.createElement('div');
        item.className = 'chat-item';
        const avatarSrc = data.user.avatar || avatarFallback(data.user.name);

        // 用 DOM API 构建，避免 avatar URL 中含 " 等字符造成属性注入 (XSS)
        const img = document.createElement('img');
        img.src = avatarSrc;
        img.className = 'chat-avatar';
        img.alt = '';

        const content = document.createElement('div');
        content.className = 'chat-content';

        const nameEl = document.createElement('div');
        nameEl.className = 'chat-name';
        nameEl.textContent = data.user.name;
        if (data.color && data.color !== '#ffffff') nameEl.style.color = data.color;

        const textEl = document.createElement('div');
        textEl.className = 'chat-text';
        textEl.textContent = data.text;
        textEl.style.color = data.color || '#fff';

        content.appendChild(nameEl);
        content.appendChild(textEl);
        item.appendChild(img);
        item.appendChild(content);

        elements.chatList.appendChild(item);
        elements.chatList.scrollTop = elements.chatList.scrollHeight;

        while (elements.chatList.children.length > CHAT_ITEM_LIMIT) {
            elements.chatList.removeChild(elements.chatList.firstChild);
        }
    }

    function addSystemMessage(text) {
        const msg = document.createElement('div');
        msg.className = 'system-message';
        msg.textContent = text;
        elements.systemMessages.appendChild(msg);
        setTimeout(() => msg.remove(), 3000);
    }

    // ==================== 启动 ====================

    initEntryGate();

    // 页面关闭/标签页关闭时主动清理会话缓存
    window.addEventListener('beforeunload', function() {
        clearClientCache();
    });
})();
