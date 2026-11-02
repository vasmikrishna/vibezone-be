# Decisions

## 2026-11-02: Long-running host, not Vercel

Vercel functions are short-lived and cannot hold WebSocket connections, and matchmaking keeps the queue and active calls in process memory. The server therefore runs as one long-lived Node process (Docker image) on a VM or container host. Scaling past one instance would need a shared queue (e.g. Redis); not needed yet.

## 2026-11-02: Device ids stay on the server

Clients identify with a random device uuid used for blocks, reports and bans. Partners only see a per-call opaque id, and Sessions/Connections stats store no device id.
