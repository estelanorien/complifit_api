# Full fix: grant gemini@ push (Step #1) and deploy (Step #2) permissions.
# Run after gcloud is installed and you've run: gcloud auth login
# From repo folder: .\scripts\run-full-fix-cloudbuild-permissions.ps1

# Continue so gcloud.ps1 stderr (e.g. "environment tag", "Encryption: Google-managed key") does not terminate the script
$ErrorActionPreference = "Continue"
# Find gcloud in common install locations
foreach ($p in @("$env:LOCALAPPDATA\Google\Cloud SDK\google-cloud-sdk\bin", "$env:ProgramFiles\Google\Cloud SDK\google-cloud-sdk\bin")) {
    if (Test-Path "$p\gcloud.cmd") { $env:Path = "$p;$env:Path"; break }
}
$ProjectId = "bright-aloe-485517-n8"
$Loc = "europe-west1"
$Repo = "cloud-run-source-deploy"
$GeminiSa = "gemini@${ProjectId}.iam.gserviceaccount.com"
$ComputeSa = "684095677071-compute@developer.gserviceaccount.com"

Write-Host "Setting project..." -ForegroundColor Cyan
gcloud config set project $ProjectId 2>&1 | Out-Null

Write-Host "Ensuring Artifact Registry repo exists..." -ForegroundColor Cyan
$null = gcloud artifacts repositories describe $Repo --location=$Loc --project=$ProjectId 2>&1
if ($LASTEXITCODE -ne 0) {
    gcloud artifacts repositories create $Repo --repository-format=docker --location=$Loc --project=$ProjectId --description="Cloud Run source deploy" 2>&1 | Out-Null
}

Write-Host "Granting Artifact Registry Writer (push)..." -ForegroundColor Cyan
gcloud artifacts repositories add-iam-policy-binding $Repo --location=$Loc --project=$ProjectId --member="serviceAccount:$GeminiSa" --role="roles/artifactregistry.writer" 2>&1 | Out-Null
gcloud projects add-iam-policy-binding $ProjectId --member="serviceAccount:$GeminiSa" --role="roles/artifactregistry.writer" 2>&1 | Out-Null

Write-Host "Granting Cloud Run Admin + act-as Compute SA (deploy)..." -ForegroundColor Cyan
gcloud projects add-iam-policy-binding $ProjectId --member="serviceAccount:$GeminiSa" --role="roles/run.admin" 2>&1 | Out-Null
gcloud iam service-accounts add-iam-policy-binding $ComputeSa --member="serviceAccount:$GeminiSa" --role="roles/iam.serviceAccountUser" --project=$ProjectId 2>&1 | Out-Null

Write-Host ""
Write-Host "Done. Go to Cloud Build -> History, open the failed build, click Retry." -ForegroundColor Green
