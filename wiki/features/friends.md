# Friends and messages

## What it does

Signed-in users can add the person they are talking to as a friend during a call (random chat or a room), or for up to 10 minutes after it. Accepted friends can send each other direct messages, see when the other is online or in a call, see typing, and get unread counts and read receipts.

## How it works

Friends API (`/api/friends`, Bearer token):

- `GET /`: `friends`, `incoming` and `outgoing`. Each friend has `id`, `name`, `photo` (when set), `streak`, `since`, `online`, `inCall`, `lastSeen` (ISO or null), `unread` and `last` (`{ text, mine, at }` or null). Friends are sorted by the newest message, or by `since` when there is none.
- `GET /count`: `{ incoming, unread }`.
- `POST /requests/:id/accept`, `POST /requests/:id/decline`, `DELETE /requests/:id`, `DELETE /:userId` (unfriend).
- `GET /:userId/messages?before=<ISO date>`: `{ messages, more }`, the newest 50 before `before`, oldest first. 400 `invalid before`, 404 `not friends`.
- `POST /:userId/messages` with `{ text }`: 201 `{ message }`. 400 `invalid message`, 403 `banned`, 404 `not friends`, 429 `too many messages, try later`.
- `POST /:userId/read`: marks the friend's messages to me as read.

A message is `{ id, from, to, text, at, readAt }`. Messages are stored in the `Message` collection; `Friendship.last` keeps the newest one so the list needs no aggregation, and unread counts come from one aggregation per list request.

Friend requests during a call use the socket message `{ type: 'friendRequest' }` (see video-chat.md); a mutual request auto-accepts.

Socket (same endpoint as random chat), the `hello` mode for the signed-in app:

- `{ type: 'hello', token }` gives `welcome`, or `unauthorized` and close 1008. A socket is in one mode only: `hello`, `join` or `roomJoin`; mixing them gives `already joined`.
- The server pushes `{ type: 'message', message }` and `{ type: 'read', reader, peer, at }` to every hello socket of both users, and `{ type: 'presence', userId, online, lastSeen }` to online friends when a user's first hello socket opens or the last one closes.
- `{ type: 'typing', to }` reaches the friend as `{ type: 'typing', from }`.
- `inCall` is derived on request from the live random chat and room state.

Everything (messages, read receipts, presence, typing) goes only to accepted friends.

### Referrals / invites

- `GET /api/me/invite` (Bearer): `{ code }`, 10 random hex characters, made once on first use and stable after.
- `GET /api/invite/:code` (public): `{ name, photo? }`, the inviter's first name only. 400 bad code, 404 `invite not found` (unknown or under 18), 429 over 60 per IP an hour.
- `POST /api/auth/google` and `POST /api/auth/verify` take an optional `ref`. Only when that request creates the account and `ref` is the code of a user who is not under 18: the new user gets `invitedBy` and the two become accepted friends (requester is the inviter). Anything else is ignored; sign-in never fails because of `ref`.
- The invited user's first call of at least a minute adds 1 to the inviter's `referrals` (not for under-18 users). Badges: `invite-1`, `invite-5`, `invite-25`.
- Deleting the inviter unsets `invitedBy` on the users it invited.

## Tests

`test/friends.test.js` covers requests, accept, decline, cancel, unfriend and blocks. `test/auth.test.js` covers invite codes, the public lookup, `ref` at Google sign-in, referral counting and deletion. `test/messages.test.js` covers sending and history paging, validation and the profanity mask, 404 for non-friends and pending requests, live pushes, unread counts and read receipts, list ordering, presence, typing, the hello mode rules, message deletion and banned senders.

## Limits

- Messages are 1 to 500 characters after trimming, filtered for profanity; 600 per user per hour. A user with an active ban cannot send.
- Typing events are dropped beyond one per second per socket.
- 20 friend requests per user per hour.
- Messages between two users are deleted when the friendship is removed (unfriend, block or report) and when either account is deleted.
- Online state is in memory, so it needs a single server process.
