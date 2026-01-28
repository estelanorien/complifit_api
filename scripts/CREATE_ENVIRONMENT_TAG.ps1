# Creates the "environment" tag key + one value (Development) and binds it to the project.
# Use when SET_ENVIRONMENT_TAG.ps1 says the tag key doesn't exist.
# Requires: Tag Admin (or resourcemanager.tagKeys.create) on the org.
#
# Usage (from repo root):
#   .\scripts\CREATE_ENVIRONMENT_TAG.ps1
# Optional: .\scripts\CREATE_ENVIRONMENT_TAG.ps1 -ValueShortName Production
#
# If you don't have permission, an org admin must run these in Cloud Shell.

param(
  [string]$ValueShortName = "Development"
)

$ErrorActionPreference = "Stop"

$PROJECT_ID = "bright-aloe-485517-n8"
$PROJECT_NUMBER = "684095677071"
$ENV_KEY_SHORTNAME = "environment"

Write-Host "Project: $PROJECT_ID ($PROJECT_NUMBER)" -ForegroundColor Cyan
Write-Host "Creating tag key '$ENV_KEY_SHORTNAME' and value '$ValueShortName', then binding to project." -ForegroundColor Cyan

gcloud config set project $PROJECT_ID 2>$null
if ($LASTEXITCODE -ne 0) { throw "gcloud failed. Run: gcloud auth login; gcloud config set project $PROJECT_ID" }

# Get organization ID (tag keys are created under an org)
$orgId = (gcloud organizations list --format="value(name)" 2>$null | Select-Object -First 1)
if (-not $orgId) {
  Write-Host ""
  Write-Host "Could not list organizations. You may need org-level permission." -ForegroundColor Yellow
  Write-Host "Ask your GCP org admin to run in Cloud Shell:" -ForegroundColor Yellow
  Write-Host "  ORG_ID=$(gcloud organizations list --format='value(name)' | head -1)" -ForegroundColor White
  Write-Host "  gcloud resource-manager tags keys create --parent=organizations/$ORG_ID --short-name=environment --description='Environment (Production/Development/etc)'" -ForegroundColor White
  Write-Host "  TAG_KEY_ID=<output from above>" -ForegroundColor White
  Write-Host "  gcloud resource-manager tags values create --parent=`$TAG_KEY_ID --short-name=Development --description=Development" -ForegroundColor White
  Write-Host "  TAG_VALUE_ID=<output from above>" -ForegroundColor White
  Write-Host "  gcloud resource-manager tags bindings create --tag-value=`$TAG_VALUE_ID --parent=//cloudresourcemanager.googleapis.com/projects/$PROJECT_NUMBER" -ForegroundColor White
  exit 1
}

$orgId = $orgId -replace "organizations/", ""
Write-Host "Using organization ID: $orgId" -ForegroundColor Cyan

# Create tag key under org
Write-Host ""
Write-Host "1) Creating tag key 'environment' ..." -ForegroundColor Cyan
$tagKeyOut = gcloud resource-manager tags keys create --parent="organizations/$orgId" --short-name=$ENV_KEY_SHORTNAME --description="Environment (Production/Development/Staging/Test)" 2>&1
if ($LASTEXITCODE -ne 0) {
  if ($tagKeyOut -match "already exists") {
    Write-Host "Tag key already exists, continuing." -ForegroundColor Green
  } else {
    Write-Host $tagKeyOut -ForegroundColor Red
    exit 1
  }
}
$tagKeyId = (gcloud resource-manager tags keys list --filter="shortName=$ENV_KEY_SHORTNAME" --format="value(name)" 2>$null | Select-Object -First 1)

if (-not $tagKeyId) {
  Write-Host "Could not get tag key ID. Create it in Console: Tag Manager > Tag Keys > Create." -ForegroundColor Yellow
  exit 1
}

Write-Host "Tag key: $tagKeyId" -ForegroundColor Green

# Create tag value
Write-Host ""
Write-Host "2) Creating tag value '$ValueShortName' ..." -ForegroundColor Cyan
$tagValueOut = gcloud resource-manager tags values create --parent="$tagKeyId" --short-name=$ValueShortName --description=$ValueShortName 2>&1
if ($LASTEXITCODE -ne 0) {
  if ($tagValueOut -match "already exists") {
    Write-Host "Tag value already exists, continuing." -ForegroundColor Green
  } else {
    Write-Host $tagValueOut -ForegroundColor Red
    exit 1
  }
}
$tagValueId = (gcloud resource-manager tags values list --parent="$tagKeyId" --filter="shortName=$ValueShortName" --format="value(name)" 2>$null | Select-Object -First 1)

if (-not $tagValueId) {
  Write-Host "Could not get tag value ID." -ForegroundColor Yellow
  exit 1
}

Write-Host "Tag value: $tagValueId" -ForegroundColor Green

# Bind to project
Write-Host ""
Write-Host "3) Binding tag to project $PROJECT_NUMBER ..." -ForegroundColor Cyan
gcloud resource-manager tags bindings create --tag-value="$tagValueId" --parent="//cloudresourcemanager.googleapis.com/projects/$PROJECT_NUMBER" 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Host "Binding failed. You may need Tag Admin. Run manually:" -ForegroundColor Yellow
  Write-Host "  gcloud resource-manager tags bindings create --tag-value=`"$tagValueId`" --parent=//cloudresourcemanager.googleapis.com/projects/$PROJECT_NUMBER" -ForegroundColor White
  exit 1
}

Write-Host ""
Write-Host "Done. The project now has the 'environment' tag." -ForegroundColor Green
Write-Host "Re-run SET_ENVIRONMENT_TAG.ps1 or your Cloud Build fix scripts as needed." -ForegroundColor Green
