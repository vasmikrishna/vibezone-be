# Signalling
## What it does
Pairs users, forwards WebRTC messages only to the current partner, stores reports, blocks and bans, and issues ICE servers. Relays filtered text chat, display names, media state and recording consent (`recordRequest`, `recordAccept`, `recordDecline`, `recordStop`, forwarded with no other fields; recordings never reach the server).
## How it works
`src/matchmaking.js` holds the in-memory queue, so run a single long-lived instance. `src/signalling.js` handles sockets. `src/routes/admin.js` exposes reports and bans behind `ADMIN_TOKEN`. `src/filter.js` masks blocked words in names and chat. Each call keeps its last 20 chat lines in memory; a report copies them into `Report.evidence`, otherwise they are dropped when the call ends.
## Tests
`pnpm test`.
## Limits
Single instance only. Bans follow a client-generated device id, so they can be evaded by resetting it. The word filter is a short English list.
