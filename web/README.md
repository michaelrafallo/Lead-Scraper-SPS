## Lead Scraper UI (React / Next.js)

This app provides a simple UI to:

- Authorize Google Sheets access
- Read settings from the spreadsheet `Niche Settings` tab (row 2)
- Run Apify Actor `compass/crawler-google-places`
- Write the **token-free** dataset items URL back into the `Dataset URL` column in `Niche Settings`

### Apify endpoint note (important)

You mentioned the endpoint `POST /v2/acts/compass~crawler-google-places/run-sync-get-dataset-items`.\n\nIn practice, we need the **run's `defaultDatasetId`** to write the `Dataset URL` back into your Settings row.\n\nSo the app uses the official `apify-client` to:\n\n- run the actor (waits for finish) and get a run object containing `defaultDatasetId`\n- then fetch items from that dataset\n\nThis is functionally equivalent to “run + get dataset items”, but it also reliably gives us the dataset ID needed for the `Dataset URL` cell.

### Prereqs

- Your Google OAuth client JSON is stored at repo root as `credentials.json` (already in place).
- In Google Cloud Console, ensure your OAuth client allows this redirect URI:
  - `http://localhost:3000/api/auth/callback`

### Run locally

From the `web/` folder:

```bash
npm run dev
```

Open `http://localhost:3000`, click **Authorize Google**, then click **Run scraper**.

### Optional configuration (env vars)

You can create `web/.env.local` if you want overrides:

- `APIFY_TOKEN` (optional; otherwise it reads row 2 column `Apify API Key`)
- `SPREADSHEET_ID` (defaults to your sheet)
- `NICHE_SETTINGS_TAB_NAME` (default `Niche Settings`)
- `DATASET_URL_HEADER` (default `Dataset URL`)
- `APIFY_TOKEN_HEADER` (default `Apify API Key`)
- `GOOGLE_REDIRECT_URI` (default `http://localhost:3000/api/auth/callback`)
