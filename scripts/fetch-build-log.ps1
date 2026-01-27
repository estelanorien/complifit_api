# Fetch the latest EUROPE (europe-west1) Cloud Build log to build-log.txt
# Run from anywhere; output goes to vitality_api repo root (parent of scripts/).
# Prereqs: gcloud auth login, gcloud config set project bright-aloe-485517-n8
$ErrorActionPreference = "Continue"
$ProjectId = "bright-aloe-485517-n8"
$Region = "europe-west1"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptDir
$OutFile = Join-Path $RepoRoot "build-log.txt"

Write-Host "Project: $ProjectId | Region: $Region (europe trigger)"
Write-Host "Output: $OutFile"
gcloud config set project $ProjectId 2>$null

$buildId = gcloud builds list --region=$Region --limit=1 --format="value(id)" 2>$null
if (-not $buildId) {
    Write-Host "No builds in $Region. Run: gcloud builds list --region=$Region"
    exit 1
}
Write-Host "Latest europe build: $buildId"
Write-Host "Fetching log..."
$logOutput = gcloud builds log $buildId --region=$Region 2>&1
$logOutput | Set-Content -Path $OutFile -Encoding utf8
if ($LASTEXITCODE -ne 0) {
    Write-Host "gcloud builds log failed. If you see permission/403, run first:"
    Write-Host "  gcloud projects add-iam-policy-binding $ProjectId --member=`"user:YOUR_EMAIL`" --role=roles/logging.viewer"
    Write-Host "Then run this script again."
    exit 1
}
Write-Host "Done. Open: $OutFile"
