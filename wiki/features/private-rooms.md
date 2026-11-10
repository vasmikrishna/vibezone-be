# Accounts and private rooms
## What it does
Phone OTP login with JWTs, an 18+ profile, and private rooms: an adult host schedules a room with free tickets, ticket holders queue up, and the host talks 1-to-1 with each attendee for a fixed turn.
## How it works
`src/routes/auth.js` handles OTP and Google login and `/api/me` (name, date of birth, bio, and a photo kept as a JPEG data URL of at most 64 KB on the user; `photo: null` removes it); `src/sms.js` sends codes. `src/routes/rooms.js` creates, lists, books, cancels and reports rooms; booking reserves a seat with a conditional `findOneAndUpdate` and a unique `(room, user)` ticket index. `src/rooms.js` keeps live rooms in memory and reuses `send`, `forward`, `chat` and `evidence` from `src/signalling.js`, so chat filtering, rate limits and origin checks match random chat. Models: `user`, `otp` (TTL 5 minutes), `room`, `ticket`; blocks reuse `Block` with user ids. See README for the protocol.
## Tests
`test/rooms.test.js` (OTP flow and lockout, send limits, under-18, auth failures, booking race, join windows, queue, `roomNext`, automatic turn and room end via a short `minuteMs`, block, reports, cancel, account deletion). Run `pnpm test`.
## Limits
Single instance only (live rooms and OTP send limits are in memory). Tickets are free. Age is self-declared. Turns are 1-to-1, not group calls.
