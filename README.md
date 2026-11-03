# vibezone-be

Signalling and matchmaking server for Vibezone: Express HTTP API plus a WebSocket server (`ws`) on the same port, with MongoDB (Mongoose) for accounts, private rooms, reports, blocks, bans and anonymous session stats. It needs a long-running host (see `docs/DECISIONS.md`).

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
| `NODE_ENV` | no | `production` requires `JWT_SECRET` and `OTP_SECRET` (the server refuses to start without them) and an SMS provider for login codes. |
| `JWT_SECRET` | prod | HS256 signing secret for 30-day login tokens. Outside production a random per-process secret is used. |
| `OTP_SECRET` | prod | HMAC key for stored login codes. Outside production a random per-process secret is used. |
| `SMS_API_URL`, `SMS_API_KEY` | prod | Login codes are POSTed as JSON `{to, message}` with `Authorization: Bearer <SMS_API_KEY>`. Unset outside production: the code is printed to the console. Unset in production: `POST /api/auth/otp` returns 503. |
| `TRUST_PROXY` | no | Number of reverse-proxy hops to trust for the client IP (per-IP OTP limit). Set it when running behind a proxy. |

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

All `/api/me` and `/api/rooms` routes need `Authorization: Bearer <token>`.

- `GET /health` – `{ status, mongo }`
- `POST /api/auth/otp` – `{ phone }` in E.164 (`+919876543210`) → `{ sent: true }`. 3 codes per phone and 10 per IP an hour (429). Codes last 5 minutes and allow 5 attempts.
- `POST /api/auth/verify` – `{ phone, code }` → `{ token, user }`; creates the account on first login.
- `GET /api/me` → `user = { id, name, phone, adult }`
- `PATCH /api/me` – `{ name?, dob? }` (`dob` `YYYY-MM-DD`, set once). Under 18 returns 403 and blocks the phone from rooms for good.
- `DELETE /api/me` – deletes the account and its tickets, cancels its hosted rooms (204).
- `GET /api/rooms` – upcoming and live rooms, soonest first: `{ id, name, description, hostName, startsAt, durationMin, interactionMin, tickets, ticketsLeft, booked, isHost, status }`
- `POST /api/rooms` – adults: `{ name 3-60, description ≤1000, startsAt (future ISO date), durationMin 15-180, interactionMin 1-30, tickets 1-50 }` (201)
- `POST /api/rooms/:id/book`, `DELETE /api/rooms/:id/book` – free ticket; adults only, not your own room, not a host who blocked you or whom you blocked; 409 when sold out or already booked.
- `DELETE /api/rooms/:id` – host cancels (204).
- `POST /api/rooms/:id/report` – `{ reason, userId? }`; without `userId` the host is reported.
- `GET /api/admin/reports` – latest 200 reports (room reports carry `roomId`)
- `POST /api/admin/bans` – body `{ deviceId, hours }`
- `DELETE /api/admin/bans/:deviceId`

## WebSocket protocol

Client sends `join {deviceId, tags}` first and gets `ready {iceServers}` (or `banned {until}`). After that: `offer`, `answer`, `candidate`, `networkQualityUpdate` (forwarded to the current partner only), `skip`, `block`, `report {reason}`, `leave`. The server sends `activeUsers`, `matched {partnerId, role, sharedTags}`, `partnerLeft` and `error`. Device ids are never sent to the other client.

### Private rooms

Send `roomJoin {token, roomId}` instead of `join` (host or ticket holder, from 10 minutes before `startsAt` until the room ends). The server replies `ready {iceServers}` and then `roomState` to everyone in the room on every change:

- host: `{ role: 'host', queue: [{userId, name}], current: {userId, name} | null, endsAt }`
- attendee: `{ role: 'attendee', queue: [], position: n | null, current: <self> | null, endsAt }` (only their own place, never other names)

`endsAt` is the end of the current turn. The host sends `roomNext` to end the current turn and start one with the next attendee in join order; both get `matched {role, partnerId (user id), partnerName, sharedTags: [], endsAt}`, and `offer`/`answer`/`candidate`/`networkQualityUpdate`/`chat` are forwarded as in random chat. At `endsAt` the server ends the turn and sends `partnerLeft` to both. `roomEnd` (host) closes the room; every member gets `roomClosed`, also when the room reaches its end, is cancelled, or the host deletes their account. `block` or `report {reason}` in a turn ends it and removes the attendee (who gets `roomClosed`); they can no longer book or join that host's rooms. Errors: `unauthorized`, `invalid room`, `room not found`, `room not open`, `no ticket`, `host only`, `room not started`.
