$ErrorActionPreference = "Stop"

$port = 3552
$healthUrl = "http://127.0.0.1:$port/health"

try {
    $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
    if ($health.ok -and $health.mongo) {
        exit 0
    }
} catch {
    # No healthy auth API is available yet; check whether its port is occupied before starting another.
}

$portListener = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
if ($portListener) {
    throw "Port $port is already in use, but the launcher auth health check failed."
}

$mongoListener = Get-NetTCPConnection -State Listen -LocalPort 27017 -ErrorAction SilentlyContinue
if (-not $mongoListener) {
    throw "MongoDB is not listening on port 27017."
}

$serverPath = Join-Path $PSScriptRoot "backend-auth-server.js"
if (-not (Test-Path -LiteralPath $serverPath)) {
    throw "Auth server script not found at $serverPath."
}

$node = Get-Command node -ErrorAction Stop
$logDirectory = Join-Path $env:LOCALAPPDATA "ProjectFishk\AuthLogs"
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$logStamp = Get-Date -Format "yyyyMMdd-HHmmss"
$stdoutPath = Join-Path $logDirectory "auth-$logStamp.out.log"
$stderrPath = Join-Path $logDirectory "auth-$logStamp.err.log"

$env:PORT = [string]$port
$env:MONGO_URI = "mongodb://127.0.0.1:27017/FISHKY"
Start-Process `
    -FilePath $node.Source `
    -ArgumentList ('"{0}"' -f $serverPath) `
    -WorkingDirectory $PSScriptRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath