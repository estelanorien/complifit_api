# Force the vitality trigger to use the Compute default service account
# and grant it the minimum roles needed for Cloud Build logs + deploy.
#
# Usage (from repo root):
#   .\scripts\fix-trigger-and-perms-to-compute-sa.ps1
#
# Notes:
# - You must be logged in: gcloud auth login
# - You must have IAM permission to modify policy bindings and triggers

param(
  [string]$TriggerName = ""
)

$ErrorActionPreference = "Stop"

$PROJECT_ID = "bright-aloe-485517-n8"
$REGION = "europe-west1"
$COMPUTE_SA_EMAIL = "684095677071-compute@developer.gserviceaccount.com"
$COMPUTE_SA_FULL = "projects/${PROJECT_ID}/serviceAccounts/${COMPUTE_SA_EMAIL}"

Write-Host "Project: $PROJECT_ID | Region: $REGION" -ForegroundColor Cyan
Write-Host "Target build SA (compute default): $COMPUTE_SA_EMAIL" -ForegroundColor Cyan

gcloud config set project $PROJECT_ID 2>$null
if ($LASTEXITCODE -ne 0) { throw "gcloud failed. Run: gcloud auth login; gcloud config set project $PROJECT_ID" }

Write-Host ""
Write-Host "1) Granting IAM roles to Compute default SA..." -ForegroundColor Cyan

# So Cloud Build can write logs
gcloud projects add-iam-policy-binding $PROJECT_ID `
  --member="serviceAccount:$COMPUTE_SA_EMAIL" `
  --role="roles/logging.logWriter" `
  --quiet

# So it can push images
gcloud projects add-iam-policy-binding $PROJECT_ID `
  --member="serviceAccount:$COMPUTE_SA_EMAIL" `
  --role="roles/artifactregistry.writer" `
  --quiet

# So it can deploy to Cloud Run
gcloud projects add-iam-policy-binding $PROJECT_ID `
  --member="serviceAccount:$COMPUTE_SA_EMAIL" `
  --role="roles/run.admin" `
  --quiet

# Some deploys require explicit "act as" on the runtime service account.
# (Safe even if redundant.)
gcloud iam service-accounts add-iam-policy-binding $COMPUTE_SA_EMAIL `
  --member="serviceAccount:$COMPUTE_SA_EMAIL" `
  --role="roles/iam.serviceAccountUser" `
  --project=$PROJECT_ID `
  --quiet 2>$null

Write-Host ""
Write-Host "2) Updating the vitality trigger to use Compute default SA..." -ForegroundColor Cyan

if (-not $TriggerName) {
  $triggersJson = gcloud builds triggers list --region=$REGION --format="json(name,description)" 2>$null
  if (-not $triggersJson) { throw "Could not list triggers. Check region/project." }
  $triggers = $triggersJson | ConvertFrom-Json
  $candidate = $triggers | Where-Object { $_.name -match "vitality" -or $_.description -match "vitality" } | Select-Object -First 1
  if ($candidate) {
    $TriggerName = ($candidate.name -split "/")[-1]
    Write-Host "Using trigger: $TriggerName" -ForegroundColor Cyan
  }
}

if (-not $TriggerName) {
  Write-Host "No trigger name provided and none matching 'vitality' found in $REGION." -ForegroundColor Yellow
  Write-Host "Run: gcloud builds triggers list --region=$REGION" -ForegroundColor Yellow
  Write-Host "Then re-run with: -TriggerName YOUR_TRIGGER_ID" -ForegroundColor Yellow
  exit 1
}

gcloud builds triggers update github $TriggerName `
  --region=$REGION `
  --service-account=$COMPUTE_SA_FULL `
  --project=$PROJECT_ID

Write-Host ""
Write-Host "Done. Retry the build in Cloud Build > History (or push a new commit)." -ForegroundColor Green

