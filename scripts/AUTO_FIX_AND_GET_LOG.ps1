# One-command helper: fix the build SA + fetch the latest europe build log.
# Usage (from repo root): .\scripts\AUTO_FIX_AND_GET_LOG.ps1
#
# What it does:
# - Ensures gcloud project is set
# - Grants vitality-api-cb Logs Writer (so Cloud Build can write logs)
# - Grants vitality-api-cb permission to act-as Compute default SA (so Step 3 deploy can run)
# - Fetches the latest europe-west1 Cloud Build log into build-log.txt in the repo root
#
# Notes:
# - You must be logged in: gcloud auth login
# - You must have permission to change IAM (Owner/Editor or equivalent)

$ErrorActionPreference = "Continue"

$ProjectId = "bright-aloe-485517-n8"
$Region = "europe-west1"
$BuildSaEmail = "vitality-api-cb@${ProjectId}.iam.gserviceaccount.com"
$ComputeSa = "684095677071-compute@developer.gserviceaccount.com"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptDir
$OutFile = Join-Path $RepoRoot "build-log.txt"

# --- debug evidence (writes NDJSON to Cursor debug log) ---
$DebugLogPath = "c:\Users\rmkoc\Downloads\vitapp2\.cursor\debug.log"
$RunId = "auto-fix-" + (Get-Date).ToString("yyyyMMdd-HHmmss")
function Write-DebugLog([string]$HypothesisId, [string]$Location, [string]$Message, $Data) {
  try {
    $obj = [ordered]@{
      sessionId   = "debug-session"
      runId       = $RunId
      hypothesisId= $HypothesisId
      location    = $Location
      message     = $Message
      data        = $Data
      timestamp   = [int64]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
    }
    ($obj | ConvertTo-Json -Compress) + "`n" | Add-Content -Path $DebugLogPath -Encoding utf8
  } catch { }
}

Write-Host "Project: $ProjectId | Region: $Region" -ForegroundColor Cyan
Write-Host "Build SA: $BuildSaEmail" -ForegroundColor Cyan
Write-Host "Output log file: $OutFile" -ForegroundColor Cyan
Write-DebugLog "H0" "AUTO_FIX_AND_GET_LOG.ps1:meta" "Start" @{ projectId=$ProjectId; region=$Region; buildSa=$BuildSaEmail; outFile=$OutFile }

Write-Host ""
Write-Host "1) Setting gcloud project..." -ForegroundColor Cyan
gcloud config set project $ProjectId 2>$null
Write-DebugLog "H1" "AUTO_FIX_AND_GET_LOG.ps1:gcloud-config" "gcloud config set project exit" @{ exitCode=$LASTEXITCODE }
if ($LASTEXITCODE -ne 0) {
  Write-Host "gcloud failed. Run: gcloud auth login" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "2) Fixing Cloud Build SA permissions (logging + deploy)..." -ForegroundColor Cyan

# Allow Cloud Build to write logs
$grantLogWriter = gcloud projects add-iam-policy-binding $ProjectId --member="serviceAccount:$BuildSaEmail" --role="roles/logging.logWriter" --quiet 2>&1
Write-DebugLog "H2" "AUTO_FIX_AND_GET_LOG.ps1:grant-logWriter" "grant logWriter exit" @{ exitCode=$LASTEXITCODE; outputLen=($grantLogWriter | Out-String).Length }

# If your trigger is using the Compute default SA, it also needs Logs Writer.
$grantComputeLogWriter = gcloud projects add-iam-policy-binding $ProjectId --member="serviceAccount:$ComputeSa" --role="roles/logging.logWriter" --quiet 2>&1
Write-DebugLog "H2" "AUTO_FIX_AND_GET_LOG.ps1:grant-compute-logWriter" "grant compute logWriter exit" @{ exitCode=$LASTEXITCODE; outputLen=($grantComputeLogWriter | Out-String).Length }

# Allow Cloud Build to act as compute default SA for deploy
$grantActAs = gcloud iam service-accounts add-iam-policy-binding $ComputeSa --member="serviceAccount:$BuildSaEmail" --role="roles/iam.serviceAccountUser" --project=$ProjectId --quiet 2>&1
Write-DebugLog "H2" "AUTO_FIX_AND_GET_LOG.ps1:grant-actAs" "grant actAs exit" @{ exitCode=$LASTEXITCODE; outputLen=($grantActAs | Out-String).Length }

Write-Host ""
Write-Host "3) Fetching latest europe build log..." -ForegroundColor Cyan
$buildId = gcloud builds list --region=$Region --limit=1 --format="value(id)" 2>$null
Write-DebugLog "H3" "AUTO_FIX_AND_GET_LOG.ps1:builds-list" "latest build id" @{ buildId=$buildId }
if (-not $buildId) {
  Write-Host "No builds found in $Region. Try: gcloud builds list --region=$Region" -ForegroundColor Yellow
  exit 1
}

Write-Host "Latest europe build: $buildId" -ForegroundColor Cyan

# Detect the actual service account used by THIS build and ensure it can write logs.
# (Sometimes the trigger UI shows one SA but the build runs as another.)
$buildSaFull = gcloud builds describe $buildId --region=$Region --format="value(serviceAccount)" 2>$null
$buildSaEmail = ""
if ($buildSaFull -and ($buildSaFull -match "serviceAccounts/(.+)$")) { $buildSaEmail = $Matches[1] }
Write-DebugLog "H3" "AUTO_FIX_AND_GET_LOG.ps1:detect-build-sa" "detected build serviceAccount" @{ serviceAccount=$buildSaFull; email=$buildSaEmail }
if ($buildSaEmail) {
  $grantBuildSaLogWriter = gcloud projects add-iam-policy-binding $ProjectId --member="serviceAccount:$buildSaEmail" --role="roles/logging.logWriter" --quiet 2>&1
  Write-DebugLog "H2" "AUTO_FIX_AND_GET_LOG.ps1:grant-detected-logWriter" "grant detected build SA logWriter exit" @{ exitCode=$LASTEXITCODE; buildSa=$buildSaEmail; outputLen=($grantBuildSaLogWriter | Out-String).Length }
}

$logOutput = gcloud builds log $buildId --region=$Region 2>&1
$logExit = $LASTEXITCODE
Write-DebugLog "H4" "AUTO_FIX_AND_GET_LOG.ps1:builds-log" "gcloud builds log exit" @{ exitCode=$logExit; outputLen=($logOutput | Out-String).Length }

# Always write an "online report" header, even if logs are empty/forbidden
$report = @()
$report += "AUTO_FIX_AND_GET_LOG report"
$report += "Project: $ProjectId"
$report += "Region:  $Region"
$report += "BuildId:  $buildId"
$report += "Time:    " + (Get-Date).ToString("s")
$report += ""
$report += "Build describe (status/serviceAccount/logUrl):"
$describe = gcloud builds describe $buildId --region=$Region --format="yaml(status,serviceAccount,logUrl,createTime,finishTime)" 2>&1
$describeExit = $LASTEXITCODE
Write-DebugLog "H4" "AUTO_FIX_AND_GET_LOG.ps1:builds-describe" "gcloud builds describe exit" @{ exitCode=$describeExit; outputLen=($describe | Out-String).Length }
$report += ($describe | Out-String).TrimEnd()
$report += ""
$report += "REMOTE BUILD OUTPUT (gcloud builds log):"
$report += "exitCode: $logExit"
$report += "--------------------------------------------------------------------------------"
$report += ($logOutput | Out-String).TrimEnd()
$report += ""
$report -join "`r`n" | Set-Content -Path $OutFile -Encoding utf8

Write-Host ""
Write-Host "Done." -ForegroundColor Green
Write-Host "Open this file to see the build failure reason:" -ForegroundColor Green
Write-Host "  $OutFile" -ForegroundColor Green
Write-DebugLog "H0" "AUTO_FIX_AND_GET_LOG.ps1:done" "Wrote report" @{ outFile=$OutFile }

