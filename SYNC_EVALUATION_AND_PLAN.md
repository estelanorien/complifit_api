# Synchronization Evaluation and Plan (vitality_web + vitality_api)

**Apply migration 046 before relying on `text_context` / `text_context_simple` in DB:**  
`psql "$DATABASE_URL" -f migrations/046_add_text_context_to_cached_asset_meta.sql` (from API repo root).

This document evaluates why synchronization might not work, from all angles, and presents a plan with explanations **before** applying any code changes.

---

## 1. What “synchronization” means in this codebase

There are **two distinct sync flows**:

| Flow | Trigger | What it does | API used |
|------|---------|--------------|----------|
| **Sync Library (button)** | User clicks “Sync Library” in Asset Lab for the active group | Fetches all assets for that movement from the DB and fills the group (images, text, meta). | `POST /api/assets/by-movement` with `{ movementId, limit: 100 }` |
| **Sidebar / initial load** | Loading Admin Dashboard or opening Asset Lab | Builds the list of groups (exercises/meals), then checks which assets already exist in DB and sets `isSynced` / counts. | `GET /admin/movements`, `GET /admin/assets/recent`, then `POST /admin/assets/scan` + `POST /api/assets/check` |

When someone says “synchronization doesn’t work,” they can mean either or both.

---

## 2. Sync flow (button): POST /assets/by-movement

### 2.1 Web (vitality_web)

- **Entry:** `AssetLab.tsx` → `handleAutoFillLibrary()`.
- **movementId:** `normalizeToMovementId(activeGroup.name)` (e.g. `"Ankle Alphabet Ankle Sprain"` → `ankle_alphabet_ankle_sprain`).
- **Request:** `assetService.fetchAssetsByMovement(movementId)` → `POST /api/assets/by-movement` with body `{ movementId, limit: 100 }`, **with auth** (`requiresAuth: true` → `Authorization: Bearer <token>`).
- **Expectation:** Array of rows with `key`, `value`, `asset_type`, `status`, `text_context`, `text_context_simple`, etc. Rows are then mapped to images/drafts and the group is updated.

### 2.2 API (vitality_api)

- **Route:** `assets.ts` → `POST /assets/by-movement` (mounted under `/api` → full path `/api/assets/by-movement`).
- **Auth:** `authGuard` only (no admin guard). Any authenticated user can call it.
- **Query:**  
  `cached_assets a`  
  `LEFT JOIN cached_asset_meta m ON m.key = a.key`  
  `LEFT JOIN asset_blob_storage b ON b.key = a.key`  
  **WHERE** `m.movement_id = $1` **OR** `a.key LIKE ex:$1:%` **OR** `meal:$1:%` **OR** `ex_$1%` **OR** `meal_$1%` **OR** `$1%`  
  **LIMIT** `$2`.
- **Response:** Rows with `key`, `value` (base64 for images), `asset_type`, `status`, meta fields. The handler **does not** SELECT `text_context` / `text_context_simple` (to avoid 500 if migration 046 is missing); it **adds** them in the response map as `null` so the frontend always gets the same shape.

### 2.3 Possible failure points (Sync Library button)

| Angle | Risk | Explanation |
|-------|------|-------------|
| **HTTP 500** | **Largely fixed** | Previously failed when the query selected `m.text_context` / `m.text_context_simple` and those columns did not exist. The route was changed to omit them from the SELECT and default them in the response. **Remaining risk:** None for the by-movement *read* path. |
| **HTTP 401** | Token missing or invalid | Frontend sends `Authorization: Bearer <token>`. If the user is not logged in or the token is expired/invalid, the API returns 401 and the frontend redirects to login. **Check:** User must be logged in when clicking Sync. |
| **Empty array** | No rows match | Possible causes: (1) DB has no assets for that movement. (2) **movementId mismatch:** web sends normalized slug (e.g. `ankle_alphabet_ankle_sprain`); DB keys are `ex:ankle_alphabet_ankle_sprain:...` or `meal:...`. The WHERE uses both `m.movement_id = $1` and `a.key LIKE ex:$1:%` etc., so if keys follow the convention, they match. (3) **movement_id not set in meta:** If `cached_asset_meta.movement_id` is null for all rows, the first condition fails but the LIKE on `a.key` still matches keys like `ex:ankle_alphabet_ankle_sprain:%`. So empty array usually means “no assets for that movement in DB.” |
| **CORS** | Preflight or response blocked | API sets `Access-Control-Allow-Origin: *` and explicit OPTIONS for `/assets/by-movement`. In dev, Vite proxies `/api` to the Cloud Run URL, so the browser hits same-origin and CORS is not involved. In production, `VITE_API_BASE_URL` must point to the API; with `*` on the API side, CORS should not block. |
| **Base URL / proxy** | Wrong host or path | In dev, `API_BASE_URL = '/api'`; request is `/api/assets/by-movement`; Vite proxy forwards to `https://vitality-api-684095677071.europe-west1.run.app/api/assets/by-movement`. Backend mounts assets at prefix `/api`, so path matches. |
| **normalizeToMovementId** | Web and API disagree on slug | Web: `adminService.normalizeToMovementId` (lowercase, non-alphanumeric → space, split, join with `_`). API: `normalization.normalizeToMovementId` and `AssetPromptService.normalizeToId` use the same logic. **Verified:** Same behavior; no mismatch. |

---

## 3. Sync flow (sidebar / initial load): fetchAssetGroups + checkExistingKeys

### 3.1 Web

- **Entry:** `fetchAssetGroups()` in `adminService.ts`. Used when loading the dashboard / Asset Lab.
- **Steps:**  
  1. `GET /admin/movements` and `GET /admin/assets/recent`.  
  2. Build groups with UnifiedKey format (`ex:slug:persona:subtype:index`, e.g. `ex:ankle_alphabet_ankle_sprain:atlas:main:0`).  
  3. Collect all keys, then `checkExistingKeys(allKeys)`.  
  4. **checkExistingKeys:**  
     - Derives “prefixes” from keys: `k.replace(/(_main|_prep|_step.*)$/, '')`. For UnifiedKey there is no such suffix, so **prefix = full key**.  
     - **One** call: `POST /admin/assets/scan` with `{ prefixes: [ ... full keys ... ] }`.  
     - Backend returns rows where `a.key LIKE prefix%` (so each full key gets at most that one key back).  
     - Then `POST /api/assets/check` with the list of found keys to get status.  
  5. Map results back to groups and set `isSynced` / counts.

### 3.2 API

- **POST /admin/assets/scan** (admin guard): body `{ prefixes: string[] }`. Query: `a.key LIKE ANY(patterns)` with `patterns = prefixes.map(p => p + '%')`, plus `m.original_name LIKE ANY(patterns)`. Returns keys + meta fields.  
- **POST /api/assets/check** (auth guard): body `{ keys: string[] }`. Query: `SELECT key, status FROM cached_assets WHERE key = ANY($1)`. Exact match.

### 3.3 Possible failure points (sidebar sync)

| Angle | Risk | Explanation |
|-------|------|-------------|
| **Scan returns nothing** | Prefix vs key mismatch | Frontend sends full UnifiedKeys as “prefixes.” Backend does `LIKE prefix%`. For `ex:ankle_alphabet_ankle_sprain:atlas:main:0` that matches only that key. So if the key exists in DB, scan returns it. **Risk:** If the frontend ever sent a truncated or different prefix, some assets could be missed. Current code sends full keys, so behavior is correct (though one logical “prefix” per key is inefficient). |
| **Check returns nothing** | Key format mismatch | Check does exact match. Keys from scan are DB keys; frontend requested keys are UnifiedKey. They must match. If backend stores the same UnifiedKey format, they do. |
| **Admin guard** | 403 for scan | Scan requires admin/owner. If the user is not admin, scan returns 403 and the whole fetchAssetGroups can fail or fall back; need to confirm error handling. |

---

## 4. Database schema (migration 046)

- **cached_asset_meta** is expected to have `text_context` and `text_context_simple` (see `SYNC_ASSETS_500_FIX.md` and `migrations/046_add_text_context_to_cached_asset_meta.sql`).
- **POST /assets/by-movement** no longer SELECTs these columns; it adds them as `null` in the response, so **by-movement works even if 046 is not applied**.
- **AssetRepository.save()** (used when saving/updating assets and meta) **does** INSERT/UPDATE `text_context` and `text_context_simple` in `cached_asset_meta`. If migration 046 has **not** been applied, that INSERT/UPDATE will fail with “column does not exist,” so:
  - **Sync Library (read)** can work without 046.
  - **Saving assets / batch jobs** that write meta can fail until 046 is applied.

---

## 5. Summary: why synchronization might not work

- **Sync Library button (POST /assets/by-movement):**  
  - **500:** Addressed by not selecting `text_context`/`text_context_simple` and defaulting them in the response.  
  - **401:** User not logged in or token invalid.  
  - **Empty array:** No assets in DB for that movement (or wrong movementId; normalization is aligned).  
  - **Network/CORS/URL:** Proxy and CORS are set up correctly; production needs correct `VITE_API_BASE_URL`.

- **Sidebar / initial load:**  
  - Depends on `/admin/movements`, `/admin/assets/recent`, `/admin/assets/scan`, `/api/assets/check`.  
  - Scan uses full keys as prefixes; behavior is correct.  
  - Admin permission required for scan; otherwise 403.

- **DB:**  
  - Apply migration 046 so that all meta writes (AssetRepository.save, etc.) succeed and `text_context`/`text_context_simple` are available for future use.

---

## 6. Plan (no code changes applied yet)

### 6.1 Verify and document

1. **Confirm migration 046 is applied** on the environment the API uses.  
   - Run:  
     `SELECT column_name FROM information_schema.columns WHERE table_name = 'cached_asset_meta' AND column_name IN ('text_context','text_context_simple');`  
   - If either column is missing, run `migrations/046_add_text_context_to_cached_asset_meta.sql` (or your normal migration process).

2. **Confirm Sync Library is using the right movementId.**  
   - In Asset Lab, when clicking Sync for a group, the frontend uses `normalizeToMovementId(activeGroup.name)`.  
   - Ensure `activeGroup.name` is the display name that matches backend convention (e.g. “Ankle Alphabet Ankle Sprain” → `ankle_alphabet_ankle_sprain`).  
   - Optional: add a short log or debug line in the frontend (or a temporary log in the API) to log the `movementId` sent on Sync and the number of rows returned.

3. **Confirm auth for by-movement.**  
   - Ensure the user is logged in when using Sync Library.  
   - If 401s persist, check token refresh and that the request actually sends `Authorization: Bearer <token>` for `POST /api/assets/by-movement`.

### 6.2 Optional robustness (after verification)

4. **API: by-movement response shape**  
   - Already adds `text_context` and `text_context_simple` when missing. No change required unless you want to start returning real values from DB when 046 is applied (current code path already supports that once columns exist).

5. **Web: error handling and user feedback**  
   - On `POST /assets/by-movement`: if response is 500, show “Sync failed (server error).” If 401, redirect to login. If 200 and empty array, show “No assets found in DB for this movement. Generate first.”  
   - Optionally surface the API error message for 500 (e.g. in a tooltip or log) to aid debugging.

6. **Sidebar sync**  
   - If “isSynced” or counts are wrong, verify that scan is called with the same key format the backend stores (UnifiedKey). Current code sends full keys as prefixes; no change needed unless you later optimize to send movement-level prefixes (e.g. `ex:ankle_alphabet_ankle_sprain`) and then map results back to the full key list.

### 6.3 Do not change (unless proven otherwise)

- **normalizeToMovementId** logic (web and API): already aligned.  
- **CORS** for `/assets/by-movement`: already permissive and OPTIONS handled.  
- **Vite proxy** in dev: correct target and path.

---

## 7. Recommended order of operations

1. **Apply migration 046** if not already applied (so all meta writes and future reads of text_context are consistent).  
2. **Reproduce** “synchronization doesn’t work” (Sync Library button and/or sidebar).  
3. **Inspect** network tab: for Sync Library, check `POST /api/assets/by-movement` → status (200/401/500), body (empty array vs rows), and request body `movementId`.  
4. **If 200 + empty array:** confirm in DB that there are assets for that movement (e.g. `SELECT key FROM cached_assets WHERE key LIKE 'ex:ankle_alphabet_ankle_sprain:%'`).  
5. **If 500:** capture API response body or server logs; the by-movement handler should no longer 500 from missing columns; any new 500 indicates another cause (e.g. DB connection, other column/table issue).  
6. **If 401:** fix login/token and retry.  
7. **Optionally** add minimal logging (movementId + row count) on API and/or frontend to make future debugging easier.

No code changes have been applied in this document; the above is the evaluation and plan to follow before implementing any fix.
