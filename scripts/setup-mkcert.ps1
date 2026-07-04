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

Write-Host ""
Write-Host "Done." -ForegroundColor Green
Write-Host "  Cert: $certFile"
Write-Host "  Key:  $keyFile"
Write-Host "  CA (copy to phone): $caFile"
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "  1) Copy rootCA.pem to your phone and install/trust it (see README or chat guide)"
Write-Host "  2) npm run dev:mobile"
Write-Host "  3) On phone open: https://${Ip}:5173"
Write-Host ""
