# Changelog

## Unreleased (launch-ready, #5)

- Text chat: `chat {text}` (1–500 chars, max 2 a second) is word-filtered (`src/filter.js`), forwarded to the partner and echoed as `chatSent`.
- `join` accepts an optional `name` (trimmed, 30 chars, filtered, default `Guest`); `matched` carries `partnerName`.
- The last 20 chat lines per call are kept in memory only and saved on the Report as `evidence` (sender `reporter`/`reported`) when a report is filed.
- Matchmaking moved to a tested in-memory matcher with tag preference, blocks and no immediate rematch.
- New `join` protocol with device ids, one socket per device, server-side partner forwarding.
- Reports, blocks and bans (auto 24h ban after 3 reporters in 24h), admin API, `/health`.
- Origin checks, 64KB message limit, per-socket rate limit, message validation.
- TURN support (coturn REST or static credentials).
- Removed early bird API, Vercel config and secrets from the repo; switched to pnpm; added Dockerfile.
