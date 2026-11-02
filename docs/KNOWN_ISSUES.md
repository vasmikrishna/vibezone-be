# Known issues

- Matchmaking state is in memory, so the server runs as a single instance; a restart drops all queued users and calls (clients must reconnect).
- If MongoDB is unreachable, bans and blocks are not checked or saved; signalling keeps working.
