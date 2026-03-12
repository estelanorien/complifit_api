# Sets the required "environment" tag on the GCP project, to satisfy org policy.
# This is required before other gcloud/IAM scripts will work.
#
# Usage:
#   cd "c:\Users\rmkoc\Downloads\vitapp2\vitality_api-main\vitality_api-main"
#   .\scripts\SET_ENVIRONMENT_TAG.ps1
#
# If you don't have permission to bind tags, the script will print the exact command
# to send to a project/org admin to run once.

$ErrorActionPreference = "Continue"

$PROJECT_ID = "bright-aloe-485517-n8"
$PROJECT_NUMBER = "684095677071"
$ENV_KEY_SHORTNAME = "environment"

Write-Host "Project: $PROJECT_ID ($PROJECT_NUMBER)" -ForegroundColor Cyan
Write-Host "Finding TagKey shortName='$ENV_KEY_SHORTNAME' ..." -ForegroundColor Cyan

gcloud config set project $PROJECT_ID 2>$null | Out-Null

$tagKeyId = (gcloud resource-manager tags keys list --filter="shortName=$ENV_KEY_SHORTNAME" --format="value(name)" 2>$null | Select-Object -First 1)
if (-not $tagKeyId) {
  Write-Host ""
  Write-Host "Couldn't find a TagKey with shortName '$ENV_KEY_SHORTNAME'." -ForegroundColor Yellow
  Write-Host ""
  Write-Host "Existing tag keys in your org:" -ForegroundColor Cyan
  gcloud resource-manager tags keys list --format="table(name,shortName)" 2>$null | ForEach-Object { Write-Host $_ }
  Write-Host ""
  Write-Host "Your org policy requires a tag with key 'environment'. That key doesn't exist yet." -ForegroundColor Yellow
  Write-Host "Run the script that creates the key, one value, and binds it to this project:" -ForegroundColor Yellow
  Write-Host "  .\scripts\CREATE_ENVIRONMENT_TAG.ps1" -ForegroundColor White
  Write-Host ""
  Write-Host "If you don't have permission, send CREATE_ENVIRONMENT_TAG.ps1 (or its instructions) to your GCP org admin." -ForegroundColor Yellow
  exit 1
}

Write-Host "TagKey: $tagKeyId" -ForegroundColor Green
Write-Host ""
Write-Host "Available values under ${tagKeyId}:" -ForegroundColor Cyan

$values = gcloud resource-manager tags values list --parent="$tagKeyId" --format="table(name,shortName)" 2>$null
$values | ForEach-Object { Write-Host $_ }

Write-Host ""
$choice = Read-Host "Type the environment value shortName to use (e.g. Production, Development, Staging, Test)"
if (-not $choice) { throw "No value entered." }

$tagValueId = (gcloud resource-manager tags values list --parent="$tagKeyId" --filter="shortName=$choice" --format="value(name)" 2>$null | Select-Object -First 1)
if (-not $tagValueId) {
  Write-Host ""
  Write-Host "Couldn't find a TagValue with shortName '$choice' under ${tagKeyId}." -ForegroundColor Yellow
  Write-Host "Re-run and pick one that exists in the table above." -ForegroundColor Yellow
  exit 1
}

Write-Host ""
Write-Host "Binding tag value $tagValueId to project $PROJECT_NUMBER ..." -ForegroundColor Cyan

$bindOut = gcloud resource-manager tags bindings create --tag-value="$tagValueId" --parent="//cloudresourcemanager.googleapis.com/projects/$PROJECT_NUMBER" 2>&1
$exit = $LASTEXITCODE

if ($exit -eq 0) {
  Write-Host "Done. The environment tag is now set." -ForegroundColor Green
  Write-Host "Re-run your previous script (fix-trigger-and-perms-to-compute-sa.ps1) after this." -ForegroundColor Green
  exit 0
}

Write-Host ""
Write-Host "I couldn't create the binding (likely permissions). Output:" -ForegroundColor Yellow
$bindOut | ForEach-Object { Write-Host $_ }

Write-Host ""
Write-Host "Send this exact command to a Project/Org admin to run once:" -ForegroundColor Yellow
Write-Host "  gcloud resource-manager tags bindings create --tag-value=""$tagValueId"" --parent=""//cloudresourcemanager.googleapis.com/projects/$PROJECT_NUMBER""" -ForegroundColor Yellow

