# Changelog

## Unreleased (launch-ready, #5)

- Matchmaking moved to a tested in-memory matcher with tag preference, blocks and no immediate rematch.
- New `join` protocol with device ids, one socket per device, server-side partner forwarding.
- Reports, blocks and bans (auto 24h ban after 3 reporters in 24h), admin API, `/health`.
- Origin checks, 64KB message limit, per-socket rate limit, message validation.
- TURN support (coturn REST or static credentials).
- Removed early bird API, Vercel config and secrets from the repo; switched to pnpm; added Dockerfile.
