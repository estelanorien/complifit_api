# Grant vitality-api-cb: Logs Writer + act-as Compute default SA (for deploy).
# Use when the build says: "service account ... does not have permission to write logs"
# or when Step 3 (gcloud run deploy) fails.
# Usage: .\scripts\fix-vitality-api-cb-logging-and-deploy.ps1

$ErrorActionPreference = "Stop"
$PROJECT_ID = "bright-aloe-485517-n8"
$SA_EMAIL = "vitality-api-cb@${PROJECT_ID}.iam.gserviceaccount.com"
$COMPUTE_SA = "684095677071-compute@developer.gserviceaccount.com"

Write-Host "Granting vitality-api-cb ($SA_EMAIL): Logs Writer + act-as Compute SA" -ForegroundColor Cyan

gcloud config set project $PROJECT_ID 2>$null
if ($LASTEXITCODE -ne 0) { throw "gcloud failed. Run: gcloud auth login; gcloud config set project $PROJECT_ID" }

# So the build can write logs to Cloud Logging
Write-Host "Granting roles/logging.logWriter ..."
gcloud projects add-iam-policy-binding $PROJECT_ID `
  --member="serviceAccount:$SA_EMAIL" `
  --role="roles/logging.logWriter" `
  --quiet
if ($LASTEXITCODE -ne 0) { throw "Failed to grant logging.logWriter" }

# So gcloud run deploy can act as the default Compute SA
Write-Host "Granting vitality-api-cb permission to use Compute default SA (for deploy) ..."
gcloud iam service-accounts add-iam-policy-binding $COMPUTE_SA `
  --member="serviceAccount:$SA_EMAIL" `
  --role="roles/iam.serviceAccountUser" `
  --project=$PROJECT_ID `
  --quiet
if ($LASTEXITCODE -ne 0) { throw "Failed to grant iam.serviceAccountUser" }

Write-Host "Done. Retry the build in Cloud Build > History." -ForegroundColor Green
