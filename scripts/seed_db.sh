#!/bin/bash
# Database Seeding Script
# Usage: ./scripts/seed_db.sh

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

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

echo -e "${YELLOW}Starting database seeding...${NC}"

# Seed admin users
echo -e "${YELLOW}Creating admin users...${NC}"
psql "$DATABASE_URL" << EOF
-- Insert admin users (if not exists)
INSERT INTO users (email, password_hash, username, role)
VALUES 
  ('mehmetcandiri@gmail.com', '\$2a\$10\$dummyhash', 'admin1', 'admin'),
  ('rmkocatas@gmail.com', '\$2a\$10\$dummyhash', 'admin2', 'admin')
ON CONFLICT (email) DO UPDATE SET role = 'admin';

-- Update existing admin users
UPDATE users 
SET role = 'admin' 
WHERE email IN ('mehmetcandiri@gmail.com', 'rmkocatas@gmail.com')
  AND role != 'admin';
EOF

echo -e "${GREEN}✓ Admin users created/updated${NC}"

# Seed lookup tables (already in migrations, but can refresh here)
echo -e "${YELLOW}Verifying lookup tables...${NC}"
psql "$DATABASE_URL" << EOF
-- Verify sports table
SELECT COUNT(*) as sports_count FROM sports;

-- Verify cuisines table
SELECT COUNT(*) as cuisines_count FROM cuisines;

-- Verify training goals
SELECT COUNT(*) as training_goals_count FROM training_goal_categories;

-- Verify nutrition goals
SELECT COUNT(*) as nutrition_goals_count FROM nutrition_goal_categories;
EOF

echo -e "${GREEN}✓ Lookup tables verified${NC}"

# Optional: Seed sample data for development
if [ "$NODE_ENV" != "production" ]; then
    echo -e "${YELLOW}Seeding sample development data...${NC}"
    
    psql "$DATABASE_URL" << EOF
-- Insert sample test user (development only)
INSERT INTO users (email, password_hash, username, role)
VALUES ('test@vitality.com', '\$2a\$10\$dummyhash', 'testuser', 'user')
ON CONFLICT (email) DO NOTHING;

-- You can add more sample data here for development
EOF
    
    echo -e "${GREEN}✓ Sample data seeded${NC}"
fi

echo -e "${GREEN}✓ Database seeding completed successfully!${NC}"

