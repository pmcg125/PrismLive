# ============================================================
#  PrismLive 一键启动脚本 (PowerShell)
#
#  用法:
#    .\start.ps1                # 启动 MediaMTX + SRS + Node 主服务 (默认绑定 0.0.0.0)
#    .\start.ps1 -NoBrowser     # 不自动打开浏览器
#    .\start.ps1 -SkipMtx       # 跳过 MediaMTX 启动 (已手动运行时用)
#    .\start.ps1 -SkipSrs       # 跳过 SRS 启动 (已手动运行时用, 或无需 FLV 链路时)
#    .\start.ps1 -LocalOnly     # 只绑定 127.0.0.1 (默认是 0.0.0.0 对外暴露)
#
#  说明:
#    - 默认以 HOST=0.0.0.0 启动 Node 主服务 (对外暴露, 请确保有防火墙保护)
#    - 自动检测 Node 版本 (需要 >= 22.5, 内置 node:sqlite)
#    - 自动检测 mediamtx.exe / node_modules / 端口占用
#    - SRS 运行于 WSL Ubuntu 内 (FLV 链路): 若未运行则自动拉起, 已运行则跳过
#    - 发现端口被 PrismLive 已有实例占用时, 可选择杀死对方或退出
#    - Ctrl+C 或关闭窗口时优雅停止全部子进程 (停止 SRS 但不会关闭 WSL)
# ============================================================

[CmdletBinding()]
param(
    [switch]$NoBrowser,
    [switch]$SkipMtx,
    [switch]$SkipSrs,
    [switch]$LocalOnly
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# ---------- 常量 ----------
$RootDir     = $PSScriptRoot
$NodeMinVer  = 22.5
$Ports       = @{ 'RTMP(MediaMTX)' = 1935; 'HLS(MediaMTX)' = 8888; 'MTX API' = 9997; '观众端' = 8083; '中控后台' = 8084 }
# SRS (WSL Ubuntu) 常量
$SrsWslDist  = 'Ubuntu'
$SrsBinary   = '/usr/local/srs/objs/srs'
$SrsConf     = '/root/srs/srs.conf'
$SrsLog      = '/root/srs/srs.log'
$SrsPidFile  = '/usr/local/srs/objs/srs.pid'
$ColorOK     = 'Green'
$ColorWarn   = 'Yellow'
$ColorErr    = 'Red'
$ColorInfo   = 'Cyan'

$Host.UI.RawUI.WindowTitle = 'PrismLive 启动器'

function Write-Step($msg)   { Write-Host "  $msg" -ForegroundColor $ColorInfo }
function Write-Ok($msg)     { Write-Host "  [OK] $msg" -ForegroundColor $ColorOK }
function Write-WarnMsg($msg) { Write-Host "  [警告] $msg" -ForegroundColor $ColorWarn }
function Write-Fail($msg)   { Write-Host "  [错误] $msg" -ForegroundColor $ColorErr }

# ---------- Banner ----------
function Show-Banner {
    Write-Host ''
    Write-Host '  ============================================' -ForegroundColor $ColorInfo
    Write-Host '     PrismLive 私域直播平台 - 一键启动' -ForegroundColor $ColorInfo
    Write-Host '  ============================================' -ForegroundColor $ColorInfo
    Write-Host ''
}

# ---------- 进程 / 端口工具 ----------

# 获取占用某端口的监听进程 (无则返回 $null)
function Get-ProcessByPort([int]$port) {
    $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($conn) {
        return Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
    }
    return $null
}

# 获取进程命令行 (Win32)
function Get-ProcessCmdLine($proc) {
    try {
        $cim = Get-CimInstance Win32_Process -Filter "ProcessId=$($proc.Id)" -ErrorAction Stop
        return [string]$cim.CommandLine
    } catch {
        return ''
    }
}

# 判断进程是否属于 PrismLive (node server.js 或 mediamtx)
function Test-PrismLiveProcess($proc) {
    $name = $proc.ProcessName
    if ($name -match 'mediamtx') { return $true }
    if ($name -match '^node') {
        $cmd = Get-ProcessCmdLine $proc
        if ($cmd -match 'server\.js') { return $true }
    }
    return $false
}

# ---------- SRS (WSL Ubuntu) 工具 ----------

# 检查 SRS 是否已在 WSL 内运行; 返回 PID 或 $null
function Get-SrsPid {
    try {
        $out = wsl -d $SrsWslDist -- sh -c "pgrep -x srs 2>/dev/null | head -1" 2>$null
        $line = $out | Where-Object { $_ -match '^\d+$' } | Select-Object -First 1
        if ($line) { return [int]($line.Trim()) }
    } catch { }
    return $null
}

# 检查 WSL 发行版是否存在 (直接尝试进入, 避免解析 wsl -l 的 UTF-16 输出)
function Test-WslDist {
    $null = wsl -d $SrsWslDist -- sh -c "true" 2>&1
    return ($LASTEXITCODE -eq 0)
}

# 在 WSL 内执行需要 root 的命令 (自动处理: 免密 sudo → 环境变量密码 → 交互输入)
function Invoke-SrsShell([string]$cmd) {
    # 函数作用域内放松错误处理, 避免 native stderr 在 Stop 模式下抛 NativeCommandError
    $ErrorActionPreference = 'Continue'

    # 1. 免密 sudo
    $null = wsl -d $SrsWslDist -- sudo -n true 2>&1
    if ($LASTEXITCODE -eq 0) {
        return (wsl -d $SrsWslDist -- sudo sh -c $cmd 2>&1)
    }
    # 2. 环境变量密码
    if ($env:SRS_SUDO_PW) {
        return (echo $env:SRS_SUDO_PW | wsl -d $SrsWslDist -- sudo -S sh -c $cmd 2>&1)
    }
    # 3. 交互输入 (仅真实控制台)
    if ($Host.Name -eq 'ConsoleHost') {
        $sec = Read-Host 'SRS 需要 sudo 密码 (或先设置 $env:SRS_SUDO_PW)' -AsSecureString
        if ($sec) {
            $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
            $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
            return (echo $plain | wsl -d $SrsWslDist -- sudo -S sh -c $cmd 2>&1)
        }
    }
    return $null
}

# 启动 SRS (若未运行则拉起, 已运行则跳过)
function Start-SRS {
    if ($SkipSrs) {
        Write-Step '跳过 SRS 启动 (-SkipSrs)'
        return $true
    }
    if (-not (Test-WslDist)) {
        Write-WarnMsg "未检测到 WSL 发行版 [$SrsWslDist], 跳过 SRS 启动"
        return $true
    }
    $pidNow = Get-SrsPid
    if ($pidNow) {
        Write-Ok "SRS 已在运行 (PID: $pidNow), 跳过启动"
        return $true
    }
    Write-Step "SRS 未运行, 正在通过 WSL [$SrsWslDist] 启动 ..."
    $out = Invoke-SrsShell "cd /usr/local/srs && nohup ./objs/srs -c /root/srs/srs.conf > /root/srs/srs.log 2>&1 &"
    Start-Sleep -Seconds 3
    $pidAfter = Get-SrsPid
    if (-not $pidAfter) {
        Write-Fail "SRS 启动失败, 请查看日志: wsl -d $SrsWslDist -- sudo cat $SrsLog"
        return $false
    }
    Write-Ok "SRS 已启动 (PID: $pidAfter)"
    return $true
}

# 停止 SRS (优雅终止, 不关闭 WSL)
function Stop-SRS {
    $pidNow = Get-SrsPid
    if (-not $pidNow) {
        Write-Step 'SRS 未在运行, 跳过停止'
        return
    }
    Write-Step "停止 SRS (PID: $pidNow) ..."
    Invoke-SrsShell "kill -TERM $pidNow 2>/dev/null" | Out-Null
    Start-Sleep -Seconds 2
    if (Get-SrsPid) {
        Invoke-SrsShell "kill -9 $pidNow 2>/dev/null" | Out-Null
        Start-Sleep -Seconds 1
    }
    if (Get-SrsPid) {
        Write-WarnMsg 'SRS 未能完全停止 (进程仍存在)'
    } else {
        Write-Ok 'SRS 已停止 (WSL 保持运行)'
    }
}

# 处理端口冲突: 返回 $true=可继续, $false=应退出
function Resolve-PortConflict([int]$port, [string]$name) {
    $proc = Get-ProcessByPort $port
    if (-not $proc) { return $true }   # 端口已释放

    if (-not (Test-PrismLiveProcess $proc)) {
        Write-Fail "端口 $port ($name) 被其他程序占用: $($proc.ProcessName) (PID: $($proc.Id))"
        Write-WarnMsg '无法自动处理非 PrismLive 进程, 请手动关闭后重试'
        return $false
    }

    Write-WarnMsg "检测到已有 PrismLive 进程 (PID: $($proc.Id), $($proc.ProcessName)) 占用端口 $port ($name)"
    Write-Host ''
    Write-Host '  请选择操作:' -ForegroundColor $ColorInfo
    Write-Host '    [1] 杀死已有实例, 继续本次启动' -ForegroundColor $ColorInfo
    Write-Host '    [2] 不启动, 直接退出' -ForegroundColor $ColorInfo
    Write-Host ''

    $choice = ''
    while ($choice -notin @('1', '2')) {
        $choice = Read-Host '  请输入 [1/2]'
    }

    if ($choice -eq '2') {
        Write-Fail '已选择退出, 本次不启动'
        return $false
    }

    Write-Step "正在结束已有实例 (PID: $($proc.Id)) ..."
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 800
    if (Get-Process -Id $proc.Id -ErrorAction SilentlyContinue) {
        Write-Fail "未能结束 PID $($proc.Id), 请手动处理"
        return $false
    }
    Write-Ok "已结束 PID $($proc.Id)"
    return $true
}

# ---------- 环境检查 ----------
function Test-Environment {
    Write-Host '--- 环境检查 ---'

    # 1. Node.js
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Write-Fail '未检测到 Node.js，请先安装 Node.js (>= 22.5): https://nodejs.org/'
        return $false
    }
    $nodeVer = node --version
    $verNum = [version]($nodeVer -replace '^v', '')
    if ($verNum -lt $NodeMinVer) {
        Write-Fail "Node.js 版本过低: $nodeVer (需要 >= $NodeMinVer)"
        return $false
    }
    Write-Ok "Node.js $nodeVer"

    # 2. node_modules
    if (-not (Test-Path (Join-Path $RootDir 'node_modules'))) {
        Write-WarnMsg '未找到 node_modules，正在安装依赖 (npm install) ...'
        Push-Location $RootDir
        try {
            npm install
            if ($LASTEXITCODE -ne 0) { throw 'npm install 失败' }
            Write-Ok '依赖安装完成'
        } finally {
            Pop-Location
        }
    } else {
        Write-Ok '依赖已安装 (node_modules)'
    }

    # 3. MediaMTX
    $mtxExe = Join-Path $RootDir 'mediamtx.exe'
    if (-not $SkipMtx -and -not (Test-Path $mtxExe)) {
        Write-WarnMsg '未找到 mediamtx.exe，正在自动下载 ...'
        Push-Location $RootDir
        try {
            powershell -ExecutionPolicy Bypass -File (Join-Path $RootDir 'scripts\download-mediamtx.ps1')
            if (-not (Test-Path $mtxExe)) { throw 'MediaMTX 下载失败' }
            Write-Ok 'MediaMTX 下载完成'
        } finally {
            Pop-Location
        }
    }

    # 4. 端口占用检查 (冲突时提供选择)
    foreach ($name in $Ports.Keys) {
        $port = $Ports[$name]
        # MediaMTX 相关端口在 SkipMtx 模式下视为用户自管, 跳过
        $isMtxPort = $name -like '*MediaMTX*'
        if ($isMtxPort -and $SkipMtx) { continue }
        if (-not (Resolve-PortConflict $port $name)) {
            return $false
        }
    }
    Write-Ok '端口检查通过'
    return $true
}

# ---------- 启动 MediaMTX ----------
function Start-MediaMTX {
    if ($SkipMtx) {
        Write-Step '跳过 MediaMTX 启动 (-SkipMtx)'
        return $null
    }
    $mtxExe = Join-Path $RootDir 'mediamtx.exe'
    Write-Step "启动 MediaMTX: $mtxExe mediamtx.yml"
    $proc = Start-Process -FilePath $mtxExe -ArgumentList 'mediamtx.yml' -WorkingDirectory $RootDir -WindowStyle Minimized -PassThru
    Start-Sleep -Seconds 2
    if ($proc.HasExited) {
        Write-Fail 'MediaMTX 启动失败 (进程已退出)'
        return $null
    }
    Write-Ok "MediaMTX 已启动 (PID: $($proc.Id))"
    return $proc
}

# ---------- 启动 Node 主服务 ----------
function Start-Node {
    if ($LocalOnly) {
        $env:HOST = '127.0.0.1'
        Write-Step '绑定 127.0.0.1 (-LocalOnly)'
    } else {
        $env:HOST = '0.0.0.0'
        Write-WarnMsg '默认绑定 0.0.0.0 (对外暴露), 请确保防火墙/反向代理已保护'
    }
    Write-Step '启动 Node 主服务 (server.js) ...'
    # 真实控制台: 前台附加日志; 自动化/受限环境: 独立最小化窗口
    $isInteractive = $Host.Name -eq 'ConsoleHost'
    if ($isInteractive) {
        $nodeProc = Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory $RootDir -PassThru -NoNewWindow
    } else {
        $nodeProc = Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory $RootDir -PassThru -WindowStyle Minimized
    }
    Start-Sleep -Seconds 2
    if ($nodeProc.HasExited) {
        Write-Fail "Node 主服务启动失败 (PID: $($nodeProc.Id), ExitCode: $($nodeProc.ExitCode))"
        return $null
    }
    Write-Ok "Node 主服务已启动 (PID: $($nodeProc.Id))"
    return $nodeProc
}

# ---------- 打开浏览器 ----------
function Open-Browsers {
    if ($NoBrowser) { return }
    Start-Sleep -Seconds 1
    try {
        Start-Process 'http://localhost:8083'
        Start-Sleep -Milliseconds 500
        Start-Process 'http://localhost:8084'
    } catch {
        Write-WarnMsg '自动打开浏览器失败, 请手动访问'
    }
}

# ---------- 优雅停止 ----------
$script:MtxProc = $null
$script:NodeProc = $null

function Stop-All {
    Write-Host ''
    Write-Host '--- 正在停止服务 ---' -ForegroundColor $ColorWarn

    # 先停 Node (触发 server.js SIGINT 优雅退出, 持久化统计)
    if ($script:NodeProc -and -not $script:NodeProc.HasExited) {
        Write-Step "停止 Node (PID: $($script:NodeProc.Id)) ..."
        $script:NodeProc.CloseMainWindow() | Out-Null
        if (-not $script:NodeProc.WaitForExit(3000)) {
            Stop-Process -Id $script:NodeProc.Id -Force -ErrorAction SilentlyContinue
        }
        Write-Ok 'Node 已停止'
    }

    # 再停 MediaMTX
    if ($script:MtxProc -and -not $script:MtxProc.HasExited) {
        Write-Step "停止 MediaMTX (PID: $($script:MtxProc.Id)) ..."
        Stop-Process -Id $script:MtxProc.Id -Force -ErrorAction SilentlyContinue
        Write-Ok 'MediaMTX 已停止'
    }

    # 最后停 SRS (只停进程, 不关闭 WSL)
    Stop-SRS

    Write-Host ''
    Write-Host '  PrismLive 已退出, 感谢使用!' -ForegroundColor $ColorInfo
    exit 0
}

# ---------- 主流程 ----------
Show-Banner

if (-not (Test-Environment)) {
    Read-Host '按回车退出'
    exit 1
}

# 启动 SRS (FLV 链路, WSL 内)
if (-not (Start-SRS)) {
    Read-Host '按回车退出'
    exit 1
}

$script:MtxProc  = Start-MediaMTX
if (-not $SkipMtx -and -not $script:MtxProc) {
    Read-Host '按回车退出'
    exit 1
}

$script:NodeProc = Start-Node
if (-not $script:NodeProc) {
    if ($script:MtxProc) { Stop-Process -Id $script:MtxProc.Id -Force -ErrorAction SilentlyContinue }
    Stop-SRS
    Read-Host '按回车退出'
    exit 1
}

Write-Host ''
Write-Host '  ============================================' -ForegroundColor $ColorInfo
Write-Host '    PrismLive 已启动!' -ForegroundColor $ColorInfo
Write-Host '     观众端   http://localhost:8083' -ForegroundColor $ColorInfo
Write-Host '     中控后台 http://localhost:8084  (默认密码: admin123)' -ForegroundColor $ColorInfo
if (-not $SkipSrs -and (Get-SrsPid)) {
    Write-Host "     SRS(FLV) 运行于 WSL (PID: $(Get-SrsPid))" -ForegroundColor $ColorInfo
}
Write-Host '  ============================================' -ForegroundColor $ColorInfo
Write-Host '  按 Ctrl+C 停止服务' -ForegroundColor $ColorWarn
Write-Host ''

Open-Browsers

# 等待 Node 进程结束 (前台阻塞, Ctrl+C 时进 finally)
try {
    if ($script:NodeProc) {
        $script:NodeProc.WaitForExit()
    }
} finally {
    Stop-All
}
