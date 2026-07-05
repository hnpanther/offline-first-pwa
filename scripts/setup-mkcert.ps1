# Generate trusted HTTPS certs for mobile PWA dev (mkcert)
# Run in PowerShell from offline-first-pwa folder:
#   .\scripts\setup-mkcert.ps1
#   .\scripts\setup-mkcert.ps1 -Ip 192.168.1.101

param(
    [string]$Ip = ""
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command mkcert -ErrorAction SilentlyContinue)) {
    Write-Host ""
    Write-Host "mkcert is not installed." -ForegroundColor Red
    Write-Host ""
    Write-Host "Install one of:" -ForegroundColor Yellow
    Write-Host "  choco install mkcert"
    Write-Host "  scoop install mkcert"
    Write-Host "  winget install FiloSottile.mkcert"
    Write-Host ""
    Write-Host "Or download from: https://github.com/FiloSottile/mkcert/releases"
    exit 1
}

if (-not $Ip) {
    $Ip = (
        Get-NetIPAddress -AddressFamily IPv4 |
        Where-Object {
            $_.IPAddress -notlike "127.*" -and
            $_.PrefixOrigin -ne "WellKnown"
        } |
        Select-Object -First 1 -ExpandProperty IPAddress
    )
}

if (-not $Ip) {
    Write-Host "Could not detect LAN IP. Pass it explicitly:" -ForegroundColor Red
    Write-Host "  .\scripts\setup-mkcert.ps1 -Ip 192.168.1.101"
    exit 1
}

$root = Split-Path $PSScriptRoot -Parent
$certDir = Join-Path $root "certs"
New-Item -ItemType Directory -Force -Path $certDir | Out-Null

Write-Host "Installing local CA on this PC (may ask for admin)..." -ForegroundColor Cyan
mkcert -install

$certFile = Join-Path $certDir "cert.pem"
$keyFile = Join-Path $certDir "key.pem"

Write-Host "Creating cert for: $Ip localhost 127.0.0.1" -ForegroundColor Cyan
mkcert -cert-file $certFile -key-file $keyFile $Ip localhost 127.0.0.1

$caRoot = mkcert -CAROOT
$caFile = Join-Path $caRoot "rootCA.pem"
$caCopy = Join-Path $certDir "rootCA.pem"
Copy-Item -Force $caFile $caCopy

# Android often needs .crt extension to install CA
$caCrt = Join-Path $certDir "rootCA.crt"
Copy-Item -Force $caFile $caCrt

Write-Host ""
Write-Host "Done." -ForegroundColor Green
Write-Host "Server cert: $certFile"
Write-Host "Server key:  $keyFile"
Write-Host "CA for phone: $caCopy"
Write-Host "CA (crt):    $caCrt  (send this to phone)"
Write-Host ""

Write-Host "=== ON PC (offline PWA - use this, NOT dev server) ===" -ForegroundColor Yellow
Write-Host "  npm run build:mobile"
Write-Host "  npm run preview:mobile"
Write-Host "  Open on phone: https://${Ip}:4173"

Write-Host ""

Write-Host "=== DEV MODE (hot reload, not reliable for offline PWA) ===" -ForegroundColor DarkYellow
Write-Host "  npm run dev:mobile -> https://${Ip}:5173"

Write-Host ""

Write-Host "=== ANDROID STEPS ===" -ForegroundColor Yellow
Write-Host "  1) Copy certs/rootCA.crt to phone"
Write-Host "  2) Settings -> Security -> Encryption and credentials"
Write-Host "  3) Install a certificate -> CA certificate"
Write-Host "  4) Select rootCA.crt and confirm"
Write-Host "  5) Restart Chrome"
Write-Host "  6) Open https://${Ip}:5173 or :4173"