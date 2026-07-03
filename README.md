# Token Automation

Standalone no-auth automation system for a dashboard, backend, and browser extension.

## Flow

1. Configure Gmail API credentials in `backend/.env` (see `backend/.env.example`).
2. Start the backend on `http://localhost:5050`.
3. Start the dashboard on `http://localhost:4050`.
4. Open the dashboard **Gmails** tab and connect one or more Gmail accounts.
5. Build or watch the extension, then load `extension/dist` as an unpacked Chrome extension.
6. Open the extension side panel so it connects to the backend.
7. Open the dashboard, choose an extension, and send an order.
8. The extension automates Bitunix withdraw; when verification is required, the backend fetches the email code via Gmail API and the extension submits it.

## Commands

One-time install of all workspaces (root + backend + dashboard + extension):

```bash
npm run install:all
```

Then start everything (backend, dashboard, and extension watcher) with a single command:

```bash
npm run dev
```

`npm run dev` runs all three together with labeled output; press `Ctrl+C` once to stop them all. Build everything for production with `npm run build`.

To run a single piece in its own terminal instead:

```bash
npm run backend:dev
npm run dashboard:dev
npm run extension:dev
```

## Gmail setup

1. Create a Google Cloud project and enable the Gmail API.
2. Create OAuth 2.0 credentials (Web application).
3. Add authorized redirect URI: `http://localhost:5050/api/gmails/oauth/callback`
4. If the OAuth app is in **Testing** mode, add your Google account under **Test users**.
5. Copy client ID and secret into `backend/.env`:

```env
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=http://localhost:5050/api/gmails/oauth/callback
GOOGLE_AUTHENTICATOR_SECRET=...
DASHBOARD_URL=http://localhost:4050
```

`GOOGLE_AUTHENTICATOR_SECRET` is the base32 TOTP secret from Bitunix (Google Authenticator setup). The backend generates 6-digit codes for the extension; it is never bundled in the extension build.

Connected accounts and OAuth tokens are stored in `backend/data/gmail-accounts.json` (gitignored).

If you see authentication errors after connecting, use **Disconnect** on the Gmails tab and connect again so a fresh refresh token is issued.

## Architecture notes

- Extension and order state is in memory on the backend.
- Gmail accounts persist to `backend/data/gmail-accounts.json`.
- The extension no longer opens or scrapes Gmail; it calls `GET /api/gmails/wait-for-code?sentAt=...` after Bitunix sends the verification email.
