# All scripts you need (you don’t need to know PowerShell)

You only run commands in a terminal. **Copy, paste, press Enter.** That’s it.

---

## CAN'T SEE WHAT'S WRONG WITH THE BUILD? — GET THE LOG INTO A FILE

1. Open **PowerShell**.
2. Run these two lines (copy all, paste, Enter):

```powershell
cd "c:\Users\rmkoc\Downloads\vitapp2\vitality_api-main\vitality_api-main"
.\scripts\fetch-build-log.ps1
```

3. **Open the file `build-log.txt`** in that folder. That's the build log. You'll see why it failed.

**If the script says "permission denied" or 403:**  
Replace `your.email@gmail.com` with the Google account you use in Cloud Console, then run:

```powershell
gcloud config set project bright-aloe-485517-n8
gcloud projects add-iam-policy-binding bright-aloe-485517-n8 --member="user:your.email@gmail.com" --role="roles/logging.viewer"
```

Then run `.\scripts\fetch-build-log.ps1` again and open `build-log.txt`.

---

## Where to run everything

**Folder:**  
`c:\Users\rmkoc\Downloads\vitapp2\vitality_api-main\vitality_api-main`

**How to open a terminal here on Windows**

1. Press the **Windows** key, type **PowerShell**, click **Windows PowerShell**.
2. Type this and press **Enter**:
   ```text
   cd "c:\Users\rmkoc\Downloads\vitapp2\vitality_api-main\vitality_api-main"
   ```
3. From now on, every command below is run in that same window, in that folder.

---

## 1. You don’t have gcloud yet

**Script:** `install-gcloud.ps1`  
**What it does:** Installs the Google Cloud (gcloud) tool so the other scripts can talk to Google Cloud.

**Command:**
```powershell
.\scripts\install-gcloud.ps1
```

**What to do next:** When it finishes, **close PowerShell, open it again**, go back to the folder (run the `cd "c:\Users\...\vitality_api-main"` line from above), then run any other script you need.

---

## 2. Cloud Build fails with “permission denied” (push or deploy)

**Script:** `DO-FIX-CLOUDBUILD.ps1`  
**What it does:** Fixes permissions so the build can push the image and deploy to Cloud Run. Uses your Google sign-in.

**Command:**
```powershell
.\scripts\DO-FIX-CLOUDBUILD.ps1
```

**What to do next:**  
- If it says “Close this window, open a NEW PowerShell… and run again” → do that, then run the same command again.  
- If a browser opens → sign in with the Google account that has access to the project.  
- When it says **Done** → go to [Cloud Build → History](https://console.cloud.google.com/cloud-build/builds), open the failed build, click **Retry**.

---

## 3. Cloud Build says “No logs were found” – you want to see why it failed

**Script:** `fetch-build-log.ps1`  
**What it does:** Downloads the latest Europe build log into a file you can open.

**Command:**
```powershell
.\scripts\fetch-build-log.ps1
```

**What to do next:**  
- Open the file **`build-log.txt`** in the same folder (`vitality_api-main`). That’s the build log.  
- If the script says you don’t have permission → someone with project access needs to give you **Logs Viewer** (see CLOUDBUILD_FIX_ARTIFACT_REGISTRY.md, “Fix: No logs were found”), then run the script again.

---

## 4. Global Cloud Build works, Europe fails – make Europe behave like Global

**Script:** `fix-europe-trigger-match-global.ps1`  
**What it does:** Makes the Europe trigger use the same service account as the working global trigger (and grants permissions if needed).

**Command:**
```powershell
gcloud config set project bright-aloe-485517-n8
.\scripts\fix-europe-trigger-match-global.ps1
```

**What to do next:**  
- You must be signed in (`gcloud auth login`) and have run the `gcloud config set project` line above before this.  
- When it finishes → go to Cloud Build → History and **Retry** the Europe build, or push a new commit to `main`.

---

## 5. Build says “vitality-api-cb does not have permission to write logs” or Step 3 (deploy) fails

**Script:** `fix-vitality-api-cb-logging-and-deploy.ps1`  
**What it does:** Gives the `vitality-api-cb` service account permission to write build logs and to use the Compute default SA when deploying to Cloud Run. Use when the build shows the “does not have permission to write logs” message or when Step 3 (`gcloud run deploy`) fails.

**Command:**
```powershell
gcloud config set project bright-aloe-485517-n8
.\scripts\fix-vitality-api-cb-logging-and-deploy.ps1
```

**What to do next:** When it says **Done** → go to Cloud Build → History and **Retry** the build.

---

## 6. Use a dedicated service account for the build trigger

**Script:** `fix-cloudbuild-trigger-sa.ps1`  
**What it does:** Creates a service account just for Cloud Build, gives it the right permissions, and switches your vitality-api trigger to use it.

**Command:**
```powershell
gcloud config set project bright-aloe-485517-n8
.\scripts\fix-cloudbuild-trigger-sa.ps1
```

**What to do next:**  
- When it finishes → push to `main` or **Retry** the failed build in Cloud Build → History.  
- If your trigger has a different name:  
  `.\scripts\fix-cloudbuild-trigger-sa.ps1 -TriggerName "your-trigger-id"`

---

## 7. Simpler fix – only grant Artifact Registry to Cloud Build

**Script:** `fix-cloudbuild-artifact-registry.ps1`  
**What it does:** Gives the default Cloud Build service account permission to push images to Artifact Registry. Use when the failure is “upload Artifacts denied” and you’re using the default Cloud Build account.

**Command:**
```powershell
gcloud config set project bright-aloe-485517-n8
.\scripts\fix-cloudbuild-artifact-registry.ps1
```

**What to do next:** Retry the failed build in Cloud Build → History.

---

## 8. Deploy from your PC and skip the trigger

**Script:** `build-and-deploy-local.ps1`  
**What it does:** Builds the API image on your machine and deploys it to Cloud Run using your Google account. Use when the trigger keeps failing but you have permission to deploy.

**Command:**
```powershell
.\scripts\build-and-deploy-local.ps1
```

**Optional – deploy with a custom tag:**
```powershell
.\scripts\build-and-deploy-local.ps1 -Tag "mytag"
```

**What to do next:**  
- When it succeeds, the live API is updated.  
- You can still push to GitHub; if the trigger fails, the service is already updated from this script.

---

## Quick reference – which script when

| What’s wrong | Script to run |
|--------------|----------------|
| gcloud not installed | `.\scripts\install-gcloud.ps1` |
| Build fails with “permission denied” | `.\scripts\DO-FIX-CLOUDBUILD.ps1` |
| “No logs were found” – I want to see the log | `.\scripts\fetch-build-log.ps1` → open `build-log.txt` |
| Global works, Europe fails | `.\scripts\fix-europe-trigger-match-global.ps1` (after `gcloud config set project bright-aloe-485517-n8`) |
| “vitality-api-cb does not have permission to write logs” or Step 3 (deploy) fails | `.\scripts\fix-vitality-api-cb-logging-and-deploy.ps1` (after `gcloud config set project bright-aloe-485517-n8`) |
| I want a dedicated build service account | `.\scripts\fix-cloudbuild-trigger-sa.ps1` |
| Just fix “upload Artifacts denied” (default Cloud Build) | `.\scripts\fix-cloudbuild-artifact-registry.ps1` |
| Deploy from my PC and ignore the trigger | `.\scripts\build-and-deploy-local.ps1` |

---

## One-line reminder

**Always run commands from this folder:**  
`c:\Users\rmkoc\Downloads\vitapp2\vitality_api-main\vitality_api-main`

If you’re not sure you’re there, run:
```powershell
cd "c:\Users\rmkoc\Downloads\vitapp2\vitality_api-main\vitality_api-main"
```
then run the script command.
