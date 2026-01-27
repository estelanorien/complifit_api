# Fix: Cloud Build "Permission artifactregistry.repositories.uploadArtifacts denied"

If your **vitality-api** Cloud Build fails at **Step #1** (push to Artifact Registry) with:

```text
denied: Permission 'artifactregistry.repositories.uploadArtifacts' denied on resource
```

the build service account does not have permission to push images to Artifact Registry. Fix it by granting **Artifact Registry Writer** to the Cloud Build service account.

## 1. Open Cloud Shell or use local gcloud

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

**Why this happens:** The **vitality-api** trigger runs in `europe-west1` and pushes to `europe-west1-docker.pkg.dev/.../cloud-run-source-deploy/vitality-api`. The Cloud Build default service account (`PROJECT_NUMBER@cloudbuild.gserviceaccount.com`) must have `roles/artifactregistry.writer` on that repository (or project) to upload images.
