# Signalling
## What it does
Pairs users, forwards WebRTC messages only to the current partner, stores reports, blocks and bans, and issues ICE servers.
## How it works
`src/matchmaking.js` holds the in-memory queue, so run a single long-lived instance. `src/signalling.js` handles sockets. `src/routes/admin.js` exposes reports and bans behind `ADMIN_TOKEN`.
## Tests
`pnpm test`.
## Limits
Single instance only. Bans follow a client-generated device id, so they can be evaded by resetting it.
