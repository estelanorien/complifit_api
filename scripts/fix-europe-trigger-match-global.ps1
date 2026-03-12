# Update the europe-west1 vitality-api trigger to use the same service account as the
# working global trigger. Run from repo root. Prereqs: gcloud, gcloud auth login, project set.
# Usage: .\scripts\fix-europe-trigger-match-global.ps1

$ErrorActionPreference = "Continue"
$ProjectId = "bright-aloe-485517-n8"
$EuropeRegion = "europe-west1"

Write-Host "Project: $ProjectId"
gcloud config set project $ProjectId 2>$null

# 1. Get working global trigger's service account (no --region = global)
Write-Host "Listing global triggers..."
$globalList = gcloud builds triggers list --format="json(name)" 2>$null
if (-not $globalList) {
    Write-Host "Could not list global triggers. Run: gcloud auth login; gcloud config set project $ProjectId"
    exit 1
}
$globalTriggers = $globalList | ConvertFrom-Json
$globalName = ($globalTriggers | Select-Object -First 1).name
if (-not $globalName) {
    Write-Host "No global triggers found."
    exit 1
}
$globalId = ($globalName -split "/")[-1]
Write-Host "Global trigger: $globalId"

$globalJson = gcloud builds triggers describe $globalId --format="json(serviceAccount)" 2>$null
$globalSa = $null
if ($globalJson) {
    $o = $globalJson | ConvertFrom-Json
    $globalSa = $o.serviceAccount
}
$projNum = gcloud projects describe $ProjectId --format="value(projectNumber)" 2>$null
if (-not $globalSa) {
    $globalSa = "projects/$ProjectId/serviceAccounts/${projNum}@cloudbuild.gserviceaccount.com"
    Write-Host "Global trigger uses default SA: $globalSa"
    Write-Host "Granting default Cloud Build SA (Artifact Registry + Run) so europe can push/deploy..."
    gcloud projects add-iam-policy-binding $ProjectId --member="serviceAccount:${projNum}@cloudbuild.gserviceaccount.com" --role="roles/artifactregistry.writer" --quiet 2>$null
    gcloud projects add-iam-policy-binding $ProjectId --member="serviceAccount:${projNum}@cloudbuild.gserviceaccount.com" --role="roles/run.admin" --quiet 2>$null
    gcloud iam service-accounts add-iam-policy-binding "${projNum}-compute@developer.gserviceaccount.com" --member="serviceAccount:${projNum}@cloudbuild.gserviceaccount.com" --role="roles/iam.serviceAccountUser" --project=$ProjectId --quiet 2>$null
} else {
    Write-Host "Global trigger SA: $globalSa"
}

# 2. Find europe vitality trigger
Write-Host "Listing europe-west1 triggers..."
$eurList = gcloud builds triggers list --region=$EuropeRegion --format="json(name,description)" 2>$null
if (-not $eurList) {
    Write-Host "Could not list europe triggers."
    exit 1
}
$eurTriggers = $eurList | ConvertFrom-Json
$eurCandidate = $eurTriggers | Where-Object { $_.name -match "vitality" -or $_.description -match "vitality" } | Select-Object -First 1
if (-not $eurCandidate) { $eurCandidate = $eurTriggers | Select-Object -First 1 }
if (-not $eurCandidate) {
    Write-Host "No europe-west1 trigger found."
    exit 1
}
$eurId = ($eurCandidate.name -split "/")[-1]
Write-Host "Europe trigger: $eurId"

# 3. Update europe trigger to use same SA as global
Write-Host "Updating europe trigger to use: $globalSa"
gcloud builds triggers update github $eurId --region=$EuropeRegion --service-account=$globalSa --project=$ProjectId 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "Update failed. Ensure default Cloud Build SA has Artifact Registry + Run perms:"
    Write-Host "  Run the Full fix block in CLOUDBUILD_FIX_ARTIFACT_REGISTRY.md (grants gemini@); or"
    Write-Host "  Grant PROJECT_NUMBER@cloudbuild.gserviceaccount.com: roles/artifactregistry.writer, roles/run.admin"
    exit 1
}
Write-Host "Done. Retry the europe build or push to main."
