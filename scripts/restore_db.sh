#!/bin/bash
# Database Restore Script
# Usage: ./scripts/restore_db.sh <backup_file.sql.gz>

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if backup file is provided
if [ -z "$1" ]; then
    echo -e "${RED}ERROR: Backup file not specified${NC}"
    echo "Usage: $0 <backup_file.sql.gz>"
    echo ""
    echo "Available backups:"
    ls -lh ./backups/*.sql.gz 2>/dev/null || echo "No backups found"
    exit 1
fi

BACKUP_FILE="$1"

# Check if backup file exists
if [ ! -f "$BACKUP_FILE" ]; then
    echo -e "${RED}ERROR: Backup file not found: $BACKUP_FILE${NC}"
    exit 1
fi

# Load environment variables
if [ -f .env ]; then
    export $(grep -v '^#' .env | xargs)
else
    echo -e "${RED}ERROR: .env file not found${NC}"
    exit 1
fi

# Check if DATABASE_URL is set
if [ -z "$DATABASE_URL" ]; then
    echo -e "${RED}ERROR: DATABASE_URL not set in .env${NC}"
    exit 1
fi

# Confirm restore
echo -e "${YELLOW}WARNING: This will restore the database from backup${NC}"
echo "Backup file: $BACKUP_FILE"
echo "Database: $DATABASE_URL"
echo ""
read -p "Are you sure you want to continue? (yes/no): " CONFIRM

if [ "$CONFIRM" != "yes" ]; then
    echo -e "${YELLOW}Restore cancelled${NC}"
    exit 0
fi

echo -e "${YELLOW}Starting database restore...${NC}"

# Decompress backup
TEMP_FILE=$(mktemp)
echo -e "${YELLOW}Decompressing backup...${NC}"
gunzip -c "$BACKUP_FILE" > "$TEMP_FILE"

# Restore database
echo -e "${YELLOW}Restoring database...${NC}"
if psql "$DATABASE_URL" < "$TEMP_FILE"; then
    echo -e "${GREEN}✓ Database restored successfully!${NC}"
else
    echo -e "${RED}✗ Restore failed!${NC}"
    rm -f "$TEMP_FILE"
    exit 1
fi

# Cleanup
rm -f "$TEMP_FILE"

echo -e "${GREEN}✓ Restore completed successfully!${NC}"

