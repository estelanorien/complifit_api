# ONE SCRIPT TO FIX CLOUD BUILD PERMISSIONS (Windows, not techie)
# Run from the repo folder: .\scripts\DO-FIX-CLOUDBUILD.ps1
# - If gcloud is not installed, it installs it and asks you to run this script again in a new window.
# - If gcloud is installed, it opens your browser to sign in to Google, then applies the fix.
# When it says "Done", go to Cloud Build -> History and click Retry on the failed build.

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# 0. Look for gcloud in common install locations (so it works right after install, no new window)
$gcloudPaths = @(
    "$env:LOCALAPPDATA\Google\Cloud SDK\google-cloud-sdk\bin",
    "$env:ProgramFiles\Google\Cloud SDK\google-cloud-sdk\bin"
)
foreach ($p in $gcloudPaths) {
    if (Test-Path "$p\gcloud.cmd") {
        $env:Path = "$p;$env:Path"
        break
    }
}

# 1. Check gcloud
$gcloud = Get-Command gcloud -ErrorAction SilentlyContinue
if (-not $gcloud) {
    Write-Host "gcloud not found. Installing Google Cloud SDK..." -ForegroundColor Yellow
    & "$ScriptDir\install-gcloud.ps1"
    Write-Host "Close this window, open a NEW PowerShell, cd to the repo folder, and run: .\scripts\DO-FIX-CLOUDBUILD.ps1" -ForegroundColor Cyan
    exit 1
}

# 2. Sign in (browser opens; do it once)
Write-Host "Sign in to Google (browser will open if you are not already signed in)..." -ForegroundColor Cyan
gcloud auth login

# 3. Run the permission fix
& "$ScriptDir\run-full-fix-cloudbuild-permissions.ps1"
