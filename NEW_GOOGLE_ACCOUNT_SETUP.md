# Set up backend with a new Google account (simple version)

You changed Google accounts. Do these steps once, then paste the results into your `.env` file.  
**Don’t put secrets in GitHub** — only in `.env` (on your PC) and in Cloud Run (for the live site).

---

## Part A: Make a Google Cloud project

1. Open **https://console.cloud.google.com/** and sign in with your **new** Google account.
2. At the top, click the **project name** (or “Select a project”).
3. Click **New Project**. Give it a name (e.g. `vitality`), click **Create**.
4. Turn on **billing** for this project (menu → Billing → link your project). You need this for YouTube and Cloud Run.

---

## Part B: Turn on the YouTube API

1. In Cloud Console, open the **hamburger menu** (☰) → **APIs & Services** → **Library**.
2. Search for **YouTube Data API v3**.
3. Click it, then click **Enable**.

*(If you use restaurant/places features later, you can also enable “Places API.”)*

---

## Part C: Get your Gemini key (for AI images/video)

1. Open **https://aistudio.google.com/app/apikey** (same Google account is fine).
2. Click **Create API key** (pick your new project if it asks).
3. Copy the key. You’ll paste it in Part F.

---

## Part D: Get YouTube upload keys (only if you want “push to YouTube”)

Do this only if you want the app to upload videos to your YouTube channel.

### D1. OAuth consent screen (one-time)

1. In Cloud Console: **APIs & Services** → **OAuth consent screen**.
2. Choose **External** → **Create**.
3. Fill **App name** (e.g. “Vitality Upload”), **User support email**, **Developer email** → **Save and Continue**.
4. On **Scopes**: **Add or Remove Scopes** → search `youtube.upload` → check **YouTube Data API v3 … youtube.upload** → **Update** → **Save and Continue**.
5. On **Test users**: **Add Users** → add **your** Gmail (the one that owns the YouTube channel) → **Save and Continue**.
6. **Back to Dashboard**.

### D2. Create OAuth client (get Client ID and Secret)

1. **APIs & Services** → **Credentials** → **Create Credentials** → **OAuth client ID**.
2. Application type: **Desktop app**. Name: e.g. “YouTube Upload”.
3. **Create**. A popup shows **Client ID** and **Client Secret** — copy both somewhere (you’ll need them in D3 and Part F).

### D3. Get the “refresh token” (one-time, in a browser)

1. Open **https://developers.google.com/oauthplayground/**.
2. Click the **gear icon** (top right). Check **Use your own OAuth credentials**.
3. Paste your **OAuth Client ID** and **OAuth Client secret** from D2. Close the settings.
4. In the **left list**, open **YouTube Data API v3** and check **https://www.googleapis.com/auth/youtube.upload**.
5. Click **Authorize APIs**. Sign in with the **Google account that owns your YouTube channel** and allow access.
6. Click **Exchange authorization code for tokens**.
7. On the right, find **refresh_token** (long line). Copy it — you’ll paste it in Part F.

---

## Part E: (Optional) Google Places key

Only if you use restaurant/places features:

1. **APIs & Services** → **Credentials** → **Create Credentials** → **API key**.
2. Copy the key. (You can restrict it to “Places API” later in the key’s settings.)
3. You’ll add it in Part F as `GOOGLE_PLACES_KEY`.

---

## Part F: Put everything in `.env`

On your computer, open the **API project** folder and edit the **`.env`** file (create it if it doesn’t exist). Add or update these lines (paste your real values where it says “paste…”):

```env
# Required – AI images and video
GEMINI_API_KEY=paste_your_gemini_key_here

# Required – your database and app (you already have these)
DATABASE_URL=your_existing_database_url
JWT_SECRET=your_existing_jwt_secret
PORT=3005

# Optional – only if you did Part D (YouTube upload)
YOUTUBE_CLIENT_ID=paste_client_id_from_D2
YOUTUBE_CLIENT_SECRET=paste_client_secret_from_D2
YOUTUBE_REFRESH_TOKEN=paste_refresh_token_from_D3

# Optional – only if you did Part E (Places)
GOOGLE_PLACES_KEY=paste_places_api_key_here
```

Save the file. Restart your API (stop and start `npm run dev` or whatever you use).

---

## Part G: When you deploy to the cloud (Cloud Run)

Your live API doesn’t use the `.env` file on your PC. You have to type the same values in Google Cloud:

1. Go to **Cloud Run** → click your API service → **Edit & deploy new revision**.
2. Open the **Variables & secrets** tab.
3. Add each of the same names and values (e.g. `GEMINI_API_KEY` = your key, then `YOUTUBE_CLIENT_ID`, etc.). Use **Secrets** for sensitive ones if you want.
4. Click **Deploy**.

---

## Quick checklist

- [ ] New Google Cloud project created, billing on
- [ ] YouTube Data API v3 enabled
- [ ] Gemini API key from aistudio.google.com → in `.env` as `GEMINI_API_KEY`
- [ ] (If YouTube) OAuth consent screen + OAuth client + refresh token from Playground → `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_REFRESH_TOKEN` in `.env`
- [ ] `.env` saved, API restarted
- [ ] (When deploying) Same values added in Cloud Run → Variables & secrets

---

**More detail / troubleshooting:** See **YOUTUBE_AUTH_SETUP.md** for YouTube-only steps and common errors.
