#!/bin/bash
# Full fix: grant gemini@ push (Step #1) and deploy (Step #2) permissions.
# Run in Cloud Shell: bash scripts/run-full-fix-cloudbuild-permissions.sh
# Or paste the block from CLOUDBUILD_FIX_ARTIFACT_REGISTRY.md "Full fix (push + deploy)".

set -e
PROJECT_ID=bright-aloe-485517-n8
LOC=europe-west1
REPO=cloud-run-source-deploy
GEMINI_SA="gemini@${PROJECT_ID}.iam.gserviceaccount.com"
COMPUTE_SA="684095677071-compute@developer.gserviceaccount.com"

gcloud config set project "$PROJECT_ID"
gcloud artifacts repositories describe "$REPO" --location="$LOC" --project="$PROJECT_ID" &>/dev/null || \
  gcloud artifacts repositories create "$REPO" --repository-format=docker --location="$LOC" --project="$PROJECT_ID" --description="Cloud Run source deploy"

# Push (Step #1): Artifact Registry Writer on repo + project
gcloud artifacts repositories add-iam-policy-binding "$REPO" --location="$LOC" --project="$PROJECT_ID" --member="serviceAccount:$GEMINI_SA" --role="roles/artifactregistry.writer"
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$GEMINI_SA" --role="roles/artifactregistry.writer"

# Deploy (Step #2): Cloud Run Admin + act-as Compute default SA
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$GEMINI_SA" --role="roles/run.admin"
gcloud iam service-accounts add-iam-policy-binding "$COMPUTE_SA" --member="serviceAccount:$GEMINI_SA" --role="roles/iam.serviceAccountUser" --project="$PROJECT_ID"

echo "Done. Retry build in Cloud Build > History."
