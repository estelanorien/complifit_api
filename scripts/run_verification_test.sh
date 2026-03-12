#!/bin/bash
# Run the asset generation verification test

echo "Running Asset Generation Verification Test..."
echo ""

# Make sure we're in the right directory
cd "$(dirname "$0")/.."

# Run the test script
npx tsx scripts/test_asset_generation_verification.ts
