# Install Google Cloud SDK (gcloud) on Windows so you can fix Cloud Build permissions.
# Run: Right-click this file -> Run with PowerShell. Or in PowerShell: .\scripts\install-gcloud.ps1
# After it finishes, CLOSE PowerShell, open it again, go to this folder, and run: .\scripts\DO-FIX-CLOUDBUILD.ps1

$ErrorActionPreference = "Stop"
Write-Host "Installing Google Cloud SDK (gcloud)..." -ForegroundColor Cyan

$winget = Get-Command winget -ErrorAction SilentlyContinue
if (-not $winget) {
    Write-Host "winget not found. Install gcloud manually: https://cloud.google.com/sdk/docs/install" -ForegroundColor Yellow
    Write-Host "Then run: .\scripts\DO-FIX-CLOUDBUILD.ps1" -ForegroundColor White
    exit 1
}

winget install -e --id Google.CloudSDK --accept-package-agreements --accept-source-agreements
if ($LASTEXITCODE -ne 0) {
    Write-Host "Install failed. Try manually: https://cloud.google.com/sdk/docs/install" -ForegroundColor Yellow
    exit 1
}

Write-Host ""
Write-Host "Installation started or completed." -ForegroundColor Green
Write-Host "IMPORTANT: Close this window, open a NEW PowerShell, go to the repo folder, then run:" -ForegroundColor Yellow
Write-Host "  .\scripts\DO-FIX-CLOUDBUILD.ps1" -ForegroundColor White
Write-Host ""
