# Fetch the latest Cloud Build log to build-log.txt (so you can read it even when Console says "No logs")
# Run from repo root. Prereqs: gcloud auth login, gcloud config set project bright-aloe-485517-n8
$ErrorActionPreference = "Continue"
$ProjectId = "bright-aloe-485517-n8"
$Region = "europe-west1"
$OutFile = "build-log.txt"

Write-Host "Project: $ProjectId | Region: $Region | Output: $OutFile"
gcloud config set project $ProjectId 2>$null

# List latest build in region (vitality-api trigger runs in europe-west1)
$buildId = gcloud builds list --region=$Region --limit=1 --format="value(id)" 2>$null
if (-not $buildId) {
    Write-Host "No builds found in $Region. Try: gcloud builds list --region=$Region"
    exit 1
}
Write-Host "Latest build: $buildId"
Write-Host "Fetching log..."
gcloud builds log $buildId --region=$Region 2>&1 | Set-Content -Path $OutFile -Encoding utf8
Write-Host "Done. Log written to $OutFile"
