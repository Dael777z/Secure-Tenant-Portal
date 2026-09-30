<#
  Summit - Windows launcher.

  Runs the portal on this PC with no installer and no administrator rights.
  Everything it needs lives under %LOCALAPPDATA%\ResidentPortal:

    node\         a portable Node.js 22, only if a suitable one is not installed
    pgsql\        portable PostgreSQL 16 binaries, only if not installed
    pgdata\       this machine's database cluster
    uploads\      maintenance photos and the notification outbox
    config.json   the ports and generated passwords for this machine

  Nothing is written outside that folder except logs, which go to var\logs in
  the project so they are easy to find.

  Start Portal.cmd        start everything (the first run downloads and seeds)
  Reset Demo Data.cmd     wipe the local database and seed it again
  Stop Portal.cmd         stop the server and the database

  The database runs as the superuser only for migrations and seeding. The
  server itself connects as portal_app, which is NOSUPERUSER NOBYPASSRLS, and
  refuses to start if that is not true - the same arrangement as production.
#>
param(
  [switch]$Reset,
  [switch]$Stop,
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch { }

$Root       = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
# FRIDAY TEST COPY: its own database, settings and uploads, so running or
# resetting this copy never touches the main project's data. The downloaded
# Node.js and PostgreSQL programs are shared with the main project's folder,
# so nothing is downloaded twice.
$Tools      = Join-Path $env:LOCALAPPDATA 'ResidentPortal'
$State      = Join-Path $env:LOCALAPPDATA 'ResidentPortal-FridayTest'
$Logs       = Join-Path $Root 'var\logs'
$PgData     = Join-Path $State 'pgdata'
$Downloads  = Join-Path $Tools 'downloads'
$ConfigPath = Join-Path $State 'config.json'
$PidPath    = Join-Path $State 'api.pid'
$PgLog      = Join-Path $State 'postgres.log'
$LauncherLog = Join-Path $Logs 'launcher.log'

New-Item -ItemType Directory -Force -Path $Tools, $State, $Logs, $Downloads | Out-Null
try { $Host.UI.RawUI.WindowTitle = 'Summit - Friday Test' } catch { }

# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

function Write-Log([string]$Message) {
  try { Add-Content -Path $LauncherLog -Value ('[{0}] {1}' -f (Get-Date -Format s), $Message) } catch { }
}

function Step([string]$Message) {
  Write-Host ''
  Write-Host "==> $Message" -ForegroundColor Cyan
  Write-Log "==> $Message"
}

function Info([string]$Message) {
  Write-Host "    $Message"
  Write-Log "    $Message"
}

function Warn([string]$Message) {
  Write-Host "    $Message" -ForegroundColor Yellow
  Write-Log "!!  $Message"
}

# ---------------------------------------------------------------------------
# Machine configuration: ports and secrets, generated once
# ---------------------------------------------------------------------------

function New-Secret([int]$Length = 40) {
  # 64 symbols, so a byte maps onto the alphabet with no modulo bias. All of
  # them are safe inside a SQL string literal and an environment variable.
  $alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  $bytes = New-Object byte[] $Length
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($bytes)
  $rng.Dispose()
  $chars = foreach ($b in $bytes) { $alphabet[$b % 64] }
  return (-join $chars)
}

function Get-Config {
  if (Test-Path $ConfigPath) {
    return (Get-Content -Path $ConfigPath -Raw | ConvertFrom-Json)
  }
  return [pscustomobject]@{
    pgPort        = 0
    appPort       = 0
    superPassword = (New-Secret 40)
    appPassword   = (New-Secret 40)
    sessionSecret = (New-Secret 64)
    seeded        = $false
  }
}

function Save-Config($Config) {
  [IO.File]::WriteAllText($ConfigPath, ($Config | ConvertTo-Json))
}

# ---------------------------------------------------------------------------
# Ports
# ---------------------------------------------------------------------------

function Test-PortInUse([int]$Port) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $attempt = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    if ($attempt.AsyncWaitHandle.WaitOne(300)) {
      $client.EndConnect($attempt)
      return $true
    }
    return $false
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

function Test-PortBindable([int]$Port) {
  $listener = $null
  try {
    $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $Port)
    $listener.Start()
    return $true
  } catch {
    return $false
  } finally {
    if ($listener) { $listener.Stop() }
  }
}

function Find-FreePort([int[]]$Candidates) {
  foreach ($port in $Candidates) {
    if (-not (Test-PortInUse $port) -and (Test-PortBindable $port)) { return $port }
  }
  throw ('None of these ports is free: {0}' -f ($Candidates -join ', '))
}

# ---------------------------------------------------------------------------
# Downloads
# ---------------------------------------------------------------------------

function Get-File([string]$Url, [string]$Destination) {
  $partial = "$Destination.partial"
  if (Test-Path $partial) { Remove-Item -Force $partial }
  $curl = Join-Path $env:SystemRoot 'System32\curl.exe'
  if (Test-Path $curl) {
    & $curl -L --fail --retry 3 --progress-bar -o $partial $Url
    if ($LASTEXITCODE -ne 0) { throw "Download failed ($LASTEXITCODE): $Url" }
  } else {
    Invoke-WebRequest -Uri $Url -OutFile $partial -UseBasicParsing
  }
  Move-Item -Force $partial $Destination
}

function Test-Download([string]$Url) {
  # HEAD first; some mirrors refuse it, so fall back to asking for one byte.
  foreach ($method in @('HEAD', 'RANGE')) {
    try {
      $request = [System.Net.HttpWebRequest]::Create($Url)
      $request.Timeout = 15000
      if ($method -eq 'HEAD') { $request.Method = 'HEAD' } else { $request.AddRange(0, 0) }
      $response = $request.GetResponse()
      $status = [int]$response.StatusCode
      $type = [string]$response.ContentType
      $response.Close()
      # A missing file sometimes comes back as a friendly HTML page with a 200.
      if (($status -eq 200 -or $status -eq 206) -and $type -notlike 'text/html*') { return $true }
      return $false
    } catch [System.Net.WebException] {
      $response = $_.Exception.Response
      if ($response -and ([int]$response.StatusCode -eq 404)) { return $false }
    } catch {
      return $false
    }
  }
  return $false
}

function Expand-Zip([string]$Zip, [string]$Destination, [string[]]$Exclude = @()) {
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
  if (Test-Path $tar) {
    $arguments = @('-xf', $Zip, '-C', $Destination)
    foreach ($pattern in $Exclude) { $arguments += @('--exclude', $pattern) }
    & $tar @arguments
    if ($LASTEXITCODE -ne 0) { throw "Could not extract $Zip" }
  } else {
    Expand-Archive -Path $Zip -DestinationPath $Destination -Force
  }
}

# ---------------------------------------------------------------------------
# Node.js
# ---------------------------------------------------------------------------

function Test-NodeVersion([string]$Version) {
  # The server runs TypeScript directly. Unflagged type stripping arrived in
  # 22.18, and the static server's stripTypeScriptTypes() in 22.13. Other
  # majors would probably work; 22 is what the test suite runs on.
  if ($Version -notmatch '^v(\d+)\.(\d+)\.') { return $false }
  return ([int]$Matches[1] -eq 22 -and [int]$Matches[2] -ge 18)
}

function Get-NodeVersion([string]$Exe) {
  try {
    $output = & $Exe --version
    if ($LASTEXITCODE -ne 0) { return $null }
    return ([string]$output).Trim()
  } catch {
    return $null
  }
}

function Resolve-Node {
  $candidates = @()
  $portable = Get-ChildItem -Path (Join-Path $Tools 'node') -Filter node.exe -Recurse -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($portable) { $candidates += $portable.FullName }
  $installed = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($installed) { $candidates += $installed.Source }

  foreach ($exe in $candidates) {
    $version = Get-NodeVersion $exe
    if ($version -and (Test-NodeVersion $version)) {
      Info "Using Node $version ($exe)"
      return $exe
    }
    if ($version) { Info "Found Node $version at $exe - need 22.18 or later in the 22 line" }
  }

  Info 'Downloading a portable Node.js 22 (about 30 MB)...'
  $index = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json'
  $arch = 'x64'
  if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { $arch = 'arm64' }
  $release = $index | Where-Object { $_.version -like 'v22.*' -and $_.files -contains "win-$arch-zip" } |
    Select-Object -First 1
  if (-not $release) { throw 'Could not find a Node.js 22 release for Windows on nodejs.org' }
  $name = "node-$($release.version)-win-$arch"
  $zip = Join-Path $Downloads "$name.zip"
  Get-File "https://nodejs.org/dist/$($release.version)/$name.zip" $zip
  $target = Join-Path $Tools 'node'
  if (Test-Path $target) { Remove-Item -Recurse -Force $target }
  Expand-Zip $zip $target
  Remove-Item -Force $zip
  $exe = Join-Path $target "$name\node.exe"
  if (-not (Test-Path $exe)) { throw "Node.js extracted, but $exe is missing" }
  Info "Using Node $($release.version) ($exe)"
  return $exe
}

# ---------------------------------------------------------------------------
# PostgreSQL
# ---------------------------------------------------------------------------

function Resolve-PostgresBin {
  $portable = Join-Path $Tools 'pgsql\bin'
  if (Test-Path (Join-Path $portable 'initdb.exe')) {
    Info "Using PostgreSQL binaries in $portable"
    return $portable
  }

  # An existing installation is fine: we only borrow its programs and create
  # our own cluster, so its data, service, and passwords are never touched.
  $programFiles = Join-Path $env:ProgramFiles 'PostgreSQL'
  $installed = Get-ChildItem -Path $programFiles -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^\d+$' -and [int]$_.Name -ge 16 } |
    Sort-Object { [int]$_.Name } -Descending
  foreach ($dir in $installed) {
    $bin = Join-Path $dir.FullName 'bin'
    if ((Test-Path (Join-Path $bin 'initdb.exe')) -and (Test-Path (Join-Path $bin 'pg_ctl.exe'))) {
      Info "Using the PostgreSQL $($dir.Name) programs already installed in $bin"
      return $bin
    }
  }

  Info 'Looking up the current PostgreSQL 16 build for Windows...'
  $url = $null
  foreach ($major in @(16, 17)) {
    for ($minor = 20; $minor -ge 0; $minor--) {
      foreach ($build in @(1, 2)) {
        $candidate = "https://get.enterprisedb.com/postgresql/postgresql-$major.$minor-$build-windows-x64-binaries.zip"
        if (Test-Download $candidate) { $url = $candidate; break }
      }
      if ($url) { break }
    }
    if ($url) { break }
  }
  if (-not $url) {
    throw 'Could not find PostgreSQL binaries to download. Install PostgreSQL 16 from postgresql.org and run this again.'
  }

  Info "Downloading $(Split-Path $url -Leaf) (about 300 MB, one time only)..."
  $zip = Join-Path $Downloads (Split-Path $url -Leaf)
  Get-File $url $zip
  Info 'Extracting (pgAdmin and debug symbols are skipped)...'
  $target = Join-Path $Tools 'pgsql'
  if (Test-Path $target) { Remove-Item -Recurse -Force $target }
  Expand-Zip $zip $Tools @('pgsql/pgAdmin 4', 'pgsql/pgAdmin 4/*', 'pgsql/symbols', 'pgsql/symbols/*', 'pgsql/doc', 'pgsql/doc/*')
  Remove-Item -Force $zip
  if (-not (Test-Path (Join-Path $portable 'initdb.exe'))) { throw "PostgreSQL extracted, but initdb.exe is missing from $portable" }
  return $portable
}

function Invoke-PgCtl([string]$PgBin, [string]$Arguments) {
  # pg_ctl start leaves postgres running as a descendant. Start-Process -Wait
  # would wait for it forever, and piping its output would hold the pipe open,
  # so wait on pg_ctl's own process and nothing else.
  $process = Start-Process -FilePath (Join-Path $PgBin 'pg_ctl.exe') -ArgumentList $Arguments -NoNewWindow -PassThru
  $null = $process.Handle
  $process.WaitForExit()
  return $process.ExitCode
}

function Test-PostgresRunning([string]$PgBin) {
  if (-not (Test-Path (Join-Path $PgData 'PG_VERSION'))) { return $false }
  $code = Invoke-PgCtl $PgBin ('status -D "{0}"' -f $PgData)
  return ($code -eq 0)
}

function Stop-Postgres([string]$PgBin) {
  if ($PgBin -and (Test-PostgresRunning $PgBin)) {
    Info 'Stopping the database...'
    $null = Invoke-PgCtl $PgBin ('stop -D "{0}" -m fast -w -t 60' -f $PgData)
  }
}

function Invoke-Psql([string]$PgBin, $Config, [string[]]$Arguments) {
  $env:PGPASSWORD = $Config.superPassword
  $base = @('-h', '127.0.0.1', '-p', [string]$Config.pgPort, '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-X', '-q')
  $output = & (Join-Path $PgBin 'psql.exe') @base @Arguments
  $code = $LASTEXITCODE
  Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
  if ($code -ne 0) { throw "psql failed ($code)" }
  return $output
}

# ---------------------------------------------------------------------------
# The API server
# ---------------------------------------------------------------------------

function Set-PortalEnvironment($Config, [string]$User, [string]$Password) {
  $env:NODE_ENV          = 'development'
  $env:HOST              = '127.0.0.1'   # loopback only: no firewall prompt, nothing exposed to the network
  $env:PORT              = [string]$Config.appPort
  $env:PGHOST            = '127.0.0.1'
  $env:PGPORT            = [string]$Config.pgPort
  $env:PGDATABASE        = 'portal'
  $env:PGUSER            = $User
  $env:PGPASSWORD        = $Password
  $env:PGSSL             = 'false'
  $env:SESSION_SECRET    = $Config.sessionSecret
  $env:PAYMENTS_PROVIDER = 'mock'
  $env:NOTIFY_PROVIDER   = 'console'
  $env:STORAGE_PROVIDER  = 'filesystem'
  $env:STORAGE_ROOT      = (Join-Path $State 'uploads')
  $env:JOBS_ENABLED      = 'false'
  $env:NODE_NO_WARNINGS  = '1'
}

function Invoke-Node([string]$Node, [string]$Command, [string]$LogName) {
  $out = Join-Path $Logs "$LogName.log"
  $err = Join-Path $Logs "$LogName.err.log"
  $process = Start-Process -FilePath $Node -ArgumentList "apps/api/src/main.ts $Command" -WorkingDirectory $Root `
    -NoNewWindow -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
  $null = $process.Handle
  $process.WaitForExit()
  foreach ($file in @($out, $err)) {
    if (Test-Path $file) {
      # JSON log lines are for machines; the plain lines are the ones meant for people.
      Get-Content -Path $file | Where-Object { $_ -and $_ -notmatch '^\{"t":|ExperimentalWarning|--trace-warnings' } |
        ForEach-Object { Write-Host "      $_" -ForegroundColor DarkGray }
    }
  }
  if ($process.ExitCode -ne 0) { throw "'$Command' failed (exit $($process.ExitCode)). See var\logs\$LogName.err.log" }
}

function Get-RunningApi {
  if (-not (Test-Path $PidPath)) { return $null }
  $id = 0
  if (-not [int]::TryParse((Get-Content -Path $PidPath -Raw).Trim(), [ref]$id)) { return $null }
  $process = Get-Process -Id $id -ErrorAction SilentlyContinue
  if ($process -and $process.ProcessName -eq 'node') { return $process }
  return $null
}

function Stop-Api {
  $api = Get-RunningApi
  if ($api) {
    Info "Stopping the server (process $($api.Id))..."
    Stop-Process -Id $api.Id -Force
    Start-Sleep -Milliseconds 500
  }
  if (Test-Path $PidPath) { Remove-Item -Force $PidPath }
}

function Test-Healthy([int]$Port) {
  try {
    $request = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$Port/api/v1/health")
    $request.Proxy = $null
    $request.Timeout = 3000
    $response = $request.GetResponse()
    $ok = ([int]$response.StatusCode -eq 200)
    $response.Close()
    return $ok
  } catch {
    return $false
  }
}

function Show-Banner([int]$Port) {
  $url = "http://localhost:$Port"
  Write-Host ''
  Write-Host '  ------------------------------------------------------------------' -ForegroundColor DarkGray
  Write-Host '   Summit (FRIDAY TEST copy) is running' -ForegroundColor Green
  Write-Host "   $url" -ForegroundColor White
  Write-Host ''
  Write-Host '   Blank portal: no properties, units or residents yet.'
  Write-Host ''
  Write-Host '   Sign in:  manager@seniorproject.example'
  Write-Host '   Password: SeniorProject2026'
  Write-Host ''
  Write-Host '   Test payments: an amount ending in .01 declines, .02 settles and is'
  Write-Host '   returned later, .03 becomes a chargeback. Anything else succeeds.'
  Write-Host ''
  Write-Host '   Keep this window open. Close it or press Ctrl+C to stop the server.'
  Write-Host '   Stop Portal.cmd stops everything, database included.'
  Write-Host '  ------------------------------------------------------------------' -ForegroundColor DarkGray
  Write-Host ''
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

$api = $null
$exitCode = 0
try {
  Write-Log '---------------- launcher started ----------------'
  $config = Get-Config
  $pgBin = $null
  $portablePg = Join-Path $Tools 'pgsql\bin'
  if (Test-Path (Join-Path $portablePg 'pg_ctl.exe')) { $pgBin = $portablePg }

  if ($Stop) {
    Step 'Stopping Summit'
    Stop-Api
    if (-not $pgBin -and (Test-Path (Join-Path $PgData 'PG_VERSION'))) { $pgBin = Resolve-PostgresBin }
    Stop-Postgres $pgBin
    Info 'Stopped.'
    exit 0
  }

  $running = Get-RunningApi
  if ($running -and -not $Reset -and $config.appPort -and (Test-Healthy $config.appPort)) {
    Step "Already running at http://localhost:$($config.appPort)"
    if (-not $NoBrowser) { Start-Process "http://localhost:$($config.appPort)" }
    exit 0
  }
  Stop-Api

  Step 'Checking what this PC already has'
  $node = Resolve-Node
  $pgBin = Resolve-PostgresBin

  if ($Reset) {
    Step 'Resetting the demo data'
    Stop-Postgres $pgBin
    if (Test-Path $PgData) { Remove-Item -Recurse -Force $PgData }
    $uploads = Join-Path $State 'uploads'
    if (Test-Path $uploads) { Remove-Item -Recurse -Force $uploads }
    $config.seeded = $false
    Info 'Local database removed; it will be created and seeded again.'
  }

  $pgRunning = Test-PostgresRunning $pgBin
  if (-not $pgRunning) {
    if (-not $config.pgPort -or (Test-PortInUse $config.pgPort) -or -not (Test-PortBindable $config.pgPort)) {
      $config.pgPort = Find-FreePort (5433..5450)
    }
  }
  if (-not $config.appPort -or (Test-PortInUse $config.appPort) -or -not (Test-PortBindable $config.appPort)) {
    $config.appPort = Find-FreePort (@(4100) + (4101..4120))
  }
  Save-Config $config

  if (-not (Test-Path (Join-Path $PgData 'PG_VERSION'))) {
    Step 'Creating the local database cluster'
    $pwFile = Join-Path $State 'initdb.pw'
    [IO.File]::WriteAllText($pwFile, $config.superPassword)
    try {
      & (Join-Path $pgBin 'initdb.exe') -D $PgData -U postgres "--pwfile=$pwFile" -A scram-sha-256 -E UTF8 --no-locale | Out-Host
      if ($LASTEXITCODE -ne 0) { throw "initdb failed ($LASTEXITCODE)" }
    } finally {
      Remove-Item -Force $pwFile -ErrorAction SilentlyContinue
    }
    $config.seeded = $false
    Save-Config $config
  }

  if (-not $pgRunning) {
    Step "Starting PostgreSQL on port $($config.pgPort)"
    $arguments = 'start -D "{0}" -l "{1}" -o "-p {2} -c listen_addresses=127.0.0.1" -w -t 90' -f $PgData, $PgLog, $config.pgPort
    $code = Invoke-PgCtl $pgBin $arguments
    if ($code -ne 0) {
      if (Test-Path $PgLog) { Copy-Item -Force $PgLog (Join-Path $Logs 'postgres.log') }
      throw "PostgreSQL did not start (pg_ctl exit $code). See var\logs\postgres.log"
    }
  } else {
    Step "PostgreSQL is already running on port $($config.pgPort)"
  }

  Step 'Preparing the database and the application role'
  $roleSql = @'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'portal_app') THEN
    CREATE ROLE portal_app LOGIN;
  END IF;
END
$$;
ALTER ROLE portal_app LOGIN PASSWORD '__APP_PASSWORD__'
  NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
'@
  $sqlFile = Join-Path $State 'bootstrap.sql'
  [IO.File]::WriteAllText($sqlFile, $roleSql.Replace('__APP_PASSWORD__', $config.appPassword))
  try {
    Invoke-Psql $pgBin $config @('-d', 'postgres', '-f', $sqlFile) | Out-Null
  } finally {
    Remove-Item -Force $sqlFile -ErrorAction SilentlyContinue
  }
  $exists = Invoke-Psql $pgBin $config @('-d', 'postgres', '-tA', '-c', "SELECT 1 FROM pg_database WHERE datname = 'portal'")
  # "$exists", not [string]$exists: in Windows PowerShell 5.1 casting an empty
  # result (no rows, so psql printed nothing) to [string] yields $null.
  if ("$exists".Trim() -ne '1') {
    Invoke-Psql $pgBin $config @('-d', 'postgres', '-c', 'CREATE DATABASE portal') | Out-Null
    $config.seeded = $false
    Save-Config $config
    Info 'Created database "portal".'
  }
  Info 'portal_app: NOSUPERUSER NOBYPASSRLS'

  Step 'Applying migrations'
  Set-PortalEnvironment $config 'postgres' $config.superPassword
  Invoke-Node $node 'migrate' 'migrate'

  if (-not $config.seeded) {
    Step 'Preparing a blank portal (manager sign-in only, no residents or properties)'
    Invoke-Node $node 'seed' 'seed'
    $config.seeded = $true
    Save-Config $config
  }

  Step 'Checking the security posture as the application role'
  Set-PortalEnvironment $config 'portal_app' $config.appPassword
  Invoke-Node $node 'check' 'check'

  Step "Starting the server on port $($config.appPort)"
  $apiOut = Join-Path $Logs 'api.log'
  $apiErr = Join-Path $Logs 'api.err.log'
  $api = Start-Process -FilePath $node -ArgumentList 'apps/api/src/main.ts serve' -WorkingDirectory $Root `
    -NoNewWindow -PassThru -RedirectStandardOutput $apiOut -RedirectStandardError $apiErr
  $null = $api.Handle
  [IO.File]::WriteAllText($PidPath, [string]$api.Id)

  $deadline = (Get-Date).AddSeconds(60)
  $healthy = $false
  while ((Get-Date) -lt $deadline) {
    if ($api.HasExited) { break }
    if (Test-Healthy $config.appPort) { $healthy = $true; break }
    Start-Sleep -Milliseconds 500
  }
  if (-not $healthy) {
    if (Test-Path $apiErr) { Get-Content -Path $apiErr -Tail 20 | ForEach-Object { Write-Host "      $_" -ForegroundColor DarkGray } }
    throw 'The server did not come up. See var\logs\api.err.log'
  }

  Show-Banner $config.appPort
  Write-Log "running on port $($config.appPort), pid $($api.Id)"
  if (-not $NoBrowser) { Start-Process "http://localhost:$($config.appPort)" }

  while (-not $api.HasExited) { Start-Sleep -Seconds 1 }
  $api.WaitForExit()
  if ($api.ExitCode -ne 0) {
    Warn "The server stopped (exit $($api.ExitCode))."
    if (Test-Path $apiErr) { Get-Content -Path $apiErr -Tail 20 | ForEach-Object { Write-Host "      $_" -ForegroundColor DarkGray } }
    $exitCode = 1
  }
} catch {
  Write-Host ''
  Write-Host "  Something went wrong: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "  Logs are in $Logs" -ForegroundColor Red
  Write-Host '  If it keeps failing at the same step, Reset Demo Data.cmd starts the database over.' -ForegroundColor Red
  Write-Log "FAILED: $($_.Exception.Message)"
  Write-Log ($_.ScriptStackTrace)
  $exitCode = 1
} finally {
  if ($api -and -not $api.HasExited) { Stop-Process -Id $api.Id -Force -ErrorAction SilentlyContinue }
  if ($api -and (Test-Path $PidPath)) { Remove-Item -Force $PidPath -ErrorAction SilentlyContinue }
}
exit $exitCode
