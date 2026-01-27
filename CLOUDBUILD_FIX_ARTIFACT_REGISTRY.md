# Fix: Cloud Build permission denied (push + deploy)

---

## Windows – just run this script (not techie)

1. Open **PowerShell** and go to the repo folder (the folder that contains `scripts`).
2. Run:
   ```powershell
   .\scripts\DO-FIX-CLOUDBUILD.ps1
   ```
3. If it says **"Close this window, open a NEW PowerShell… and run again"** — do that. Then run the same command again in the new window.
4. When it asks you to **sign in to Google**, a browser opens; sign in with the Google account that has access to the project.
5. When it says **"Done"**, go to **Google Cloud Console → Cloud Build → History**, open the failed build, and click **Retry**.

**If you don’t have gcloud yet:** The script will install it (or run `.\scripts\install-gcloud.ps1` first). When the install finishes, close PowerShell, open it again, go to the repo folder, and run `.\scripts\DO-FIX-CLOUDBUILD.ps1`.

---

**Build identity:** The vitality-api trigger runs as **gemini@bright-aloe-485517-n8.iam.gserviceaccount.com**. That account needs push (Step #1) and deploy (Step #2) permissions.

---

## Full fix (push + deploy) – Cloud Shell or if you already have gcloud

After a fresh setup or when both Step #1 (push) and Step #2 (deploy) fail, run this **one block** in Cloud Shell. It grants **gemini@** everything needed: Artifact Registry Writer, Cloud Run Admin, and permission to act as the Compute default SA.

```bash
PROJECT_ID=bright-aloe-485517-n8
LOC=europe-west1
REPO=cloud-run-source-deploy
GEMINI_SA="gemini@${PROJECT_ID}.iam.gserviceaccount.com"
COMPUTE_SA="684095677071-compute@developer.gserviceaccount.com"

gcloud config set project $PROJECT_ID
gcloud artifacts repositories describe $REPO --location=$LOC --project=$PROJECT_ID &>/dev/null || \
  gcloud artifacts repositories create $REPO --repository-format=docker --location=$LOC --project=$PROJECT_ID --description="Cloud Run source deploy"

# Push (Step #1): Artifact Registry Writer on repo + project
gcloud artifacts repositories add-iam-policy-binding $REPO --location=$LOC --project=$PROJECT_ID --member="serviceAccount:$GEMINI_SA" --role="roles/artifactregistry.writer"
gcloud projects add-iam-policy-binding $PROJECT_ID --member="serviceAccount:$GEMINI_SA" --role="roles/artifactregistry.writer"

# Deploy (Step #2): Cloud Run Admin + act-as Compute default SA
gcloud projects add-iam-policy-binding $PROJECT_ID --member="serviceAccount:$GEMINI_SA" --role="roles/run.admin"
gcloud iam service-accounts add-iam-policy-binding $COMPUTE_SA --member="serviceAccount:$GEMINI_SA" --role="roles/iam.serviceAccountUser" --project=$PROJECT_ID

echo Done. Retry build in Cloud Build > History.
```

Then go to **Cloud Build → History**, open the failed build, and click **Retry**.

**Or run the script:** In Cloud Shell, from the repo root run `bash scripts/run-full-fix-cloudbuild-permissions.sh`.

---

## If deploy fails at Step #2 only

Your build runs as **gemini@bright-aloe-485517-n8.iam.gserviceaccount.com**. It needs Cloud Run Admin and permission to act as the Compute default SA. Paste this into Cloud Shell:

```bash
gcloud config set project bright-aloe-485517-n8
# Cloud Run deploy
gcloud projects add-iam-policy-binding bright-aloe-485517-n8 --member="serviceAccount:gemini@bright-aloe-485517-n8.iam.gserviceaccount.com" --role="roles/run.admin"
# Let gemini@ "act as" the Compute default SA (needed for gcloud run deploy)
gcloud iam service-accounts add-iam-policy-binding 684095677071-compute@developer.gserviceaccount.com --member="serviceAccount:gemini@bright-aloe-485517-n8.iam.gserviceaccount.com" --role="roles/iam.serviceAccountUser" --project=bright-aloe-485517-n8
echo Done. Retry build in Cloud Build > History.
```

Then retry the failed build.

---

## If push fails at Step #1 with "artifactregistry.repositories.uploadArtifacts denied"

Paste this into Cloud Shell, run it, then retry the failed build.

```bash
PROJECT_ID=bright-aloe-485517-n8
PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')
REPO=cloud-run-source-deploy
LOC=europe-west1
gcloud config set project $PROJECT_ID
gcloud artifacts repositories describe $REPO --location=$LOC --project=$PROJECT_ID &>/dev/null || gcloud artifacts repositories create $REPO --repository-format=docker --location=$LOC --project=$PROJECT_ID --description="Cloud Run source deploy"

# Grant the SA that actually ran the last build (Artifact Registry + Cloud Run)
LAST_BUILD=$(gcloud builds list --region=$LOC --limit=1 --format='value(id)')
BUILD_SA=$(gcloud builds describe $LAST_BUILD --region=$LOC --format='value(serviceAccount)' 2>/dev/null)
if [ -n "$BUILD_SA" ]; then
  MEMBER="serviceAccount:${BUILD_SA#*/serviceAccounts/}"
  gcloud artifacts repositories add-iam-policy-binding $REPO --location=$LOC --project=$PROJECT_ID --member="$MEMBER" --role="roles/artifactregistry.writer"
  gcloud projects add-iam-policy-binding $PROJECT_ID --member="$MEMBER" --role="roles/artifactregistry.writer"
  gcloud projects add-iam-policy-binding $PROJECT_ID --member="$MEMBER" --role="roles/run.admin"
  echo "Granted build SA: $MEMBER (Artifact Registry + Run Admin)"
fi

# Grant known identities + gemini SA (trigger uses this)
for SA in "${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com" "${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" "service-${PROJECT_NUMBER}@gcp-sa-cloudbuild.iam.gserviceaccount.com" "gemini@${PROJECT_ID}.iam.gserviceaccount.com"; do
  gcloud artifacts repositories add-iam-policy-binding $REPO --location=$LOC --project=$PROJECT_ID --member="serviceAccount:$SA" --role="roles/artifactregistry.writer"
  gcloud projects add-iam-policy-binding $PROJECT_ID --member="serviceAccount:$SA" --role="roles/artifactregistry.writer"
  gcloud projects add-iam-policy-binding $PROJECT_ID --member="serviceAccount:$SA" --role="roles/run.admin"
done
echo Done. Retry build in Cloud Build > History.
```

**If it still fails:** In Cloud Build → History, open the failed build, copy the **Build ID** (e.g. `90db1042-5191-4bbb-bdfd-0638a1b2ee16`). Run:

```bash
gcloud builds describe BUILD_ID --region=europe-west1 --format='yaml(serviceAccount)'
```

Then run (replace `THE_EMAIL_IT_PRINTED` with the serviceAccount value):

```bash
gcloud artifacts repositories add-iam-policy-binding cloud-run-source-deploy --location=europe-west1 --project=bright-aloe-485517-n8 --member="serviceAccount:THE_EMAIL_IT_PRINTED" --role="roles/artifactregistry.writer"
gcloud projects add-iam-policy-binding bright-aloe-485517-n8 --member="serviceAccount:THE_EMAIL_IT_PRINTED" --role="roles/artifactregistry.writer"
```

Then retry the build.

---

## One-command fix (recommended): dedicated SA + trigger update

This creates a service account with the right permissions and makes your **vitality-api** trigger use it, so the push step succeeds.

**From the repo root** (with `gcloud` installed and logged in):

```powershell
gcloud config set project bright-aloe-485517-n8
.\scripts\fix-cloudbuild-trigger-sa.ps1
```

The script will:
1. Create `vitality-api-cb@bright-aloe-485517-n8.iam.gserviceaccount.com` (if it doesn’t exist)
2. Grant it **Artifact Registry Writer** and **Cloud Run Admin** on the project
3. Find your vitality-api trigger in `europe-west1` and set it to use this service account

If your trigger has a different name, run:

```powershell
.\scripts\fix-cloudbuild-trigger-sa.ps1 -TriggerName "your-trigger-id"
```

Then push to `main` or retry the failed build in **Cloud Build** → **History**.

---

## Fix the vitality-api build (manual / Cloud Build default SA)

Use **Cloud Shell** (no gcloud install):

1. Open **[Google Cloud Console](https://console.cloud.google.com)** and ensure the project is **bright-aloe-485517-n8**.
2. Click **Cloud Shell** (terminal icon, top right). Wait for the shell to open.
3. Paste and run this **entire block** (it sets project, gets project number, then grants the role):

```bash
PROJECT_ID=bright-aloe-485517-n8
gcloud config set project $PROJECT_ID
PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')
gcloud artifacts repositories add-iam-policy-binding cloud-run-source-deploy \
  --location=europe-west1 --project=$PROJECT_ID \
  --member="serviceAccount:${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com" \
  --role="roles/artifactregistry.writer"
```

4. Go to **Cloud Build** → **History** → find the failed **vitality-api** build → **⋮** → **Retry**.

---

## Alternative: local gcloud or PowerShell

### Cloud Shell (bash) – steps 2–3

In [Google Cloud Console](https://console.cloud.google.com), open **Cloud Shell** (top right), or use a local terminal with `gcloud` installed and logged in.

**Windows (PowerShell):** After `gcloud auth login` and `gcloud config set project bright-aloe-485517-n8`, run from the repo root:
```powershell
.\scripts\fix-cloudbuild-artifact-registry.ps1
```

## 2. Set project and get project number

```bash
export PROJECT_ID=bright-aloe-485517-n8
gcloud config set project $PROJECT_ID
export PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')
echo "Project number: $PROJECT_NUMBER"
```

## 3. Grant Artifact Registry Writer to Cloud Build

Run **one** of the following.

**Option A – scope to the single repository (recommended)**

```bash
gcloud artifacts repositories add-iam-policy-binding cloud-run-source-deploy \
  --location=europe-west1 \
  --project=$PROJECT_ID \
  --member="serviceAccount:${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com" \
  --role="roles/artifactregistry.writer"
```

**Option B – scope to the whole project (if Option A is not enough)**

```bash
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com" \
  --role="roles/artifactregistry.writer"
```

## 4. Re-run the build

1. Open **Cloud Build** → **History**.
2. Find the failed build for the **vitality-api** trigger.
3. Click the **⋮** menu → **Retry**.

Or push a new commit to `main` to trigger a fresh build.

---

---

## Trigger uses Compute Engine default service account

If your trigger is configured to use the **Compute Engine default** service account (e.g. `684095677071-compute@developer.gserviceaccount.com`), that account must have push and deploy rights. Grant:

1. **Artifact Registry Writer** (for Step #1 – push image):
   ```bash
   gcloud artifacts repositories add-iam-policy-binding cloud-run-source-deploy \
     --location=europe-west1 --project=bright-aloe-485517-n8 \
     --member="serviceAccount:684095677071-compute@developer.gserviceaccount.com" \
     --role="roles/artifactregistry.writer"
   ```

2. **Cloud Run Admin** (for Step #3 – deploy), if the build fails at deploy with a permission error:
   ```bash
   gcloud projects add-iam-policy-binding bright-aloe-485517-n8 \
     --member="serviceAccount:684095677071-compute@developer.gserviceaccount.com" \
     --role="roles/run.admin"
   ```

3. **If Step #1 still fails** after repo-level Writer, grant **project-level** Artifact Registry Writer to the same account:
   ```bash
   gcloud projects add-iam-policy-binding bright-aloe-485517-n8 \
     --member="serviceAccount:684095677071-compute@developer.gserviceaccount.com" \
     --role="roles/artifactregistry.writer"
   ```

**Verify the trigger’s service account:** Cloud Build → Triggers → your vitality-api trigger → Edit → check “Service account”. The account shown there is the one that needs the roles above. Then retry the build (Cloud Build → History → ⋮ → Retry, or push a new commit to `main`).

---

## Deploy from your machine (bypass trigger)

If the trigger still fails and you have **Owner/Editor** (or Artifact Registry Writer + Cloud Run Admin) on the project, you can build, push, and deploy from your laptop using **your** gcloud/Docker credentials:

1. **Prereqs:** Docker, gcloud CLI, `gcloud auth login`, `gcloud config set project bright-aloe-485517-n8`
2. From the **repo root** (vitality_api directory with Dockerfile):
   ```powershell
   .\scripts\build-and-deploy-local.ps1
   ```
   Or with a custom tag: `.\scripts\build-and-deploy-local.ps1 -Tag "mytag"`
3. After it succeeds, push to GitHub as usual. The trigger will run on push; if its service account still lacks permission, the trigger build fails but the service is already updated from step 2.

---

**Why this happens:** The **vitality-api** trigger runs in `europe-west1` and pushes to `europe-west1-docker.pkg.dev/.../cloud-run-source-deploy/vitality-api`. The service account used by the trigger (Cloud Build default `PROJECT_NUMBER@cloudbuild.gserviceaccount.com` or, if overridden, the Compute Engine default `PROJECT_NUMBER-compute@developer.gserviceaccount.com`) must have `roles/artifactregistry.writer` on that repository (or project) to upload images, and `roles/run.admin` on the project if it also runs the deploy step.
