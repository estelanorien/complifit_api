# Database Migration: Custom Program Feature

## Migration File
`035_add_custom_program_support.sql`

## What This Adds
This migration adds database support for the Custom Program Upload feature by creating indexes to optimize:
- Usage tracking queries (monthly parse limits)
- Subscription tier checks (Pro vs Free)

## Schema Changes
**No new tables or columns** - We're using the existing `profile_data` JSONB column in `user_profiles`.

### Indexes Added
1. **idx_profile_usage_stats**: GIN index on `profile_data.usageStats`
   - Speeds up queries for monthly usage tracking
   
2. **idx_profile_subscription_tier**: B-tree index on `profile_data.subscriptionTier`
   - Optimizes subscription tier checks

## Data Structure in profile_data

```json
{
  "subscriptionTier": "free" | "pro",
  "usageStats": {
    "customProgram_2026-01": 2,  // 2 parses used in January 2026
    "customProgram_2026-02": 0   // 0 parses used in February 2026
  }
}
```

## How to Apply

### Local Database (Development)
```bash
cd vitality_api-main
psql -d complifit_db -f migrations/035_add_custom_program_support.sql
```

### Online Database (Production via pgAdmin)
1. Connect to your PostgreSQL database via pgAdmin or psql
2. Open Query Tool
3. Copy and paste the contents of `035_add_custom_program_support.sql`
4. Execute the query
5. Verify indexes were created:
   ```sql
   SELECT indexname, indexdef 
   FROM pg_indexes 
   WHERE tablename = 'user_profiles' 
   AND indexname LIKE 'idx_profile_%';
   ```

## Rollback (if needed)
```sql
DROP INDEX IF EXISTS idx_profile_usage_stats;
DROP INDEX IF EXISTS idx_profile_subscription_tier;
```

## Backend Changes Summary
- New service: `CustomProgramService.ts` (OCR, parsing, validation, coaching)
- New routes: `customPrograms.ts` (4 endpoints)
- Registered in: `server.ts`

## Frontend Changes Summary
- New components:
  - `CustomProgramWizard.tsx` (main wizard)
  - `PhotoParser.tsx` (image upload & OCR)
  - `ManualEntryEditor.tsx` (manual day/exercise entry)
  - `AIFeedbackModal.tsx` (validation & coaching UI)
- Updated: `PlanHubView.tsx` (added button)
- Updated: `translations.ts` (added EN/FR strings)

## Feature Complete ✅
All remaining enhancements are now complete:
- ✅ Manual Entry Editor
- ✅ AI Validation UI (Free)
- ✅ AI Coaching UI (Pro)
- ✅ Photo OCR with text review
- ✅ Structured extraction
- ✅ Economy limits (1 parse/month free, 4/month pro)
- ✅ Preview & activation flow
