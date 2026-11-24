# Download MediaMTX (Windows amd64) into the project root.
# Supports GitHub mirror acceleration for users in China.
# Usage:
#   .\download-mediamtx.ps1                 # auto: official + mirrors fallback
#   .\download-mediamtx.ps1 -Mirror ghfast.top

param(
    [string]$Mirror = ''
)

$ErrorActionPreference = 'Stop'

# Mirror prefixes (empty string = official GitHub).
# API and download URLs are prefixed with these in order.
$prefixes = @(
    '',
    'https://ghfast.top/',
    'https://gh-proxy.com/',
    'https://github.moeyy.xyz/',
    'https://ghproxy.net/'
)
if ($Mirror) {
    $prefixes = @("$Mirror/")
}

# --- Step 1: fetch latest release info (try each prefix) ---
$release = $null
foreach ($pfx in $prefixes) {
    try {
        $url = $pfx + 'https://api.github.com/repos/bluenviron/mediamtx/releases/latest'
        Write-Host "Fetching release info: $url"
        $release = Invoke-RestMethod $url -Headers @{ 'User-Agent' = 'PrismLive' } -TimeoutSec 25
        break
    } catch {
        Write-Host "  failed, trying next source..."
    }
}
if (-not $release) {
    throw 'Cannot fetch MediaMTX release info. Check network or pass -Mirror <host>.'
}

$tag = $release.tag_name
$asset = $release.assets | Where-Object { $_.name -match 'windows_amd64\.zip$' } | Select-Object -First 1
if (-not $asset) {
    throw 'No windows_amd64 package found in the latest release.'
}

# --- Step 2: download (try each prefix) ---
$zip = Join-Path $env:TEMP $asset.name
$dlOk = $false
foreach ($pfx in $prefixes) {
    try {
        $url = $pfx + $asset.browser_download_url
        Write-Host "Downloading: $url"
        Invoke-WebRequest -Uri $url -OutFile $zip -TimeoutSec 300
        $dlOk = $true
        break
    } catch {
        Write-Host "  failed, trying next source..."
    }
}
if (-not $dlOk) {
    throw 'Download failed. Check network or pass -Mirror <host>.'
}

# --- Step 3: extract ---
Write-Host "Extracting to $(Get-Location)..."
Expand-Archive -Path $zip -DestinationPath (Get-Location) -Force

if (Test-Path (Join-Path (Get-Location) 'mediamtx.exe')) {
    Write-Host "Done! Run: .\mediamtx.exe mediamtx.yml"
} else {
    Write-Host 'Extracted but mediamtx.exe not found. Please check the extracted folder.'
}
