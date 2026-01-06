#!/bin/bash
# Script to replace console.log/error/warn with proper req.log calls
# Usage: ./fix_console_logs.sh

echo "🔧 Fixing console.log statements in API routes..."

# Find all TypeScript files with console statements
FILES=$(grep -rl "console\.\(log\|error\|warn\)" src/infra/http/routes/*.ts src/application/services/*.ts 2>/dev/null)

if [ -z "$FILES" ]; then
    echo "✅ No console statements found!"
    exit 0
fi

echo "Found console statements in:"
echo "$FILES"
echo ""

# Create backup
BACKUP_DIR="./console_logs_backup_$(date +%Y%m%d_%H%M%S)"
mkdir -p "$BACKUP_DIR"

for file in $FILES; do
    echo "📝 Processing: $file"
    
    # Backup original file
    cp "$file" "$BACKUP_DIR/$(basename $file)"
    
    # Replace console.error with req.log.error
    sed -i.bak 's/console\.error(\([^)]*\))/req.log.error({ error: \1, requestId: (req as any).requestId })/g' "$file"
    
    # Replace console.warn with req.log.warn
    sed -i.bak 's/console\.warn(\([^)]*\))/req.log.warn(\1)/g' "$file"
    
    # Replace console.log with req.log.info
    sed -i.bak 's/console\.log(\([^)]*\))/req.log.info(\1)/g' "$file"
    
    # Remove .bak files
    rm -f "${file}.bak"
done

echo ""
echo "✅ Done! Backup saved to: $BACKUP_DIR"
echo ""
echo "⚠️  IMPORTANT: Review changes manually!"
echo "   Some console statements might need manual adjustment"
echo "   especially if they don't have 'req' available in scope"
echo ""
echo "To revert: cp $BACKUP_DIR/* src/infra/http/routes/"

