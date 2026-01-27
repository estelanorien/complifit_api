# Production backend – CORS/500 fix checklist

The code in this repo has been updated so the API **always** sends CORS headers and handles errors correctly. For that to work in production, the **new image must be built and deployed**, and traffic must go to the **new revision**.

## 1. Check that builds run and succeed

1. Open **Google Cloud Console** → **Cloud Build** → **History**.
2. Find builds for this repo (e.g. `mcandiri/vitality_api` or the repo URL you use).
3. Confirm there is a build that ran **after** these commits:
   - `8a95732` – explicit OPTIONS for CORS preflight  
   - `fbfdb26` – JWT clock tolerance, safe auth, by-movement 500 + CORS  
   - `4b9b6d2` – CORS `Access-Control-Allow-Origin: *` everywhere
4. Open that build. If it **failed**, fix the error (e.g. in the build log for the Docker or `npm run build` step).

If you don’t see any new builds when you push to `main`, the trigger is missing or wrong.  
Go to **Cloud Build** → **Triggers** and add or edit a trigger so that it runs on push to the correct branch (usually `main`) for this repo.

## 2. Check that the new revision is serving traffic

1. Open **Google Cloud Console** → **Cloud Run** → select **vitality-api** → **Revisions**.
2. Check the **latest revision** (top of the list). Note its **Created** time.
3. Confirm that revision was created **after** the last successful build (step 1).
4. Confirm that this revision has **100%** (or the intended share) of traffic. If an old revision still has 100%, the new one will never get requests.

If the latest revision is old (before the commits above), either the build didn’t run/finish, or the deploy step failed. Fix the build first, then redeploy.

## 3. Quick test from the browser

After a **successful** build and a **new** revision with traffic:

1. **CORS check (no auth):** From your frontend (e.g. DevTools on http://localhost:5174), run:  
   `fetch('https://vitality-api-684095677071.europe-west1.run.app/api/cors-test').then(r=>r.json()).then(console.log)`  
   You should get `{ ok: true, cors: 'allowed' }` with no CORS error.
2. **Health:** Open:  
  `https://vitality-api-684095677071.europe-west1.run.app/api/health`  
  (or your real Cloud Run URL + `/api/health`). You should get JSON without a CORS error.  
  If you see “No 'Access-Control-Allow-Origin' header”, then either the new revision is not getting traffic or something in front of Cloud Run is altering responses.

---

**Summary:** The app code is fixed. Production will behave correctly only when (1) Cloud Build runs and succeeds on the latest commits, and (2) the new Cloud Run revision receives traffic.
