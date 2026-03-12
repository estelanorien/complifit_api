# Sync assets 500 fix (POST /assets/by-movement)

## Cause

`POST /assets/by-movement` was returning **HTTP 500** because the query selects `m.text_context` and `m.text_context_simple` from `cached_asset_meta`, but those columns were never added by any migration—only by the one-off script `scripts/fix_meta_schema.ts`. If that script was not run, the database lacks those columns and the query fails with a SQL error.

## Fix

Run the new migration so `cached_asset_meta` has the required columns:

```bash
cd vitality_api-main
psql "$DATABASE_URL" -f migrations/046_add_text_context_to_cached_asset_meta.sql
```

Or run it through your normal migration process (e.g. Cloud SQL migration job, or whatever applies the `migrations/*.sql` files in order).

After 046 is applied, “Sync assets” in Asset Lab should succeed for movements like `ankle_alphabet_ankle_sprain`.

## Verify

```sql
SELECT column_name FROM information_schema.columns 
WHERE table_name = 'cached_asset_meta' AND column_name IN ('text_context','text_context_simple');
```
You should see both `text_context` and `text_context_simple`.

## Resilience (2026-02)

The `POST /assets/by-movement` handler now tolerates missing columns in `cached_asset_meta` (e.g. if migrations 041/042/046 are not yet applied). On PostgreSQL error `42703` (undefined_column) it runs a fallback query that selects only base meta columns and returns the same response shape with null for optional fields. Applying the migrations is still recommended so translation/video status and text_context are returned when present.
