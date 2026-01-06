# Apply All Migrations Script
# Reads DATABASE_URL from .env and applies all .sql files in migrations/ folder

$EnvFile = "$PSScriptRoot\..\.env"
if (Test-Path $EnvFile) {
    Get-Content $EnvFile | ForEach-Object {
        if ($_ -match '^\s*([^#=]+)\s*=\s*(.*)$') {
            $name = $matches[1].Trim()
            $value = $matches[2].Trim().Trim('"').Trim("'")
            Set-Item -Path "env:$name" -Value $value
        }
    }
}

if (-not $env:DATABASE_URL) {
    Write-Host "Error: DATABASE_URL not found in .env" -ForegroundColor Red
    exit 1
}


$MigrationDir = "$PSScriptRoot\..\migrations"
# 1. Main migrations folder
$Files1 = Get-ChildItem -Path $MigrationDir -Filter "*.sql" -File | Sort-Object Name
# 2. migrations2 folder (explicitly requested)
$Files2 = Get-ChildItem -Path "$MigrationDir\migrations2" -Filter "*.sql" -File -ErrorAction SilentlyContinue | Sort-Object Name

# Combine arrays (Files1 then Files2)
$Files = @($Files1) + @($Files2)

Write-Host "Found $($Files.Count) migration files in total." -ForegroundColor Cyan
Write-Host " - Main migrations: $($Files1.Count)" -ForegroundColor Gray
Write-Host " - migrations2:     $($Files2.Count)" -ForegroundColor Gray

Write-Host "Target DB: $env:DATABASE_URL" -ForegroundColor Gray

foreach ($File in $Files) {
    Write-Host "Applying $($File.Name)..." -ForegroundColor Yellow
    
    # Run psql
    # -v ON_ERROR_STOP=1 stops script on error (optional, maybe we want to continue if safe?)
    # Since files have IF NOT EXISTS, errors should be rare unless syntax error.
    
    $Output = psql "$env:DATABASE_URL" -f $File.FullName 2>&1
    
    if ($LASTEXITCODE -eq 0) {
        Write-Host "Success." -ForegroundColor Green
    } else {
        Write-Host "Error executing $($File.Name):" -ForegroundColor Red
        Write-Host $Output
        # We don't exit here because user asked to run ALL files.
        # But we warn loudly.
    }
}

Write-Host "`nMigration process completed." -ForegroundColor Green
