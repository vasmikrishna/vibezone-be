# Decisions

## 2026-11-02: Long-running host, not Vercel

Vercel functions are short-lived and cannot hold WebSocket connections, and matchmaking keeps the queue and active calls in process memory. The server therefore runs as one long-lived Node process (Docker image) on a VM or container host. Scaling past one instance would need a shared queue (e.g. Redis); not needed yet.

## 2026-11-02: Device ids stay on the server

Clients identify with a random device uuid used for blocks, reports and bans. Partners only see a per-call opaque id, and Sessions/Connections stats store no device id.

## 2026-11-02: Free tickets first

Room tickets are free; there is no payment provider yet. Booking only reserves a seat (`Room.sold` is incremented with a conditional `findOneAndUpdate`, so concurrent bookings cannot oversell). Payments can be added in front of `POST /api/rooms/:id/book` later.

## 2026-11-02: Rooms are 1-to-1 turns, not group calls

A room is a queue: the host talks to one attendee at a time for `interactionMin`, in join order, using the same peer-to-peer WebRTC signalling as random chat. Group calls would need an SFU (media server) and a different moderation story; turns need no new infrastructure. Live room state is in memory, like matchmaking.

## 2026-11-02: Phone OTP accounts with our own JWTs

Rooms need a stable identity for tickets, blocks and age checks, so they use phone login instead of device ids (random chat still uses device ids). Tokens are HS256 JWTs signed with `JWT_SECRET` (algorithm pinned on verify); no third-party auth. A phone that gave an under-18 date of birth keeps only that flag after account deletion so a new account cannot unlock rooms.
