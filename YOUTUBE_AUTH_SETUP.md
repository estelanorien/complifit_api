# YouTube automatic upload – Google auth setup

The API uses **OAuth 2.0** with a **refresh token** so it can upload to your YouTube channel without you logging in each time. You do the auth flow once, get a refresh token, then put three values in env.

---

## 1. Google Cloud Console

### 1.1 Create or pick a project

1. Go to [Google Cloud Console](https://console.cloud.google.com/).
2. Select the same project you use for the API (or create one).
3. Make sure **billing** is enabled (required for YouTube Data API).

### 1.2 Enable YouTube Data API v3

1. **APIs & Services** → **Library**.
2. Search for **YouTube Data API v3**.
3. Open it → **Enable**.

### 1.3 OAuth consent screen

1. **APIs & Services** → **OAuth consent screen**.
2. Choose **External** (unless you have a Google Workspace org and want Internal).
3. Fill **App name** (e.g. "Vitality Admin"), **User support email**, **Developer contact**.
4. **Scopes** → **Add or remove scopes** → add:
   - `https://www.googleapis.com/auth/youtube.upload`
5. **Save and continue** through **Test users** (add your Google account if External).
6. **Save and continue** to the summary.

### 1.4 Create OAuth client (for refresh token)

1. **APIs & Services** → **Credentials** → **Create credentials** → **OAuth client ID**.
2. **Application type**: **Desktop app** (or **Web application** if you prefer).
3. **Name**: e.g. "Vitality YouTube Upload".
4. If you chose **Web application**, under **Authorized redirect URIs** add:
   - `https://developers.google.com/oauthplayground`
5. **Create** → copy the **Client ID** and **Client Secret** (you’ll need them in step 2 and 3).

---

## 2. Get the refresh token (one-time, via OAuth Playground)

1. Open [OAuth 2.0 Playground](https://developers.google.com/oauthplayground/).
2. Click the **settings** (gear) top right.
   - Check **Use your own OAuth credentials**.
   - **OAuth Client ID**: paste your Client ID.
   - **OAuth Client secret**: paste your Client Secret.
   - Close.
3. In the left panel, find **YouTube Data API v3** and expand it.
   - Check **https://www.googleapis.com/auth/youtube.upload** (or **youtube** if upload isn’t listed).
4. Click **Authorize APIs**.
   - Sign in with the **Google account that owns the YouTube channel** you want to upload to.
   - Approve the requested access.
5. Click **Exchange authorization code for tokens**.
6. In the right-hand response, copy **refresh_token** (long string). Save it somewhere safe; you’ll put it in `.env` next.

---

## 3. Put credentials in env

In the API project root, in **`.env`** (create or edit; this file is gitignored):

```env
# YouTube upload (same Google Cloud project as above)
YOUTUBE_CLIENT_ID=your_client_id_here
YOUTUBE_CLIENT_SECRET=your_client_secret_here
YOUTUBE_REFRESH_TOKEN=your_refresh_token_here
```

- **YOUTUBE_CLIENT_ID** = OAuth client ID from step 1.4  
- **YOUTUBE_CLIENT_SECRET** = OAuth client secret from step 1.4  
- **YOUTUBE_REFRESH_TOKEN** = refresh token from step 2  

Restart the API so it loads the new env.

---

## 4. Production (Cloud Run)

Do **not** put these values in the repo. In Cloud Run:

1. **Cloud Run** → your API service → **Edit & deploy new revision**.
2. **Variables & secrets** → add three **Secrets** (or env vars):
   - `YOUTUBE_CLIENT_ID`
   - `YOUTUBE_CLIENT_SECRET`
   - `YOUTUBE_REFRESH_TOKEN`
3. Redeploy.

---

## 5. How the app uses it

- **Backend**: `youtubeService.ts` uses `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, and `YOUTUBE_REFRESH_TOKEN` to build an OAuth2 client and call YouTube Data API `videos.insert`.
- **Frontend**: Admin Studio calls `POST /admin/upload-video` with `videoUrl`, `title`, `description`, `privacyStatus`; the API uses the service above to upload to the channel tied to the refresh token.
- **Videos** are uploaded as **private** by default; you can change to `unlisted` or `public` in the UI or API.

---

## Troubleshooting

- **"YouTube credentials missing"**  
  One of the three env vars is missing or empty. Check `.env` (local) or Cloud Run secrets (production).

- **"invalid_grant" / "Token has been expired or revoked"**  
  Refresh token was revoked (e.g. password change, or app removed in Google account). Repeat step 2 with the same OAuth client and same Google account to get a new refresh token.

- **403 / "quota exceeded"**  
  YouTube Data API has daily quota limits. Check [Google Cloud Console → APIs & Services → YouTube Data API v3 → Quotas](https://console.cloud.google.com/apis/api/youtube.googleapis.com/quotas).

- **Videos stay private**  
  For new/unverified projects, YouTube may restrict uploads to private. See [YouTube API compliance](https://developers.google.com/youtube/v3/guides/uploading_a_video) if you need public/unlisted without restriction.
