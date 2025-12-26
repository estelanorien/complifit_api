#!/bin/bash
# Migration script for biometric columns
# Usage: ./run_migration.sh

cd "$(dirname "$0")"

# Get DATABASE_URL from .env
if [ -f .env ]; then
    DATABASE_URL=$(grep -v '^#' .env | grep DATABASE_URL | cut -d '=' -f2- | tr -d ' ' | head -1 | sed 's|postgresql+asyncpg://|postgresql://|')
    
    if [ -z "$DATABASE_URL" ]; then
        echo "ERROR: DATABASE_URL not found in .env file"
        exit 1
    fi
    
    echo "Running migration 018_add_biometric_columns.sql..."
    echo "Database: $(echo $DATABASE_URL | sed 's|.*@\(.*\)/.*|\1|')"
    echo ""
    
    psql "$DATABASE_URL" -f migrations/018_add_biometric_columns.sql
    
    if [ $? -eq 0 ]; then
        echo ""
        echo "✅ Migration completed successfully!"
    else
        echo ""
        echo "⚠️  Migration failed. The API will still work with fallback mode."
        echo "   You may need database owner permissions to run this migration."
    fi
else
    echo "ERROR: .env file not found"
    exit 1
fi

