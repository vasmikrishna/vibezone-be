# Known issues

- Matchmaking state is in memory, so the server runs as a single instance; a restart drops all queued users and calls (clients must reconnect).
- If MongoDB is unreachable, bans and blocks are not checked or saved; signalling keeps working.

## Launch blockers
- No video moderation; reports and bans are the only safeguards.
- Calls across different networks and real devices are untested until TURN and hosting exist.
- Older commits still contain credentials: rotate them, and purge history if wanted.
