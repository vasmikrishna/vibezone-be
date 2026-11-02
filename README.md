# vibezone-be

Signalling and matchmaking server for Vibezone: Express HTTP API plus a WebSocket server (`ws`) on the same port, with MongoDB (Mongoose) for reports, blocks, bans and anonymous session stats. It needs a long-running host (see `docs/DECISIONS.md`).

## Environment

Copy `.env.example` to `.env` and fill it in.

| Variable | Required | Description |
| --- | --- | --- |
| `MONGO_URI` | yes | MongoDB connection string. The server refuses to start without it. |
| `PORT` | no | HTTP/WebSocket port, default `3001`. |
| `ALLOWED_ORIGINS` | no | Comma-separated browser origins allowed for CORS and WebSocket upgrades. Include the web app origin plus `capacitor://localhost` (iOS) and `https://localhost` (Android) for the Capacitor apps. Requests with no `Origin` header (native clients, tests) are always allowed. |
| `ADMIN_TOKEN` | no | Enables `/api/admin/*` via the `x-admin-token` header. Unset = admin API returns 404. |
| `TURN_URLS` | no | Comma-separated TURN URLs, e.g. `turn:turn.example.com:3478`. |
| `TURN_SECRET` | no | coturn `static-auth-secret`; issues 1-hour REST credentials. |
| `TURN_USERNAME`, `TURN_CREDENTIAL` | no | Static TURN credentials, used when `TURN_SECRET` is unset. |

## Run

```sh
pnpm install
pnpm dev     # nodemon
pnpm start   # node app.js
pnpm test    # node:test; needs MongoDB at mongodb://127.0.0.1:27017 (uses vibezone_test)
```

Docker:

```sh
docker build -t vibezone-be .
docker run --env-file .env -p 3001:3001 vibezone-be
```

## HTTP

- `GET /health` – `{ status, mongo }`
- `GET /api/admin/reports` – latest 200 reports
- `POST /api/admin/bans` – body `{ deviceId, hours }`
- `DELETE /api/admin/bans/:deviceId`

## WebSocket protocol

Client sends `join {deviceId, tags}` first and gets `ready {iceServers}` (or `banned {until}`). After that: `offer`, `answer`, `candidate`, `networkQualityUpdate` (forwarded to the current partner only), `skip`, `block`, `report {reason}`, `leave`. The server sends `activeUsers`, `matched {partnerId, role, sharedTags}`, `partnerLeft` and `error`. Device ids are never sent to the other client.
