# Create a dedicated Cloud Build SA with Artifact Registry + Run permissions,
# then set the vitality-api trigger to use it. Run once with gcloud.
# Usage: .\scripts\fix-cloudbuild-trigger-sa.ps1
#        .\scripts\fix-cloudbuild-trigger-sa.ps1 -TriggerName "your-trigger-id"

param(
    [string]$TriggerName = ""
)

$ErrorActionPreference = "Stop"
$PROJECT_ID = "bright-aloe-485517-n8"
$REGION = "europe-west1"
$SA_NAME = "vitality-api-cb"
$SA_EMAIL = "${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
$SA_FULL = "projects/${PROJECT_ID}/serviceAccounts/${SA_EMAIL}"

Write-Host "Project: $PROJECT_ID | Region: $REGION | SA: $SA_EMAIL"

# Ensure project
gcloud config set project $PROJECT_ID 2>$null
if ($LASTEXITCODE -ne 0) { throw "gcloud config failed. Run: gcloud auth login; gcloud config set project $PROJECT_ID" }

# 1. Create SA if it doesn't exist
$exists = gcloud iam service-accounts describe $SA_EMAIL --project=$PROJECT_ID 2>$null
if (-not $exists) {
    Write-Host "Creating service account $SA_EMAIL ..."
    gcloud iam service-accounts create $SA_NAME `
      --display-name="Vitality API Cloud Build" `
      --project=$PROJECT_ID
    if ($LASTEXITCODE -ne 0) { throw "Failed to create service account" }
} else {
    Write-Host "Service account $SA_EMAIL already exists."
}

# 2. Grant project-level Artifact Registry Writer and Cloud Run Admin
Write-Host "Granting roles/artifactregistry.writer (project) ..."
gcloud projects add-iam-policy-binding $PROJECT_ID `
  --member="serviceAccount:$SA_EMAIL" `
  --role="roles/artifactregistry.writer" `
  --quiet
if ($LASTEXITCODE -ne 0) { throw "Failed to grant artifactregistry.writer" }

Write-Host "Granting roles/run.admin (project) ..."
gcloud projects add-iam-policy-binding $PROJECT_ID `
  --member="serviceAccount:$SA_EMAIL" `
  --role="roles/run.admin" `
  --quiet
if ($LASTEXITCODE -ne 0) { throw "Failed to grant run.admin" }

# 3. Find and update the trigger
if (-not $TriggerName) {
    Write-Host "Listing triggers in $REGION ..."
    $triggersJson = gcloud builds triggers list --region=$REGION --format="json(name,description)" 2>$null
    if (-not $triggersJson) { throw "Could not list triggers. Check region and project." }
    $triggers = $triggersJson | ConvertFrom-Json
    $candidate = $triggers | Where-Object { $_.name -match "vitality" -or $_.description -match "vitality" } | Select-Object -First 1
    if ($candidate) {
        $TriggerName = ($candidate.name -split "/")[-1]
        Write-Host "Using trigger: $TriggerName"
    }
}
if (-not $TriggerName) {
    Write-Host "No trigger name given and none matching 'vitality' found."
    Write-Host "Run: gcloud builds triggers list --region=$REGION"
    Write-Host "Then: .\scripts\fix-cloudbuild-trigger-sa.ps1 -TriggerName YOUR_TRIGGER_ID"
    exit 1
}

Write-Host "Updating trigger '$TriggerName' to use $SA_EMAIL ..."
gcloud builds triggers update github $TriggerName `
  --region=$REGION `
  --service-account=$SA_FULL `
  --project=$PROJECT_ID
if ($LASTEXITCODE -ne 0) {
    Write-Host "Trigger update failed. If this is not a GitHub trigger, use:"
    Write-Host "  gcloud builds triggers describe $TriggerName --region=$REGION"
    Write-Host "  gcloud builds triggers update <type> $TriggerName --region=$REGION --service-account=$SA_FULL"
    exit 1
}

Write-Host "Done. Push to main or retry the last build in Cloud Build > History."
