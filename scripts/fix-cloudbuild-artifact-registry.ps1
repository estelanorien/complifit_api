# Fix Cloud Build "Permission artifactregistry.repositories.uploadArtifacts denied"
# Run from repo root or scripts/ after: gcloud auth login, gcloud config set project PROJECT_ID
# Usage: .\scripts\fix-cloudbuild-artifact-registry.ps1
# Or from Cloud Shell (bash): see CLOUDBUILD_FIX_ARTIFACT_REGISTRY.md

$ErrorActionPreference = "Stop"
$PROJECT_ID = "bright-aloe-485517-n8"
$PROJECT_NUMBER = (gcloud projects describe $PROJECT_ID --format="value(projectNumber)" 2>$null)
if (-not $PROJECT_NUMBER) {
    Write-Error "Could not get project number. Run: gcloud auth login; gcloud config set project $PROJECT_ID"
    exit 1
}
Write-Host "Project: $PROJECT_ID, Number: $PROJECT_NUMBER"
Write-Host "Granting roles/artifactregistry.writer to ${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com on cloud-run-source-deploy..."
gcloud artifacts repositories add-iam-policy-binding cloud-run-source-deploy `
  --location=europe-west1 `
  --project=$PROJECT_ID `
  --member="serviceAccount:${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com" `
  --role="roles/artifactregistry.writer"
if ($LASTEXITCODE -ne 0) {
    Write-Host "Repository-scoped binding failed. Trying project-level..."
    gcloud projects add-iam-policy-binding $PROJECT_ID `
      --member="serviceAccount:${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com" `
      --role="roles/artifactregistry.writer"
}
if ($LASTEXITCODE -eq 0) {
    Write-Host "Done. Retry the failed vitality-api build in Cloud Build > History."
} else {
    exit 1
}
