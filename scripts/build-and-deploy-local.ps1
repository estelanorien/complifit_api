# Build vitality-api locally, push to Artifact Registry, deploy to Cloud Run.
# Uses YOUR gcloud/Docker credentials (bypasses Cloud Build trigger permissions).
# Run from repo root. Prereqs: Docker, gcloud CLI, gcloud auth login, project set.
# Usage: .\scripts\build-and-deploy-local.ps1   OR   .\scripts\build-and-deploy-local.ps1 -Tag "mytag"

param(
    [string]$Tag = "local"
)

$ErrorActionPreference = "Stop"
$PROJECT_ID = "bright-aloe-485517-n8"
$REGION = "europe-west1"
$REPO = "cloud-run-source-deploy"
$IMAGE_NAME = "vitality-api"
$FULL_IMAGE = "europe-west1-docker.pkg.dev/$PROJECT_ID/$REPO/${IMAGE_NAME}:$Tag"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptDir
Push-Location $repoRoot
try {
    Write-Host "Project: $PROJECT_ID | Image: $FULL_IMAGE"
    gcloud config set project $PROJECT_ID 2>$null
    if ($LASTEXITCODE -ne 0) { throw "gcloud config failed. Run: gcloud auth login; gcloud config set project $PROJECT_ID" }

    Write-Host "Configuring Docker for Artifact Registry..."
    gcloud auth configure-docker europe-west1-docker.pkg.dev --quiet
    if ($LASTEXITCODE -ne 0) { throw "Docker auth failed." }

    Write-Host "Building image..."
    docker build -t $FULL_IMAGE .
    if ($LASTEXITCODE -ne 0) { throw "Docker build failed." }

    Write-Host "Pushing image..."
    docker push $FULL_IMAGE
    if ($LASTEXITCODE -ne 0) { throw "Docker push failed. Ensure your account has Artifact Registry Writer (or run as project Owner/Editor)." }

    Write-Host "Deploying to Cloud Run..."
    gcloud run deploy $IMAGE_NAME `
      --image $FULL_IMAGE `
      --region $REGION `
      --platform managed `
      --allow-unauthenticated `
      --memory 2Gi `
      --cpu 1 `
      --timeout 300s `
      --min-instances 0 `
      --max-instances 2 `
      --cpu-boost `
      --execution-environment gen2
    if ($LASTEXITCODE -ne 0) { throw "Cloud Run deploy failed. Ensure your account has Cloud Run Admin (or run as project Owner/Editor)." }

    Write-Host "Done. Service updated. Push this repo to GitHub when ready (trigger may still fail until trigger SA permissions are fixed)."
} finally {
    Pop-Location
}
