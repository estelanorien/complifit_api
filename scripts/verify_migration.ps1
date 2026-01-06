# Verification Script
# Checks row counts in Source and Destination

$SourceHost = "89.19.19.242"
$SourceUser = "appuser"
$SourceDB = "rehafitnessdb"
$SourcePort = "5432"

$DestHost = "104.199.2.9"
$DestUser = "postgres"
$DestDB = "vitality_db"
$DestPort = "5432"

$env:PGPASSWORD = "6fk23az4_F"

# Function to get table counts
function Get-TableCounts ($HostName, $Port, $User, $DBName) {
    $Query = "SELECT schemaname, relname, n_live_tup FROM pg_stat_user_tables ORDER BY n_live_tup DESC;"
    # We use -A -t to get unaligned tuples only
    return psql -h $HostName -p $Port -U $User -d $DBName -A -t -c $Query
}

Write-Host "Fetching Source Counts ($SourceHost)..." -ForegroundColor Cyan
$SourceCounts = Get-TableCounts $SourceHost $SourcePort $SourceUser $SourceDB

Write-Host "Fetching Destination Counts ($DestHost)..." -ForegroundColor Cyan
$DestCounts = Get-TableCounts $DestHost $DestPort $DestUser $DestDB

Write-Host "`n--- Comparison ---" -ForegroundColor Yellow
Write-Host "Source (First 10 tables):"
$SourceCounts | Select-Object -First 10

Write-Host "`nDestination (First 10 tables):"
$DestCounts | Select-Object -First 10

if ($null -eq $SourceCounts -or $SourceCounts.Count -eq 0) {
    Write-Host "Error fetching source counts." -ForegroundColor Red
} elseif ($null -eq $DestCounts -or $DestCounts.Count -eq 0) {
    Write-Host "Error fetching destination counts (or DB is empty)." -ForegroundColor Red
} else {
    Write-Host "`nCheck if the numbers match above!" -ForegroundColor Green
}
