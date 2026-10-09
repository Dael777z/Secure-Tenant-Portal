<#
  Secure Tenant Portal (team repo) - one-click demo launcher for Windows.

  Start Demo.cmd    install what is needed, start the database and the app, open the browser
  Stop Demo.cmd     stop the app and the database
  Reset Demo.cmd    delete the demo database and start fresh with the sample data

  No installer and no administrator rights. Everything lives in:
    %LOCALAPPDATA%\SecureTenantPortal   this app's database, settings and logs
    %LOCALAPPDATA%\ResidentPortal       portable Node.js and PostgreSQL (shared with
                                        the resident-portal launcher; downloaded once)

  Works in Windows PowerShell 5.1 (what powershell.exe is on Windows 10/11).
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
$Tools      = Join-Path $env:LOCALAPPDATA 'ResidentPortal'
$State      = Join-Path $env:LOCALAPPDATA 'SecureTenantPortal'
$Downloads  = Join-Path $Tools 'downloads'
$PgData     = Join-Path $State 'pgdata'
$PgLog      = Join-Path $State 'postgres.log'
$ConfigPath = Join-Path $State 'config.json'
$PidPath    = Join-Path $State 'app.pid'
$Logs       = Join-Path $Root 'logs'
$EnvPath    = Join-Path $Root '.env'

New-Item -ItemType Directory -Force -Path $Tools, $State, $Downloads, $Logs | Out-Null
try { $Host.UI.RawUI.WindowTitle = 'Secure Tenant Portal - demo' } catch { }

$DemoManagerPassword = 'manager-demo-password'
$DemoTenantPassword  = 'tenant-demo-password'

function Step([string]$Message) { Write-Host ''; Write-Host "==> $Message" -ForegroundColor Cyan }
function Info([string]$Message) { Write-Host "    $Message" }
function Warn([string]$Message) { Write-Host "    $Message" -ForegroundColor Yellow }

function New-Secret([int]$Length = 40) {
  $alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  $bytes = New-Object byte[] $Length
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($bytes)
  $rng.Dispose()
  $chars = foreach ($b in $bytes) { $alphabet[$b % 64] }
  return (-join $chars)
}

function Get-Config {
  if (Test-Path $ConfigPath) { return (Get-Content -Path $ConfigPath -Raw | ConvertFrom-Json) }
  return [pscustomobject]@{
    pgPort        = 0
    superPassword = (New-Secret 40)
    appPassword   = (New-Secret 40)
  }
}

function Save-Config($Config) { [IO.File]::WriteAllText($ConfigPath, ($Config | ConvertTo-Json)) }

# --------------------------------------------------------------------------- ports

function Test-PortInUse([int]$Port) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $attempt = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    if ($attempt.AsyncWaitHandle.WaitOne(300)) { $client.EndConnect($attempt); return $true }
    return $false
  } catch { return $false } finally { $client.Close() }
}

function Find-FreePort([int[]]$Candidates) {
  foreach ($port in $Candidates) { if (-not (Test-PortInUse $port)) { return $port } }
  throw ('None of these ports is free: {0}' -f ($Candidates -join ', '))
}

# --------------------------------------------------------------------------- downloads

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
  try {
    $request = [System.Net.HttpWebRequest]::Create($Url)
    $request.Timeout = 15000
    $request.Method = 'HEAD'
    $response = $request.GetResponse()
    $ok = ([int]$response.StatusCode -eq 200) -and ([string]$response.ContentType -notlike 'text/html*')
    $response.Close()
    return $ok
  } catch { return $false }
}

# Vite listens on "localhost", which newer Node.js on Windows binds to the IPv6
# address [::1] only, so 127.0.0.1 alone never answers. Try every spelling.
function Test-Local([int]$Port, [string]$Path = '/') {
  foreach ($hostName in @('localhost', '127.0.0.1', '[::1]')) {
    if (Test-Url "http://${hostName}:$Port$Path") { return $true }
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

# --------------------------------------------------------------------------- Node.js

function Test-NodeVersion([string]$Version) {
  # Vite 8 and the team's tooling want Node 22.12 or newer.
  if ($Version -notmatch '^v(\d+)\.(\d+)\.') { return $false }
  $major = [int]$Matches[1]; $minor = [int]$Matches[2]
  return (($major -eq 22 -and $minor -ge 12) -or $major -ge 23)
}

function Resolve-Node {
  $candidates = @()
  $installed = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($installed) { $candidates += $installed.Source }
  $portable = Get-ChildItem -Path (Join-Path $Tools 'node') -Filter node.exe -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($portable) { $candidates += $portable.FullName }

  foreach ($exe in $candidates) {
    $version = $null
    try { $version = ([string](& $exe --version)).Trim() } catch { }
    $npm = Join-Path (Split-Path $exe) 'npm.cmd'
    if ($version -and (Test-NodeVersion $version) -and (Test-Path $npm)) {
      Info "Using Node $version ($exe)"
      return $exe
    }
    if ($version) { Info "Found Node $version at $exe - need 22.12 or newer, with npm" }
  }

  Info 'Downloading a portable Node.js 22 (about 30 MB)...'
  $index = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json'
  $arch = 'x64'
  if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { $arch = 'arm64' }
  $release = $index | Where-Object { $_.version -like 'v22.*' -and $_.files -contains "win-$arch-zip" } | Select-Object -First 1
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

# --------------------------------------------------------------------------- PostgreSQL

function Resolve-PostgresBin {
  $portable = Join-Path $Tools 'pgsql\bin'
  if (Test-Path (Join-Path $portable 'initdb.exe')) { Info "Using PostgreSQL in $portable"; return $portable }

  $programFiles = Join-Path $env:ProgramFiles 'PostgreSQL'
  $installed = Get-ChildItem -Path $programFiles -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^\d+$' -and [int]$_.Name -ge 14 } | Sort-Object { [int]$_.Name } -Descending
  foreach ($dir in $installed) {
    $bin = Join-Path $dir.FullName 'bin'
    if ((Test-Path (Join-Path $bin 'initdb.exe')) -and (Test-Path (Join-Path $bin 'pg_ctl.exe'))) {
      Info "Using the PostgreSQL $($dir.Name) programs in $bin (its own data is not touched)"
      return $bin
    }
  }

  Info 'Looking up a PostgreSQL 16 build for Windows...'
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
  if (-not $url) { throw 'Could not find PostgreSQL to download. Install PostgreSQL 16 from postgresql.org and run this again.' }

  Info "Downloading $(Split-Path $url -Leaf) (about 300 MB, one time only)..."
  $zip = Join-Path $Downloads (Split-Path $url -Leaf)
  Get-File $url $zip
  Info 'Extracting...'
  $target = Join-Path $Tools 'pgsql'
  if (Test-Path $target) { Remove-Item -Recurse -Force $target }
  Expand-Zip $zip $Tools @('pgsql/pgAdmin 4', 'pgsql/pgAdmin 4/*', 'pgsql/symbols', 'pgsql/symbols/*', 'pgsql/doc', 'pgsql/doc/*')
  Remove-Item -Force $zip
  if (-not (Test-Path (Join-Path $portable 'initdb.exe'))) { throw "PostgreSQL extracted, but initdb.exe is missing from $portable" }
  return $portable
}

function Invoke-PgCtl([string]$PgBin, [string]$Arguments) {
  $process = Start-Process -FilePath (Join-Path $PgBin 'pg_ctl.exe') -ArgumentList $Arguments -NoNewWindow -PassThru
  $null = $process.Handle
  $process.WaitForExit()
  return $process.ExitCode
}

function Test-PostgresRunning([string]$PgBin) {
  if (-not (Test-Path (Join-Path $PgData 'PG_VERSION'))) { return $false }
  return ((Invoke-PgCtl $PgBin ('status -D "{0}"' -f $PgData)) -eq 0)
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

# --------------------------------------------------------------------------- .env

function Set-EnvValue([string]$Name, [string]$Value) {
  $lines = @()
  if (Test-Path $EnvPath) { $lines = @(Get-Content -Path $EnvPath) }
  $found = $false
  $out = foreach ($line in $lines) {
    if ($line -match ('^\s*' + [regex]::Escape($Name) + '\s*=')) { $found = $true; "$Name=$Value" } else { $line }
  }
  if (-not $found) { $out = @($out) + "$Name=$Value" }
  [IO.File]::WriteAllLines($EnvPath, [string[]]$out)
}

function Get-EnvValue([string]$Name) {
  if (-not (Test-Path $EnvPath)) { return '' }
  foreach ($line in (Get-Content -Path $EnvPath)) {
    if ($line -match ('^\s*' + [regex]::Escape($Name) + '\s*=(.*)$')) { return $Matches[1].Trim() }
  }
  return ''
}

function Initialize-Env($Config, [int]$ApiPort) {
  if (-not (Test-Path $EnvPath)) {
    Copy-Item (Join-Path $Root '.env.example') $EnvPath
    Info 'Created .env from .env.example (it stays on this PC; git ignores it).'
  }
  $url = "postgres://portal:$($Config.appPassword)@127.0.0.1:$($Config.pgPort)/portal"
  Set-EnvValue 'DATABASE_URL' $url
  Set-EnvValue 'TEST_DATABASE_URL' "postgres://portal:$($Config.appPassword)@127.0.0.1:$($Config.pgPort)/portal_test"
  Set-EnvValue 'PORT' ([string]$ApiPort)
  Set-EnvValue 'WEB_ORIGIN' 'http://localhost:5173'
  Set-EnvValue 'DEV' '1'
  Set-EnvValue 'LOG_FILE_ENABLED' '0'
  $jwt = Get-EnvValue 'JWT_ACCESS_SECRET'
  if (-not $jwt -or $jwt -eq 'replace-with-a-long-random-secret') { Set-EnvValue 'JWT_ACCESS_SECRET' (New-Secret 64) }
  if (-not (Get-EnvValue 'SEED_ADMIN_PASSWORD')) { Set-EnvValue 'SEED_ADMIN_PASSWORD' $DemoManagerPassword }
  if (-not (Get-EnvValue 'SEED_TENANT_PASSWORD')) { Set-EnvValue 'SEED_TENANT_PASSWORD' $DemoTenantPassword }

  # Ask for the Plaid keys once. Skipping is remembered; add them to .env any time.
  $asked = $Config.PSObject.Properties.Name -contains 'plaidAsked'
  if (-not (Get-EnvValue 'PLAID_CLIENT_ID') -and -not $asked) {
    $Config | Add-Member -NotePropertyName plaidAsked -NotePropertyValue $true -Force
    Save-Config $Config
    Write-Host ''
    Write-Host '    Bank linking uses Plaid. Paste the SANDBOX keys from the team Discord, or press Enter' -ForegroundColor Yellow
    Write-Host '    to skip (payments are then recorded as a demo bank transfer). You can add them to .env later.' -ForegroundColor Yellow
    $id = Read-Host '    PLAID_CLIENT_ID'
    if ($id) {
      $secret = Read-Host '    PLAID_SECRET'
      Set-EnvValue 'PLAID_CLIENT_ID' $id.Trim()
      Set-EnvValue 'PLAID_SECRET' $secret.Trim()
      Set-EnvValue 'PLAID_ENV' 'sandbox'
    }
  }
}

# --------------------------------------------------------------------------- the app

function Invoke-Npm([string]$NodeExe, [string[]]$Arguments, [string]$What) {
  $npm = Join-Path (Split-Path $NodeExe) 'npm.cmd'
  & $npm @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$What failed (npm exit $LASTEXITCODE)" }
}

function Stop-App {
  if (Test-Path $PidPath) {
    $id = (Get-Content -Path $PidPath -Raw).Trim()
    if ($id -match '^\d+$' -and (Get-Process -Id ([int]$id) -ErrorAction SilentlyContinue)) {
      Info "Stopping the app (process $id and its children)..."
      & taskkill.exe /PID $id /T /F | Out-Null
    }
    Remove-Item -Force $PidPath
  }
}

function Test-Url([string]$Url) {
  try {
    $request = [System.Net.HttpWebRequest]::Create($Url)
    $request.Proxy = $null
    $request.Timeout = 2000
    $response = $request.GetResponse()
    $response.Close()
    return $true
  } catch [System.Net.WebException] {
    # Any HTTP answer (even 401/404) means the server is up.
    return ($null -ne $_.Exception.Response)
  } catch { return $false }
}

# --------------------------------------------------------------------------- main

$app = $null
$exitCode = 0
try {
  $config = Get-Config
  $pgBin = $null
  if (Test-Path (Join-Path $Tools 'pgsql\bin\pg_ctl.exe')) { $pgBin = Join-Path $Tools 'pgsql\bin' }

  if ($Stop) {
    Step 'Stopping the Secure Tenant Portal demo'
    Stop-App
    if (-not $pgBin -and (Test-Path (Join-Path $PgData 'PG_VERSION'))) { $pgBin = Resolve-PostgresBin }
    Stop-Postgres $pgBin
    Info 'Stopped.'
    exit 0
  }

  Stop-App

  Step 'Checking what this PC already has'
  $node = Resolve-Node
  $env:Path = (Split-Path $node) + ';' + $env:Path   # npm scripts start node by name
  $pgBin = Resolve-PostgresBin

  if ($Reset) {
    Step 'Resetting the demo database'
    Stop-Postgres $pgBin
    if (Test-Path $PgData) { Remove-Item -Recurse -Force $PgData }
    Info 'Demo database removed; it will be created again with the sample data.'
  }

  $pgRunning = Test-PostgresRunning $pgBin
  if (-not $pgRunning -and (-not $config.pgPort -or (Test-PortInUse $config.pgPort))) {
    $config.pgPort = Find-FreePort (5440..5460)
  }
  Save-Config $config

  if (-not (Test-Path (Join-Path $PgData 'PG_VERSION'))) {
    Step 'Creating the demo database'
    $pwFile = Join-Path $State 'initdb.pw'
    [IO.File]::WriteAllText($pwFile, $config.superPassword)
    try {
      & (Join-Path $pgBin 'initdb.exe') -D $PgData -U postgres "--pwfile=$pwFile" -A scram-sha-256 -E UTF8 --no-locale | Out-Host
      if ($LASTEXITCODE -ne 0) { throw "initdb failed ($LASTEXITCODE)" }
    } finally { Remove-Item -Force $pwFile -ErrorAction SilentlyContinue }
  }

  if (-not $pgRunning) {
    Step "Starting PostgreSQL on port $($config.pgPort)"
    $arguments = 'start -D "{0}" -l "{1}" -o "-p {2} -c listen_addresses=127.0.0.1" -w -t 90' -f $PgData, $PgLog, $config.pgPort
    if ((Invoke-PgCtl $pgBin $arguments) -ne 0) { throw "PostgreSQL did not start. See $PgLog" }
  }

  Step 'Preparing the database login'
  $sql = @"
DO `$`$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'portal') THEN
    CREATE ROLE portal LOGIN;
  END IF;
END
`$`$;
ALTER ROLE portal LOGIN PASSWORD '$($config.appPassword)' NOSUPERUSER;
"@
  $sqlFile = Join-Path $State 'bootstrap.sql'
  [IO.File]::WriteAllText($sqlFile, $sql)
  try { Invoke-Psql $pgBin $config @('-d', 'postgres', '-f', $sqlFile) | Out-Null } finally { Remove-Item -Force $sqlFile -ErrorAction SilentlyContinue }
  foreach ($db in @('portal', 'portal_test')) {
    $exists = Invoke-Psql $pgBin $config @('-d', 'postgres', '-tA', '-c', "SELECT 1 FROM pg_database WHERE datname = '$db'")
    if ("$exists".Trim() -ne '1') {
      Invoke-Psql $pgBin $config @('-d', 'postgres', '-c', "CREATE DATABASE $db OWNER portal") | Out-Null
      Info "Created database $db"
    }
  }

  $apiPort = 3000
  if (Test-PortInUse 3000) { $apiPort = Find-FreePort (3001..3020) }
  if (Test-PortInUse 5173) { Warn 'Port 5173 is in use. Close whatever is using it (another dev server?) and run this again.'; throw 'Port 5173 is busy' }
  Step 'Settings (.env)'
  Initialize-Env $config $apiPort

  Push-Location $Root
  try {
    if (-not (Test-Path (Join-Path $Root 'node_modules\.bin'))) {
      Step 'Installing packages (npm install, first run only - a minute or two)'
      Invoke-Npm $node @('install', '--no-audit', '--no-fund') 'npm install'
    }
    Step 'Building tables (npm run db:migrate)'
    Invoke-Npm $node @('run', '-s', 'db:migrate') 'db:migrate'
    Step 'Loading sample data (npm run db:seed)'
    Invoke-Npm $node @('run', '-s', 'db:seed') 'db:seed'
  } finally { Pop-Location }

  Step 'Starting the app (npm run dev)'
  $npmCmd = Join-Path (Split-Path $node) 'npm.cmd'
  $app = Start-Process -FilePath $npmCmd -ArgumentList 'run', 'dev' -WorkingDirectory $Root -NoNewWindow -PassThru
  $null = $app.Handle
  [IO.File]::WriteAllText($PidPath, [string]$app.Id)

  $deadline = (Get-Date).AddSeconds(90)
  $up = $false
  while ((Get-Date) -lt $deadline) {
    if ($app.HasExited) { break }
    if ((Test-Local 5173 '/') -and (Test-Local $apiPort '/api/auth/me')) { $up = $true; break }
    Start-Sleep -Milliseconds 700
  }
  if (-not $up) {
    if ($app.HasExited) { throw 'The app stopped while starting. The messages above say why.' }
    throw 'The app did not answer at http://localhost:5173 within 90 seconds. The messages above say why.'
  }

  $plaid = if (Get-EnvValue 'PLAID_CLIENT_ID') { 'on (sandbox): in Plaid Link use user_good / pass_good' } else { 'off: payments are recorded as a demo bank transfer' }
  Write-Host ''
  Write-Host '  ------------------------------------------------------------------' -ForegroundColor DarkGray
  Write-Host '   Secure Tenant Portal (team build) is running' -ForegroundColor Green
  Write-Host '   http://localhost:5173' -ForegroundColor White
  Write-Host ''
  Write-Host "   Tenant:   tenant@example.com    password: $(Get-EnvValue 'SEED_TENANT_PASSWORD')"
  Write-Host "   Manager:  $(if (Get-EnvValue 'SEED_ADMIN_EMAIL') { Get-EnvValue 'SEED_ADMIN_EMAIL' } else { 'manager@example.com' })   password: $(Get-EnvValue 'SEED_ADMIN_PASSWORD')"
  Write-Host "   Repairs:  maintenance@example.com   password: $(Get-EnvValue 'SEED_ADMIN_PASSWORD')"
  Write-Host '             (every sample resident shares the tenant password)' -ForegroundColor DarkGray
  Write-Host "   Plaid:    $plaid"
  Write-Host ''
  Write-Host '   Keep this window open. Close it or press Ctrl+C to stop the app.'
  Write-Host '   Stop Demo.cmd stops everything, database included.'
  Write-Host '  ------------------------------------------------------------------' -ForegroundColor DarkGray
  if (-not $NoBrowser) { Start-Process 'http://localhost:5173' }

  $app.WaitForExit()
} catch {
  Write-Host ''
  Write-Host "  Something went wrong: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host '  If it keeps failing at the same step, Reset Demo.cmd starts the database over.' -ForegroundColor Red
  $exitCode = 1
} finally {
  if ($app -and -not $app.HasExited) { & taskkill.exe /PID $app.Id /T /F | Out-Null }
  if (Test-Path $PidPath) { Remove-Item -Force $PidPath -ErrorAction SilentlyContinue }
}
exit $exitCode
