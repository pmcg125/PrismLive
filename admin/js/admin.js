(function() {
    'use strict';

    const $ = (id) => document.getElementById(id);

    const TOKEN_KEY = 'prismlive_admin_token';
    const CHART_MAX_POINTS = 150;

    let socket = null;
    let chart = null;
    let stateData = null;
    let usersList = [];
    let blacklistList = [];
    let usersSearch = '';
    let blacklistSearch = '';
    let switches = { liveEnabled: false, danmakuEnabled: false };

    const chartData = { times: [], online: [], danmaku: [], bandwidth: [] };

    // ==================== 工具函数 ====================

    function showToast(message, type = 'info') {
        const container = $('toast-container');
        const el = document.createElement('div');
        el.className = 'toast ' + type;
        el.textContent = message;
        container.appendChild(el);
        setTimeout(() => {
            el.style.opacity = '0';
            el.style.transform = 'translateX(20px)';
            el.style.transition = '0.3s ease';
            setTimeout(() => el.remove(), 300);
        }, 3000);
    }

    function fmtUptime(s) {
        const d = Math.floor(s / 86400);
        const h = Math.floor((s % 86400) / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = s % 60;
        if (d > 0) return d + '天' + h + '小时';
        if (h > 0) return h + '小时' + m + '分';
        if (m > 0) return m + '分' + sec + '秒';
        return sec + '秒';
    }

    function fmtMem(mb) {
        return mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : mb + ' MB';
    }

    function fmtBitrate(kbps) {
        return kbps >= 1000 ? (kbps / 1000).toFixed(1) + ' Mbps' : kbps + ' kbps';
    }

    function fmtBytes(bytes) {
        if (!bytes || bytes <= 0) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
        const v = bytes / Math.pow(1024, i);
        return v >= 100 ? v.toFixed(0) + ' ' + units[i] : v.toFixed(1) + ' ' + units[i];
    }

    function fmtDuration(s) {
        s = Math.max(0, Math.floor(Number(s) || 0));
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = s % 60;
        if (h > 0) return h + '时' + m + '分' + sec + '秒';
        if (m > 0) return m + '分' + sec + '秒';
        return sec + '秒';
    }

    function fmtTime(ts) {
        const d = new Date(ts);
        const p = (n) => String(n).padStart(2, '0');
        return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    }

    function fmtDate(ts) {
        const d = new Date(ts);
        const p = (n) => String(n).padStart(2, '0');
        return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text == null ? '' : String(text);
        return div.innerHTML;
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

    function downloadCsv(filename, header, rows) {
        const csv = [header.join(','), ...rows.map((r) => r.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))].join('\n');
        const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    }

    function avatarFallback(name) {
        const ch = (name && name[0]) ? name[0].toUpperCase() : '?';
        const safe = ch.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
        return 'data:image/svg+xml,' + encodeURIComponent(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
            '<circle cx="50" cy="50" r="50" fill="#fb7299"/>' +
            '<text x="50" y="68" text-anchor="middle" fill="white" font-size="44" font-family="sans-serif">' + safe + '</text>' +
            '</svg>'
        );
    }

    // ==================== API 封装 ====================

    async function api(url, options = {}) {
        const headers = Object.assign({}, options.headers || {});
        const token = localStorage.getItem(TOKEN_KEY);
        if (token) headers['Authorization'] = 'Bearer ' + token;
        if (options.body && typeof options.body !== 'string') {
            headers['Content-Type'] = 'application/json';
            options.body = JSON.stringify(options.body);
        }
        let res;
        try {
            res = await fetch(url, Object.assign({}, options, { headers }));
        } catch (e) {
            const err = new Error('网络连接失败，请检查网络');
            err.code = 0;
            throw err;
        }
        if (res.status === 401) {
            logout('登录已过期，请重新登录');
            const err = new Error('unauthorized');
            err.code = 401;
            throw err;
        }
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            const err = new Error(data.error || '请求失败');
            err.code = res.status;
            throw err;
        }
        return data;
    }

    // ==================== 登录 / 退出 ====================

    function showLogin() {
        $('login-screen').classList.add('active');
        $('main-screen').classList.remove('active');
        if (socket) { socket.disconnect(); socket = null; }
    }

    function showMain() {
        $('login-screen').classList.remove('active');
        $('main-screen').classList.add('active');
    }

    function logout(message) {
        localStorage.removeItem(TOKEN_KEY);
        if (message) showToast(message, 'error');
        showLogin();
        $('login-password').value = '';
    }

    async function handleLogin(e) {
        e.preventDefault();
        const password = $('login-password').value;
        $('login-error').textContent = '';
        try {
            let r;
            try {
                r = await fetch('/api/admin/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password })
                });
            } catch (netErr) {
                throw new Error('网络连接失败，请检查网络');
            }
            const d = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(d.error || '登录失败');
            localStorage.setItem(TOKEN_KEY, d.token);
            $('login-password').value = '';
            showMain();
            await bootstrap();
            showToast('登录成功', 'success');
        } catch (err) {
            $('login-error').textContent = err.message;
        }
    }

    // ==================== 初始化 ====================

    async function bootstrap() {
        $('page-skeleton').classList.remove('hidden');
        try {
            const state = await api('/api/admin/state');
            stateData = state;
            hydrate(state);
            connectSocket();
            initChart();
            await loadUsers();
            // Task #15: 原误调未定义的 loadBlacklist (实际函数为 reloadBlacklist),
            // 登录时 toast 报错 "loadBlacklist is not defined"; hydrate 已用
            // state.blacklist 首渲, 此处再经 API 拉取最新列表保持同步
            await reloadBlacklist();
        } catch (e) {
            if (e.code !== 401) showToast('加载失败: ' + e.message, 'error');
        } finally {
            $('page-skeleton').classList.add('hidden');
        }
    }

    function hydrate(state) {
        const s = state.settings;
        $('setting-liveTitle').value = s.liveTitle || '';
        $('setting-liveAnnouncement').value = s.liveAnnouncement || '';
        $('setting-danmakuRateLimit').value = s.danmakuRateLimit;
        $('setting-sensitiveWords').value = s.sensitiveWords || '';
        $('setting-hlsBaseUrl').value = s.hlsBaseUrl || '';
        // Task #16: FLV 基础地址回填 (默认空串, 即使用 :8090 默认推导)
        $('setting-flvBaseUrl').value = s.flvBaseUrl || '';
        // Task #13: 播放引擎下拉回填 (默认 hls)
        $('setting-playEngine').value = s.playEngine || 'hls';

        setSwitch('liveEnabled', s.liveEnabled);
        setSwitch('danmakuEnabled', s.danmakuEnabled);

        $('info-rtmpUrl').value = s.rtmpUrl;
        $('info-streamKey').value = s.streamKey;
        $('info-hlsUrl').value = s.hlsUrl;

        renderBlacklist(state.blacklist || []);
        renderLive(state.live);
        renderStats(state.stats);
        renderSystem(state.system);
        renderLinkDiag(state.linkDiag);
    }

    // ==================== Socket.IO 实时 ====================

    function connectSocket() {
        if (socket) socket.disconnect();
        socket = io();
        updateSocketStatus(true);
        socket.on('connect', () => {
            updateSocketStatus(true);
            const token = localStorage.getItem(TOKEN_KEY);
            socket.emit('auth', token, (res) => {
                if (!res || !res.ok) logout('后台连接鉴权失败，请重新登录');
            });
        });
        socket.on('stats_update', (data) => {
            if (!data) return;
            renderLive(data.live);
            renderStats(data.stats);
            renderSystem(data.system);
            renderLinkDiag(data.linkDiag);
            pushChart(data.stats, data.live && data.live.bitrate);
        });
        socket.on('disconnect', () => {
            updateSocketStatus(false);
        });
    }

    function updateSocketStatus(connected) {
        const el = $('socket-status');
        el.classList.toggle('connected', connected);
        el.classList.toggle('disconnected', !connected);
        el.querySelector('.status-text').textContent = connected ? '实时连接中' : '连接已断开';
    }

    // ==================== 看板渲染 ====================

    function renderLive(l) {
        if (!l) return;
        const badge = $('live-status');
        const mtxAlive = l.lastCheck && (Date.now() - l.lastCheck < 15000);
        if (l.streaming) {
            badge.className = 'badge badge-live';
            badge.textContent = '推流中';
        } else if (mtxAlive) {
            badge.className = 'badge badge-offline';
            badge.textContent = '未推流';
        } else {
            badge.className = 'badge badge-error';
            badge.textContent = 'MediaMTX 离线';
        }
        $('live-bitrate').textContent = l.bitrate ? fmtBitrate(l.bitrate) : '0 kbps';
        $('live-readers').textContent = l.readers || 0;
        $('live-mtx-version').textContent = l.mtxVersion || '—';

        // ===== 新增预览信息 =====
        // 推流时长: 推流中显示从 streamStartAt 起算的时长, 停播后显示最后时长
        const durEl = $('live-duration');
        if (l.streaming && l.streamStartAt) {
            const elapsed = Math.floor((Date.now() - l.streamStartAt) / 1000);
            durEl.textContent = fmtDuration(elapsed);
            // 每 30s 刷新一次显示 (由 stats_update 推送驱动, 2s 一次足够)
        } else {
            durEl.textContent = '-';
        }
        // 累计上行流量
        $('live-total-bytes').textContent = fmtBytes(l.totalBytes || 0);
        // 播放引擎 (从 stateData 或数据库设置读取)
        const engine = (stateData && stateData.settings && stateData.settings.playEngine) || 'hls';
        $('live-play-engine').textContent = engine === 'flv' ? 'HTTP-FLV (SRS)' : 'HLS (MediaMTX)';
        // 双链路状态
        const mtxEl = $('live-mtx-status');
        if (!l.mtxReachable) {
            mtxEl.textContent = '离线';
            mtxEl.className = 'status-value status-bad';
        } else if (l.mtxStreaming) {
            mtxEl.textContent = '推流中';
            mtxEl.className = 'status-value status-good';
        } else {
            mtxEl.textContent = '空闲';
            mtxEl.className = 'status-value';
        }
        const srsEl = $('live-srs-status');
        if (!l.srsReachable) {
            srsEl.textContent = '离线';
            srsEl.className = 'status-value status-bad';
        } else if (l.srsStreaming) {
            srsEl.textContent = '推流中';
            srsEl.className = 'status-value status-good';
        } else {
            srsEl.textContent = '空闲';
            srsEl.className = 'status-value';
        }
    }

    function renderStats(st) {
        if (!st) return;
        animateNumber($('stat-online'), $('stat-online').dataset.value, st.online);
        $('stat-online').dataset.value = st.online;
        animateNumber($('stat-peak-online'), $('stat-peak-online').dataset.value, st.peakOnline);
        $('stat-peak-online').dataset.value = st.peakOnline;
        animateNumber($('stat-today-views'), $('stat-today-views').dataset.value, st.todayViews);
        $('stat-today-views').dataset.value = st.todayViews;
        animateNumber($('stat-total-danmaku'), $('stat-total-danmaku').dataset.value, st.totalDanmaku);
        $('stat-total-danmaku').dataset.value = st.totalDanmaku;
        animateNumber($('stat-danmaku-per-min'), $('stat-danmaku-per-min').dataset.value, st.danmakuPerMin);
        $('stat-danmaku-per-min').dataset.value = st.danmakuPerMin;
        animateNumber($('stat-total-likes'), $('stat-total-likes').dataset.value, st.totalLikes);
        $('stat-total-likes').dataset.value = st.totalLikes;
        updateUsersBadge(st.online);
    }

    function updateUsersBadge(count) {
        const badge = $('sidebar-users-badge');
        badge.textContent = count;
        badge.classList.toggle('hidden', count <= 0);
    }

    function renderSystem(sys) {
        if (!sys) return;
        $('sys-node').textContent = sys.node || '—';
        $('sys-platform').textContent = (sys.platform || '—') + ' / ' + (sys.arch || '');
        $('sys-mem-total').textContent = fmtMem(sys.memTotalMB || 0);
        $('sys-mem-free').textContent = fmtMem(sys.memFreeMB || 0);
        $('sys-uptime').textContent = fmtUptime(sys.serviceUptime || 0);

        // ===== 新增预览信息 =====
        const cpuEl = $('sys-cpu-usage');
        if (typeof sys.cpuUsage === 'number') {
            cpuEl.textContent = sys.cpuUsage + '%';
            cpuEl.className = 'status-value' + (sys.cpuUsage > 85 ? ' status-bad' : sys.cpuUsage > 60 ? ' status-warn' : '');
        } else {
            cpuEl.textContent = '—';
        }
        $('sys-cpu-count').textContent = (sys.cpuCount || '—') + (sys.cpuModel ? ' 核' : '');
        if (sys.cpuModel) $('sys-cpu-count').title = sys.cpuModel;
        $('sys-process-rss').textContent = sys.processRssMB ? fmtMem(sys.processRssMB) : '—';
        $('sys-process-heap').textContent = sys.processHeapMB ? fmtMem(sys.processHeapMB) : '—';
        $('sys-local-ip').textContent = sys.localIP || '—';
    }

    // ==================== 链路诊断渲染 ====================

    function renderLinkDiag(diag) {
        if (!diag) return;

        // frp 跳板端口
        const frpMap = {
            'diag-frp-flv': diag.frp && diag.frp.flv,
            'diag-frp-hls': diag.frp && diag.frp.hls,
        };
        for (const [id, item] of Object.entries(frpMap)) {
            renderDiagItem(id, item);
        }

        // ESA/CF 域名
        const domMap = {
            'diag-dom-flv': diag.domains && diag.domains.flv,
            'diag-dom-stream': diag.domains && diag.domains.stream,
            'diag-dom-live': diag.domains && diag.domains.live,
        };
        for (const [id, item] of Object.entries(domMap)) {
            renderDiagItem(id, item);
        }
    }

    function renderDiagItem(id, item) {
        const statusEl = $(id);
        const latEl = $(id + '-lat');
        const detailEl = $(id + '-detail');
        if (!statusEl) return;

        if (!item || !item.lastCheck) {
            statusEl.textContent = '未探测';
            statusEl.className = 'diag-status diag-unknown';
            if (latEl) latEl.textContent = '-';
            if (detailEl) detailEl.textContent = '-';
            return;
        }

        if (item.ok) {
            statusEl.textContent = '正常';
            statusEl.className = 'diag-status diag-ok';
        } else {
            statusEl.textContent = '异常';
            statusEl.className = 'diag-status diag-fail';
        }
        if (latEl) latEl.textContent = item.latency ? (item.latency + 'ms') : '-';
        if (detailEl) {
            detailEl.textContent = item.status || (item.ip ? item.ip : '-');
        }
    }

    // ==================== ECharts ====================

    function onChartResize() {
        if (chart) chart.resize();
    }

    function initChart() {
        if (typeof echarts === 'undefined' || !$('chart')) return;
        if (chart) chart.dispose();
        chart = echarts.init($('chart'));
        chart.setOption({
            backgroundColor: 'transparent',
            tooltip: {
                trigger: 'axis',
                backgroundColor: 'rgba(13,13,18,0.95)',
                borderColor: 'rgba(255,255,255,0.1)',
                textStyle: { color: '#f0f0f5' }
            },
            legend: {
                data: ['在线人数', '弹幕/分', '实时带宽'],
                textStyle: { color: 'rgba(168,168,184,0.9)' },
                top: 0
            },
            grid: { left: 48, right: 56, top: 40, bottom: 32 },
            xAxis: {
                type: 'category',
                data: chartData.times,
                axisLine: { lineStyle: { color: 'rgba(255,255,255,0.12)' } },
                axisLabel: { color: 'rgba(168,168,184,0.8)', fontSize: 11 },
                splitLine: { show: false }
            },
            yAxis: [
                {
                    type: 'value',
                    minInterval: 1,
                    name: '人数',
                    nameTextStyle: { color: 'rgba(168,168,184,0.8)' },
                    axisLine: { show: false },
                    axisLabel: { color: 'rgba(168,168,184,0.8)', fontSize: 11 },
                    splitLine: { lineStyle: { color: 'rgba(255,255,255,0.05)' } }
                },
                {
                    type: 'value',
                    name: '弹幕/分',
                    nameTextStyle: { color: 'rgba(168,168,184,0.8)' },
                    axisLine: { show: false },
                    axisLabel: { color: 'rgba(168,168,184,0.8)', fontSize: 11 },
                    splitLine: { show: false }
                },
                {
                    type: 'value',
                    name: '带宽 Mbps',
                    nameTextStyle: { color: 'rgba(168,168,184,0.8)' },
                    axisLine: { show: false },
                    axisLabel: {
                        color: 'rgba(168,168,184,0.8)',
                        fontSize: 11,
                        formatter: function(v) {
                            return v >= 1000 ? (v / 1000).toFixed(1) : v;
                        }
                    },
                    splitLine: { show: false }
                }
            ],
            series: [
                {
                    name: '在线人数',
                    type: 'line',
                    smooth: true,
                    showSymbol: false,
                    lineStyle: { width: 2.5, color: '#fb7299' },
                    areaStyle: {
                        color: {
                            type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
                            colorStops: [
                                { offset: 0, color: 'rgba(251,114,153,0.3)' },
                                { offset: 1, color: 'rgba(251,114,153,0)' }
                            ]
                        }
                    },
                    data: chartData.online
                },
                {
                    name: '弹幕/分',
                    type: 'line',
                    yAxisIndex: 1,
                    smooth: true,
                    showSymbol: false,
                    lineStyle: { width: 2.5, color: '#00a1d6' },
                    data: chartData.danmaku
                },
                {
                    name: '实时带宽',
                    type: 'line',
                    yAxisIndex: 2,
                    smooth: true,
                    showSymbol: false,
                    lineStyle: { width: 2, color: '#22c55e' },
                    areaStyle: {
                        color: {
                            type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
                            colorStops: [
                                { offset: 0, color: 'rgba(34,197,94,0.25)' },
                                { offset: 1, color: 'rgba(34,197,94,0)' }
                            ]
                        }
                    },
                    data: chartData.bandwidth
                }
            ]
        });
        window.removeEventListener('resize', onChartResize);
        window.addEventListener('resize', onChartResize);
    }

    function pushChart(st, bitrate) {
        if (!chart) return;
        chartData.times.push(fmtTime(Date.now()));
        chartData.online.push(st.online);
        chartData.danmaku.push(st.danmakuPerMin);
        chartData.bandwidth.push(Math.round(bitrate || 0));
        if (chartData.times.length > CHART_MAX_POINTS) {
            chartData.times.shift();
            chartData.online.shift();
            chartData.danmaku.shift();
            chartData.bandwidth.shift();
        }
        chart.setOption({
            xAxis: { data: chartData.times },
            series: [{ data: chartData.online }, { data: chartData.danmaku }, { data: chartData.bandwidth }]
        });
    }

    // ==================== 开关 ====================

    function setSwitch(name, value) {
        switches[name] = !!value;
        const el = $('switch-' + name);
        if (el) el.classList.toggle('on', !!value);
    }

    // ==================== 设置保存（实时预览） ====================

    function setupLivePreview() {
        $('setting-liveTitle').addEventListener('input', function() {
            document.title = (this.value || 'PrismLive') + ' 中控后台';
        });
    }

    async function saveSettings(e) {
        e.preventDefault();
        const body = {
            liveTitle: $('setting-liveTitle').value.trim(),
            liveAnnouncement: $('setting-liveAnnouncement').value.trim(),
            danmakuRateLimit: Number($('setting-danmakuRateLimit').value),
            sensitiveWords: $('setting-sensitiveWords').value.trim(),
            hlsBaseUrl: $('setting-hlsBaseUrl').value.trim(),
            flvBaseUrl: $('setting-flvBaseUrl').value.trim(),
            playEngine: $('setting-playEngine').value,
            liveEnabled: switches.liveEnabled,
            danmakuEnabled: switches.danmakuEnabled
        };
        try {
            await api('/api/admin/settings', { method: 'PUT', body });
            showSaveStatus('设置已保存');
            showToast('设置已保存', 'success');
            if (stateData && stateData.settings) {
                stateData.settings.liveTitle = body.liveTitle;
                stateData.settings.liveAnnouncement = body.liveAnnouncement;
                stateData.settings.danmakuRateLimit = body.danmakuRateLimit;
                stateData.settings.sensitiveWords = body.sensitiveWords;
                stateData.settings.hlsBaseUrl = body.hlsBaseUrl;
                stateData.settings.flvBaseUrl = body.flvBaseUrl;
                stateData.settings.playEngine = body.playEngine;
                stateData.settings.liveEnabled = body.liveEnabled;
                stateData.settings.danmakuEnabled = body.danmakuEnabled;
            }
        } catch (err) {
            if (err.code !== 401) showToast('保存失败: ' + err.message, 'error');
        }
    }

    function showSaveStatus(text) {
        const el = $('settings-status');
        el.textContent = text;
        el.classList.add('visible');
        setTimeout(() => el.classList.remove('visible'), 2500);
    }

    // ==================== 复制 / 重置密钥 / 快捷操作 ====================

    function copyText(text) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            return navigator.clipboard.writeText(text).then(
                () => showToast('已复制', 'success'),
                () => fallbackCopy(text)
            );
        }
        return fallbackCopy(text);
    }

    function fallbackCopy(text) {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        try {
            document.execCommand('copy');
            showToast('已复制', 'success');
        } catch (e) {
            showToast('复制失败，请手动复制', 'error');
        }
        document.body.removeChild(ta);
    }

    async function resetKey() {
        if (!window.confirm('确定重置推流密钥？旧密钥将立即失效，需在 OBS 中更新。')) return;
        try {
            const data = await api('/api/admin/key/reset', { method: 'POST' });
            $('info-streamKey').value = data.streamKey;
            $('info-hlsUrl').value = data.hlsUrl;
            if (stateData && stateData.settings) {
                stateData.settings.streamKey = data.streamKey;
                stateData.settings.hlsUrl = data.hlsUrl;
            }
            showToast('密钥已重置，请更新 OBS 配置', 'success');
        } catch (err) {
            if (err.code !== 401) showToast('重置失败: ' + err.message, 'error');
        }
    }

    function copyAllStreamInfo() {
        const text = `RTMP 地址: ${$('info-rtmpUrl').value}\n流密钥: ${$('info-streamKey').value}\n观众链接: ${$('info-hlsUrl').value}`;
        copyText(text);
    }

    async function refreshStats() {
        try {
            const state = await api('/api/admin/state');
            stateData = state;
            hydrate(state);
            showToast('已刷新', 'success');
        } catch (err) {
            if (err.code !== 401) showToast('刷新失败: ' + err.message, 'error');
        }
    }

    function exportStatsCsv() {
        if (!stateData || !stateData.stats) return;
        const st = stateData.stats;
        const nowStr = new Date().toLocaleString('zh-CN');
        downloadCsv(
            `prismlive-stats-${Date.now()}.csv`,
            ['时间', '当前在线', '峰值在线', '今日观看', '累计弹幕', '弹幕/分'],
            [[nowStr, st.online, st.peakOnline, st.todayViews, st.totalDanmaku, st.danmakuPerMin]]
        );
        showToast('统计 CSV 已导出', 'success');
    }

    // ==================== 在线用户 ====================

    async function loadUsers() {
        try {
            usersList = await api('/api/admin/users');
            renderUsers();
        } catch (err) {
            if (err.code !== 401) showToast('加载在线用户失败: ' + err.message, 'error');
        }
    }

    function renderUsers() {
        const tbody = $('users-tbody');
        const table = $('users-table');
        const empty = $('users-empty');
        tbody.innerHTML = '';

        const term = usersSearch.trim().toLowerCase();
        const list = usersList.filter((u) => {
            if (!term) return true;
            return (u.name && u.name.toLowerCase().includes(term)) || (u.qq && u.qq.includes(term));
        });

        if (!list.length) {
            table.style.display = 'none';
            empty.style.display = 'block';
            empty.textContent = term ? '未找到匹配用户' : '暂无在线用户';
            return;
        }

        table.style.display = 'table';
        empty.style.display = 'none';

        for (const u of list) {
            const tr = document.createElement('tr');
            const avatar = u.avatar || avatarFallback(u.name);
            const duration = fmtUptime(u.duration || 0);

            // 用 DOM API 构建用户单元格，避免 avatar URL 注入 (XSS)
            const cellUser = document.createElement('td');
            const userWrap = document.createElement('div');
            userWrap.className = 'user-cell';
            const img = document.createElement('img');
            img.src = avatar;
            img.className = 'user-avatar';
            img.alt = '';
            const info = document.createElement('div');
            const nameEl = document.createElement('div');
            nameEl.className = 'user-name';
            nameEl.textContent = u.name;
            info.appendChild(nameEl);
            if (u.qq) {
                const qqEl = document.createElement('div');
                qqEl.className = 'user-qq';
                qqEl.textContent = 'QQ: ' + u.qq;
                info.appendChild(qqEl);
            }
            userWrap.appendChild(img);
            userWrap.appendChild(info);
            cellUser.appendChild(userWrap);
            tr.appendChild(cellUser);

            const cellQq = document.createElement('td');
            cellQq.textContent = u.qq ? u.qq : '—';
            tr.appendChild(cellQq);

            const cellJoin = document.createElement('td');
            cellJoin.textContent = fmtDate(u.joinedAt);
            tr.appendChild(cellJoin);

            const cellDur = document.createElement('td');
            cellDur.textContent = duration;
            tr.appendChild(cellDur);

            const cellAct = document.createElement('td');
            const btn = document.createElement('button');
            btn.className = 'btn btn-danger btn-sm btn-kick';
            btn.dataset.id = u.socketId;
            btn.textContent = '踢出';
            cellAct.appendChild(btn);
            tr.appendChild(cellAct);

            tbody.appendChild(tr);
        }

        tbody.querySelectorAll('.btn-kick').forEach((btn) => {
            btn.addEventListener('click', () => kickUser(btn.dataset.id));
        });
    }

    async function kickUser(socketId) {
        if (!window.confirm('确定将该用户移出直播间？')) return;
        try {
            await api('/api/admin/users/' + encodeURIComponent(socketId) + '/kick', { method: 'POST' });
            showToast('已踢出', 'success');
            await loadUsers();
        } catch (err) {
            if (err.code !== 401) showToast('操作失败: ' + err.message, 'error');
        }
    }

    // ==================== 黑名单 ====================

    function renderBlacklist(list) {
        blacklistList = list || [];
        const tbody = $('blacklist-tbody');
        const table = $('blacklist-table');
        const empty = $('blacklist-empty');
        tbody.innerHTML = '';

        const term = blacklistSearch.trim().toLowerCase();
        const filtered = blacklistList.filter((item) => {
            if (!term) return true;
            return (item.ident && item.ident.toLowerCase().includes(term)) ||
                   (item.note && item.note.toLowerCase().includes(term));
        });

        if (!filtered.length) {
            table.style.display = 'none';
            empty.style.display = 'block';
            empty.textContent = term ? '未找到匹配记录' : '暂无黑名单记录';
            return;
        }

        table.style.display = 'table';
        empty.style.display = 'none';

        for (const item of filtered) {
            const tr = document.createElement('tr');
            const typeTag = item.type === 'qq'
                ? '<span class="tag tag-qq">QQ号</span>'
                : '<span class="tag tag-name">昵称</span>';
            tr.innerHTML =
                '<td>' + escapeHtml(item.ident) + '</td>' +
                '<td>' + typeTag + '</td>' +
                '<td>' + escapeHtml(item.note || '—') + '</td>' +
                '<td>' + fmtDate(item.created_at) + '</td>' +
                '<td><button class="btn btn-secondary btn-sm btn-sm-del" data-id="' + item.id + '">移除</button></td>';
            tbody.appendChild(tr);
        }

        tbody.querySelectorAll('.btn-sm-del').forEach((btn) => {
            btn.addEventListener('click', () => removeBlacklist(Number(btn.dataset.id)));
        });
    }

    async function addBlacklist(e) {
        e.preventDefault();
        const ident = $('blacklist-ident').value.trim();
        if (!ident) { showToast('请输入封禁对象', 'error'); return; }
        try {
            await api('/api/admin/blacklist', {
                method: 'POST',
                body: {
                    ident,
                    type: $('blacklist-type').value,
                    note: $('blacklist-note').value.trim()
                }
            });
            $('blacklist-ident').value = '';
            $('blacklist-note').value = '';
            await reloadBlacklist();
            showToast('已加入黑名单', 'success');
        } catch (err) {
            if (err.code !== 401) showToast(err.message, 'error');
        }
    }

    async function removeBlacklist(id) {
        try {
            await api('/api/admin/blacklist/' + id, { method: 'DELETE' });
            await reloadBlacklist();
            showToast('已移除', 'success');
        } catch (err) {
            if (err.code !== 401) showToast('操作失败: ' + err.message, 'error');
        }
    }

    async function reloadBlacklist() {
        const list = await api('/api/admin/blacklist');
        renderBlacklist(list || []);
        if (stateData) stateData.blacklist = list || [];
    }

    function exportBlacklistCsv() {
        const rows = blacklistList.map((item) => [
            item.ident,
            item.type === 'qq' ? 'QQ号' : '昵称',
            item.note || '',
            new Date(item.created_at).toLocaleString('zh-CN')
        ]);
        downloadCsv(
            `prismlive-blacklist-${Date.now()}.csv`,
            ['封禁对象', '类型', '备注', '添加时间'],
            rows
        );
        showToast('黑名单 CSV 已导出', 'success');
    }

    // ==================== 修改密码 ====================

    async function changePassword(e) {
        e.preventDefault();
        const oldPwd = $('old-password').value;
        const newPwd = $('new-password').value;
        const confirmPwd = $('confirm-password').value;
        if (newPwd.length < 6) { showToast('新密码至少 6 位', 'error'); return; }
        if (newPwd !== confirmPwd) { showToast('两次输入的新密码不一致', 'error'); return; }
        try {
            await api('/api/admin/password', {
                method: 'PUT',
                body: { oldPassword: oldPwd, newPassword: newPwd }
            });
            $('old-password').value = '';
            $('new-password').value = '';
            $('confirm-password').value = '';
            showToast('密码修改成功', 'success');
        } catch (err) {
            if (err.code !== 401) showToast(err.message, 'error');
        }
    }

    // ==================== 侧边栏导航 ====================

    function setupNav() {
        document.querySelectorAll('.sidebar-item').forEach((item) => {
            item.addEventListener('click', () => {
                document.querySelectorAll('.sidebar-item').forEach((i) => i.classList.remove('active'));
                item.classList.add('active');
                document.querySelectorAll('.section').forEach((s) => s.classList.remove('active'));
                $('section-' + item.dataset.section).classList.add('active');
                closeMobileSidebar();
            });
        });
    }

    function setupMobileSidebar() {
        const toggle = $('mobile-menu-toggle');
        const sidebar = $('sidebar');
        let overlay = document.querySelector('.sidebar-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.className = 'sidebar-overlay';
            document.body.appendChild(overlay);
        }
        toggle.addEventListener('click', () => {
            sidebar.classList.add('open');
            overlay.classList.add('open');
        });
        overlay.addEventListener('click', closeMobileSidebar);
    }

    function closeMobileSidebar() {
        $('sidebar').classList.remove('open');
        const overlay = document.querySelector('.sidebar-overlay');
        if (overlay) overlay.classList.remove('open');
    }

    // ==================== 事件绑定 ====================

    function bindEvents() {
        $('login-form').addEventListener('submit', handleLogin);
        $('settings-form').addEventListener('submit', saveSettings);
        setupLivePreview();

        $('switch-liveEnabled').addEventListener('click', () => setSwitch('liveEnabled', !switches.liveEnabled));
        $('switch-danmakuEnabled').addEventListener('click', () => setSwitch('danmakuEnabled', !switches.danmakuEnabled));

        document.querySelectorAll('.btn-copy').forEach((btn) => {
            btn.addEventListener('click', () => {
                const target = $(btn.dataset.target);
                if (target) copyText(target.value);
            });
        });

        $('btn-reset-key').addEventListener('click', resetKey);
        $('btn-copy-all').addEventListener('click', copyAllStreamInfo);
        $('btn-refresh-stats').addEventListener('click', refreshStats);
        $('btn-export-stats').addEventListener('click', exportStatsCsv);
        $('btn-refresh-users').addEventListener('click', loadUsers);

        $('users-search').addEventListener('input', function() {
            usersSearch = this.value;
            renderUsers();
        });

        $('blacklist-form').addEventListener('submit', addBlacklist);
        $('blacklist-search').addEventListener('input', function() {
            blacklistSearch = this.value;
            renderBlacklist(blacklistList);
        });
        $('btn-export-blacklist').addEventListener('click', exportBlacklistCsv);

        $('password-form').addEventListener('submit', changePassword);

        setupNav();
        setupMobileSidebar();
    }

    // ==================== 启动 ====================

    function start() {
        bindEvents();
        const token = localStorage.getItem(TOKEN_KEY);
        if (!token) {
            showLogin();
            return;
        }
        showMain();
        bootstrap().catch((e) => {
            if (e.code === 401) showLogin();
        });
    }

    document.addEventListener('DOMContentLoaded', start);
})();
