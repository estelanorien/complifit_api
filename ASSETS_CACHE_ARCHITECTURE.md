# Assets cache architecture: one DB, serve to all

Assets populated by **Admin Studio** and by **user-triggered generation** are stored in the same database (`cached_assets`, `cached_asset_meta`, `asset_blob_storage`). All app users are served from that shared cache. This lowers generation cost by reusing each asset for every user instead of regenerating per user.

## Writers (populate the DB)

| Source | How it writes | Tables |
|--------|----------------|--------|
| **Admin Studio** | Batch jobs, “Sync library”, manual ingest → `AssetRepository.save()` | `cached_assets`, `cached_asset_meta`, `asset_blob_storage` |
| **User-triggered generation** | App or backend enqueues `generation_jobs` → `JobProcessor` runs job → `saveAsset()` → `AssetRepository.save()` | Same |
| **AssetOrchestrator** | On-demand generation (e.g. discovery) → `AssetRepository.save()` | Same |
| **Admin / assets API** | Ingest endpoints (e.g. `POST /assets` with body) → `AssetRepository.save()` | Same |

All writers use **deterministic keys** (e.g. `ex_<movement>_atlas_main`, `meal_<id>_step_0_<hash>`) so the same movement/step resolves to the same key for every user.

## Readers (serve from DB)

| Consumer | How it reads | Backend |
|----------|--------------|---------|
| **App (ExerciseItem, MealItem, etc.)** | `getCachedAsset(key)`, `fetchAssetsByMovement(movementId)` | `GET /assets/:key`, `POST /assets/by-movement` |
| **Admin Studio / Asset Lab** | Same `getCachedAsset`, `fetchAssetsByMovement` plus admin APIs | Same routes + admin routes |

The API reads only from `cached_assets` (+ joins to `cached_asset_meta`, `asset_blob_storage`). There is no per-user asset store; every request for the same key gets the same cached row.

## Cost impact

- **Without shared cache:** Each user could trigger generation for the same exercise/meal → N users ⇒ N generations.
- **With shared cache:** First request (admin or user) generates and writes to DB; later requests for that key are served from DB → at most one generation per logical asset, then reuse for all users.

## Constraints to preserve

1. **Single source of truth** – All asset writes must go through `AssetRepository.save()` (or the same underlying tables). No separate “user cache” or in-memory store that bypasses the DB.
2. **Key stability** – Keys must be deterministic from (movement, variant, step, etc.) so admin-populated and user-generated assets for the same movement use the same keys and rows.
3. **Migration 046** – `cached_asset_meta` must include `text_context` and `text_context_simple` or the by-movement query returns 500. Ensure migration `046_add_text_context_to_cached_asset_meta.sql` is applied wherever the API’s DB runs.
