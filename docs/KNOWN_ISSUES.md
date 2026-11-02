# Known issues

- Matchmaking state is in memory, so the server runs as a single instance; a restart drops all queued users and calls (clients must reconnect).
- OTP send limits are in memory, so a restart resets them.
- Live room state (queue, current turn) is in memory; a restart closes live rooms until members rejoin.
- Age is self-declared (date of birth); there is no ID verification.
- If MongoDB is unreachable, bans and blocks are not checked or saved; signalling keeps working.

## Launch blockers
- No video moderation; reports and bans are the only safeguards.
- Calls across different networks and real devices are untested until TURN and hosting exist.
- Older commits still contain credentials: rotate them, and purge history if wanted.
- Bans in rooms use the user id; report evidence and bans cover rooms and random chat separately because random chat has no login.
