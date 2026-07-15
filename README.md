# EasyJam Spotify Party Queue

Node.js + React app where the host connects to Spotify and guests add tracks without signing in, using a browser-specific UUID. The backend keeps guest queues separate and builds a round-robin queue that can be synchronized to Spotify.

## Getting started

1. Copy `.env.example` to `.env`.
2. Create an app in the Spotify Developer Dashboard and add this local-development Redirect URI: `http://127.0.0.1:5050/api/auth/callback`. For production, use the exact HTTPS callback configured in `SPOTIFY_REDIRECT_URI` (for example, `https://jam.jnas.fi/api/auth/callback`).
3. Set `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` in `.env`.
4. Install dependencies and start the app:

```bash
npm install
npm run dev
```

Development frontend: `http://localhost:5173`
Backend/API: `http://localhost:5050`

After `npm run build`, the Express backend also serves the built frontend at:

```text
http://localhost:5050
```

Use this single-port URL when you just want to try the app locally without relying on the separate Vite dev server.

For local development, you can also save Spotify settings from the admin panel if `.env` is missing:

```text
http://localhost:5050/admin
```

The form saves values to a local `.env` file and is restricted to localhost.
To update the OAuth redirect later, open `http://localhost:5050/admin?setup=spotify`.

Admin panel security:

- The guest view may show an admin link, but the admin panel requests an admin key when `ADMIN_ACCESS_KEY` is set.
- The admin panel always requests the admin key when `ADMIN_ACCESS_KEY` is present in `.env`.
- During local development, the admin panel can open without a key when `ADMIN_ACCESS_KEY` is missing and the request comes from localhost.
- In a public deployment, an admin key is required before Spotify OAuth login or Spotify settings can be opened.

Persistent data:

- `DATABASE_PATH` controls the location of the SQLite database.
- SQLite stores the invite link, PIN hash, guest access setting, active queue, guests and their order, manual queue ordering, blocked guest IDs, admin-pinned playlists, guests' saved Spotify playlists, and the playback history. Playback history is an append-only server-side log and is not cleared automatically. The admin panel can export the full log or a selected date range as an Excel-compatible CSV containing the requester name and type, jam ID, and UTC and server-local timestamps. `playback_observed` means EasyJam detected that a track started; it does not guarantee that the track finished.
- Spotify OAuth access tokens are still held in memory, so the admin must sign in to Spotify again after a backend restart.

OAuth settings:

- `SPOTIFY_REDIRECT_URI` is required because Spotify returns the host to this backend route after login.
- `FRONTEND_URL` is an internal fallback for redirects. The admin form derives it automatically from the current address, so users do not need to fill it in.

## Features

- Spotify Authorization Code Flow for the host.
- Guest browser UUIDs and login-free access.
- Debounced Spotify search.
- Playlist linking, localStorage persistence, and browsing.
- TuneMyMusic CSV/TXT import in the guest view: Spotify IDs from CSV files are used directly, while `Artist - Track` rows from TXT files are resolved through Spotify Search.
- Admin-pinned playlists displayed on the guest home page.
- Recommendations based on the guest's own queue.
- Host-selectable queue construction: round-robin interleaving by guest or FIFO by request time.
- Full Spotify playlist synchronization after every guest addition, removal, and admin reorder.
- Drag-and-drop manual ordering and removal in the admin panel.
- An admin guest list, activity within the last 90 seconds, and removal of individual guests or all guests. Removal clears a guest's requests but does not block them; they can rejoin with a valid invite. A separate block action prevents rejoining, and blocks can be removed from the admin panel.
- React i18n in Finnish and English, with the language preference stored in localStorage.
- QR + PIN invite flow: `/join/<token>` is always required for guest access; the admin can enable or disable the configured PIN requirement.
- The JAM Screen QR code is shown only in an invite-authorized view; open it with the JAM Screen button in the guest view.
- SQLite persistence for invite settings, the live queue, guests and blocks, saved playlists, and the server-side playback history.

## Homelab / Tailscale

The recommended private deployment is to run EasyJam in a homelab k3s cluster and publish it to a private Tailscale tailnet. Guests can then access the app only when they are on the Tailscale network or have been granted Tailscale Serve/Funnel access.

See [docs/HOMELAB_UPDATE.md](docs/HOMELAB_UPDATE.md) for instructions on deploying an updated version to a homelab.

Important homelab environment values:

```env
PORT=5050
DATABASE_PATH=/data/easyjam.sqlite
FRONTEND_URL=https://easyjam.example.com
SPOTIFY_REDIRECT_URI=https://easyjam.example.com/api/auth/callback
ADMIN_ACCESS_KEY=<pitka-admin-salasana>
```

Add exactly the same Redirect URI as `SPOTIFY_REDIRECT_URI` to the Spotify Developer Dashboard.

If the main domain is already used by another service, publish EasyJam on a separate Tailscale Serve HTTPS port:

```bash
sudo tailscale serve --bg --https=8443 http://127.0.0.1:30050
```

The EasyJam address will then be:

```text
https://your-tailnet-host.ts.net:8443
```

## Spotify API notes

Spotify has marked the Recommendations endpoint as deprecated. The app still calls it where requested, but the backend falls back to the Search API if Spotify does not allow Recommendations requests.

Public playlist browsing uses the host's OAuth token. If Spotify restricts a playlist's visibility through the API, the app surfaces Spotify's error in the UI.
