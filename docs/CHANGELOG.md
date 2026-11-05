# Changelog

## Unreleased (recording notices, #18)

- `recordStart` replaces `recordRequest`, `recordAccept` and `recordDecline`: recording no longer asks the partner. The server forwards `recordStart` and `recordStop` to the partner with only `{ type }`; the client decides what to show (signed-in users are told, guests are not).

## Unreleased (recording consent, #16)

- New forwarded messages `recordRequest`, `recordAccept`, `recordDecline` and `recordStop` in random chat and rooms. They carry only `{ type }` (any other fields are dropped). The server only relays consent; recordings are made and saved on the recording user's device and never reach the server.

## Unreleased (camera off and on hold, #14)

- New forwarded message `mediaState { video, audio, hold }` (all booleans, otherwise `invalid mediaState`) in random chat and rooms, so the partner can show camera off, muted and on hold.

## Unreleased (friends, #12)

- Friend requests during a call: random chat and rooms accept `{ type: 'friendRequest' }` between two signed-in users (20 per user per hour, refused if either blocked the other); a mutual request auto-accepts. `matched` now carries `canAddFriend` and `friendStatus` (`none`/`requested`/`incoming`/`friends`).
- `/api/friends`: `GET /` (friends, incoming, outgoing), `GET /count`, `POST /requests/:id/accept|decline`, `DELETE /requests/:id` (cancel) and `DELETE /:userId` (remove).
- Blocking or reporting a signed-in partner and `DELETE /api/me` remove the friendships and requests involved; admin `GET /users/:id` adds `friends` (accepted count).

## Unreleased (admin dashboard API, #11)

- Admin accounts: users whose email is in `ADMIN_EMAILS` (comma-separated, case-insensitive) are admins; `/me` shows `admin: true`. `/api/admin/*` is always mounted and accepts `x-admin-token` (when `ADMIN_TOKEN` is set) or an admin's bearer token; 401 without credentials, 403 for non-admins.
- `GET /api/admin/stats`: users, live online counts, calls, reports, bans, rooms and a 14-day daily series in `STREAK_TZ`.
- Reports have `status` (open/resolved/dismissed), `resolvedAt`, `resolvedBy`; `GET /reports` is now paged (`{ items, total, page }`, `?status=`) and `PATCH /reports/:id` sets the status.
- New `GET /users` (search by `q`), `GET /users/:id`, `GET /bans`, `GET /rooms` and `POST /rooms/:id/cancel`; `DELETE /bans/:deviceId` validates the id.

## Unreleased (badges, #9)

- Badges (`src/badges.js`) are computed on each read from `calls` (calls of at least a minute, counted in `recordStreak`) and the streak; the user view now has `calls` and `badges` (6 badges, each `earned` true/false).

## Unreleased (Google sign-in and streaks, #7)

- `POST /api/auth/google` verifies a Google ID token (`GOOGLE_CLIENT_ID`; 503 when unset) and finds or creates the user by Google id. Users have a phone, a Google account, or both.
- Daily streaks (`src/streak.js`): a call of at least a minute in random chat or a room counts for the day in `STREAK_TZ` (default Asia/Kolkata); `streak` is in the user view and pushed live as a `streak` message.
- Random chat accepts an optional login token; bans by user id now apply there, and auto-bans also ban the signed-in user.
- Hosted on Fly.io (`fly.toml` for the API, `fly.db.toml` for MongoDB on a private volume). The server rebuilds user indexes on start.

## Unreleased (private rooms, #6)

- Accounts: phone OTP login (`/api/auth/otp`, `/api/auth/verify`) with 30-day HS256 JWTs; codes are 6 digits from `crypto.randomInt`, stored only as an HMAC with `OTP_SECRET`, expire after 5 minutes (TTL index) and lock after 5 attempts; 3 sends per phone and 10 per IP an hour.
- `src/sms.js`: SMS provider via `SMS_API_URL`/`SMS_API_KEY`; outside production the code is printed; production without a provider returns 503. Phone numbers are never logged.
- Profile `GET/PATCH/DELETE /api/me`: date of birth set once, under-18 rejected and the phone blocked from rooms; deletion removes tickets and cancels hosted rooms.
- Private rooms: create, list, free tickets with atomic no-overbooking, cancel, report.
- WebSocket `roomJoin`, `roomState`, `roomNext`, `roomEnd`, timed 1-to-1 turns, in-room block and report. Random matching is unchanged.
- The server refuses to start in production without `JWT_SECRET` and `OTP_SECRET`.

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
