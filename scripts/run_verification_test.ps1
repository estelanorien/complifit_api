# PowerShell script to run the verification test
Write-Host "Running Asset Generation Verification Test..." -ForegroundColor Cyan
Write-Host ""

# Change to script directory
$scriptPath = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptPath
Set-Location $projectRoot

# Run the test
npx tsx scripts/test_asset_generation_verification.ts
