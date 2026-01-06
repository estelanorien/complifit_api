#!/bin/bash
# Database Backup Script
# Usage: ./scripts/backup_db.sh

set -e

# Configuration
BACKUP_DIR="./backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/vitality_db_$TIMESTAMP.sql"
RETENTION_DAYS=7

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Create backup directory if it doesn't exist
mkdir -p "$BACKUP_DIR"

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

echo -e "${YELLOW}Starting database backup...${NC}"
echo "Backup file: $BACKUP_FILE"

# Create backup
if pg_dump "$DATABASE_URL" > "$BACKUP_FILE"; then
    echo -e "${GREEN}✓ Backup created successfully${NC}"
    
    # Compress backup
    echo -e "${YELLOW}Compressing backup...${NC}"
    gzip "$BACKUP_FILE"
    
    COMPRESSED_FILE="$BACKUP_FILE.gz"
    BACKUP_SIZE=$(du -h "$COMPRESSED_FILE" | cut -f1)
    echo -e "${GREEN}✓ Backup compressed: $COMPRESSED_FILE ($BACKUP_SIZE)${NC}"
    
    # Remove old backups
    echo -e "${YELLOW}Cleaning up old backups (older than $RETENTION_DAYS days)...${NC}"
    DELETED_COUNT=$(find "$BACKUP_DIR" -name "*.sql.gz" -mtime +$RETENTION_DAYS -delete -print | wc -l)
    echo -e "${GREEN}✓ Removed $DELETED_COUNT old backup(s)${NC}"
    
    # List recent backups
    echo -e "${YELLOW}Recent backups:${NC}"
    ls -lh "$BACKUP_DIR"/*.sql.gz 2>/dev/null | tail -5 || echo "No backups found"
    
    echo -e "${GREEN}✓ Backup completed successfully!${NC}"
else
    echo -e "${RED}✗ Backup failed!${NC}"
    exit 1
fi

