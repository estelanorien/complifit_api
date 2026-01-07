#!/bin/bash
# Run all migrations in order
# Usage: ./run_all_migrations.sh

cd "$(dirname "$0")"

# Get DATABASE_URL from .env
if [ ! -f .env ]; then
    echo "ERROR: .env file not found"
    echo "Please create .env file with DATABASE_URL"
    exit 1
fi

DATABASE_URL=$(grep -v '^#' .env | grep DATABASE_URL | cut -d '=' -f2- | tr -d ' ' | head -1)

if [ -z "$DATABASE_URL" ]; then
    echo "ERROR: DATABASE_URL not found in .env file"
    exit 1
fi

echo "Running all migrations..."
echo "Database: $(echo $DATABASE_URL | sed 's|.*@\(.*\)/.*|\1|')"
echo ""

# Run migrations in order
for file in migrations/*.sql; do
    if [ -f "$file" ]; then
        echo "Running: $(basename $file)..."
        psql "$DATABASE_URL" -f "$file"
        if [ $? -ne 0 ]; then
            echo "⚠️  Failed: $(basename $file)"
            echo "Continue with next migration? (y/n)"
            read -r response
            if [ "$response" != "y" ]; then
                echo "Migration stopped."
                exit 1
            fi
        else
            echo "✅ Success: $(basename $file)"
        fi
        echo ""
    fi
done

echo "✅ All migrations completed!"

