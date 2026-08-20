# 一键启动：对战平台服务器 + cpolar 外网隧道（启动后自动打印最新外网地址）
# 用法：powershell -ExecutionPolicy Bypass -File start-external.ps1
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root
# cpolar 日志统一放在 logs\cpolar\ 目录（含 cpolar 自动轮转的日期/ master 日志）
$cpolarLogDir = Join-Path $root 'logs\cpolar'
New-Item -ItemType Directory -Path $cpolarLogDir -Force | Out-Null
$logFile = Join-Path $cpolarLogDir 'cpolar-tunnel.log'

# 0. 停用 cpolar Windows 服务（避免其自动拉起实例与手动隧道冲突）并清理旧进程
try { Get-Service -Name 'cpolar*' -ErrorAction SilentlyContinue | Where-Object { $_.Status -ne 'Stopped' } | Stop-Service -Force -ErrorAction SilentlyContinue; Set-Service -Name 'cpolar*' -StartupType Disabled -ErrorAction SilentlyContinue } catch {}
Get-Process cpolar -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 1
Write-Host '[0] 已停用 cpolar 服务并清理旧进程'

# 1. 启动服务器（后台）
$server = Start-Process node -ArgumentList 'src/index.js' -WindowStyle Hidden -PassThru
Write-Host "[1] 服务器已启动 (PID $($server.Id))，等待就绪..."
Start-Sleep -Seconds 3

# 2. 启动 cpolar 隧道（指向本机 8080），用 cpolar 自带文件日志（实时写入，避免重定向缓冲）
$cpolar = 'C:\Program Files\cpolar\cpolar.exe'
if (-not (Test-Path $cpolar)) { $cpolar = Join-Path $root 'cpolar\cpolar.exe' }
if (Test-Path $cpolar) {
    # 确保旧 cpolar 进程全部退出，再清空旧日志（残留的旧地址会干扰匹配）
    for ($i = 0; $i -lt 10 -and (Get-Process cpolar -ErrorAction SilentlyContinue); $i++) {
        Get-Process cpolar -ErrorAction SilentlyContinue | Stop-Process -Force
        Start-Sleep -Milliseconds 500
    }
    for ($i = 0; $i -lt 5; $i++) {
        Remove-Item $logFile -Force -ErrorAction SilentlyContinue
        if (-not (Test-Path $logFile)) { break }
        Start-Sleep -Milliseconds 500
    }
    if (Test-Path $logFile) { try { [System.IO.File]::WriteAllText($logFile, '') } catch { Write-Host '  警告: 无法清空旧日志' -ForegroundColor Yellow } }
    Start-Process $cpolar -ArgumentList 'http','8080','-log',$logFile -WindowStyle Hidden
    Write-Host '[2] cpolar 隧道启动中，正在获取外网地址...'

    # 3. 轮询日志直到出现【可用】的隧道地址（最多 90 秒）。
    #    注意：cpolar 重启可能复用同一域名，所以对同一地址也要间隔重试，不能只试一次就死等新地址
    $url = $null
    $lastCandidate = $null
    $lastTryTime = $null
    $deadline = (Get-Date).AddSeconds(90)
    while (-not $url -and (Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 2
        if (Test-Path $logFile) {
            $log = Get-Content $logFile -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
            if ($log) {
                $m = [regex]::Matches($log, 'https://[a-z0-9]+\.r\d+\.(?:vip\.)?cpolar\.(?:cn|top)')
                if ($m.Count -gt 0) {
                    $candidate = $m[$m.Count - 1].Value
                    $now = Get-Date
                    $shouldTry = ($candidate -ne $lastCandidate) -or (-not $lastTryTime) -or (($now - $lastTryTime).TotalSeconds -ge 5)
                    if ($shouldTry) {
                        $lastCandidate = $candidate
                        $lastTryTime = $now
                        Write-Host "  检测到地址 $candidate，验证连通性..."
                        try {
                            $r = Invoke-WebRequest -Uri "$candidate/api/health" -UseBasicParsing -TimeoutSec 10
                            if ($r.StatusCode -eq 200) { $url = $candidate }
                            else { Write-Host "  地址返回 $($r.StatusCode)，稍后重试..." -ForegroundColor Yellow }
                        } catch {
                            Write-Host "  地址暂不可达，稍后重试..." -ForegroundColor Yellow
                        }
                    }
                }
            }
        }
    }

    if ($url) {
        Write-Host ''
        Write-Host '=================================================='
        Write-Host "  外网地址: $url" -ForegroundColor Green
        Write-Host '  客户端登录页"服务器地址"填上面的 HTTPS 地址'
        Write-Host '  数据管理页: <地址>/admin'
        Write-Host '=================================================='
        # 4. 连通性自检
        Start-Sleep -Seconds 2
        try {
            $r = Invoke-WebRequest -Uri "$url/api/health" -UseBasicParsing -TimeoutSec 20
            Write-Host "  外网连通性: 正常 ($($r.Content))" -ForegroundColor Green
        } catch {
            Write-Host "  外网连通性: 暂时无法访问（隧道可能还在建立，稍等或查看日志）" -ForegroundColor Yellow
        }
    } else {
        Write-Host '  未能从日志提取到外网地址，请稍后查看:' -ForegroundColor Red
        Write-Host "  $logFile" -ForegroundColor Yellow
    }
} else {
    Write-Host '  未找到 cpolar，请先安装：https://www.cpolar.com/download' -ForegroundColor Red
}

Write-Host ''
Write-Host "提示：本机地址 http://127.0.0.1:8080 ；状态检查：powershell -ExecutionPolicy Bypass -File check-status.ps1"
Write-Host ''
Write-Host '  服务正在后台运行，此窗口保持打开以便查看外网地址。' -ForegroundColor Cyan
Write-Host '  按 [S] 停止服务并退出；按 [回车] 保持运行...' -ForegroundColor Cyan
$key = Read-Host
if ($key -eq 's' -or $key -eq 'S') {
    Write-Host ''
    & (Join-Path $root 'stop-external.ps1')
}