# Database Migration Script
# Source: 89.19.19.242 (rehafitnessdb)
# Destination: 104.199.2.9 (vitality_db)

$SourceHost = "89.19.19.242"
$SourceUser = "appuser"
$SourceDB = "rehafitnessdb"
$SourcePort = "5432"

$DestHost = "104.199.2.9"
$DestUser = "postgres"
$DestDB = "vitality_db"
$DestPort = "5432"

# Password prompt or set env var
$env:PGPASSWORD = "6fk23az4_F"

# Check for tools
if (!(Get-Command pg_dump -ErrorAction SilentlyContinue)) {
    Write-Host "Error: pg_dump not found in PATH." -ForegroundColor Red
    Write-Host "Please add PostgreSQL bin directory to your PATH or edit this script."
    # Attempt to guess common paths
    $PossiblePaths = @(
        "C:\Program Files\PostgreSQL\18\bin",
        "C:\Program Files\PostgreSQL\17\bin",
        "C:\Program Files\PostgreSQL\16\bin",
        "C:\Program Files\PostgreSQL\15\bin",
        "C:\Program Files\PostgreSQL\14\bin"
    )
    foreach ($path in $PossiblePaths) {
        if (Test-Path $path) {
            Write-Host "Found PostgreSQL at $path. Adding to PATH temporarily." -ForegroundColor Green
            $env:Path += ";$path"
            break
        }
    }
}

if (!(Get-Command pg_dump -ErrorAction SilentlyContinue)) {
    Write-Host "Could not find pg_dump. Exiting." -ForegroundColor Red
    exit 1
}

$BackupFile = "backup_rehafitnessdb_$(Get-Date -Format 'yyyyMMdd_HHmmss').sql"

Write-Host "Starting Backup from $SourceHost... (using INSERT mode)" -ForegroundColor Cyan
# --inserts: Use INSERT commands instead of COPY (slower but safer for complex data)
# --clean --if-exists: Drop tables before creating them to ensure clean state
# --no-owner --no-acl: Skip ownership/privilege commands for portability
pg_dump -h $SourceHost -p $SourcePort -U $SourceUser --no-owner --no-acl --clean --if-exists --inserts -f $BackupFile $SourceDB

if ($LASTEXITCODE -eq 0) {
    Write-Host "Backup successful: $BackupFile" -ForegroundColor Green
} else {
    Write-Host "Backup failed!" -ForegroundColor Red
    exit 1
}

Write-Host "Resetting target database (cleaning old tables)..." -ForegroundColor Cyan
psql -h $DestHost -p $DestPort -U $DestUser -d $DestDB -f "$PSScriptRoot\reset_db.sql"

Write-Host "Starting Restore to $DestHost..." -ForegroundColor Cyan
# psql is used for restoring plain text sql dumps
psql -h $DestHost -p $DestPort -U $DestUser -d $DestDB -f $BackupFile

if ($LASTEXITCODE -eq 0) {
    Write-Host "Migration completed successfully!" -ForegroundColor Green
} else {
    Write-Host "Restore failed!" -ForegroundColor Red
    exit 1
}
