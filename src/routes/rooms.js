const express = require('express');
const mongoose = require('mongoose');

const Room = require('../models/room');
const Ticket = require('../models/ticket');
const Block = require('../models/block');
const Report = require('../models/report');
const { REASONS } = require('../signalling');
const { filterText } = require('../filter');
const { authenticate, adult, OBJECT_ID } = require('./auth');

const intIn = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

function view(room, userId, booked) {
  return {
    id: String(room._id),
    name: room.name,
    description: room.description,
    hostName: room.hostName,
    startsAt: room.startsAt,
    durationMin: room.durationMin,
    interactionMin: room.interactionMin,
    tickets: room.tickets,
    ticketsLeft: room.tickets - room.sold,
    booked,
    isHost: String(room.host) === userId,
    status: Date.now() < room.startsAt.getTime() ? 'upcoming' : 'live',
  };
}

/** Rooms API. rooms is the live-room socket state; minuteMs scales durations (tests). */
function roomRoutes({ jwtSecret, rooms, minuteMs }) {
  const router = express.Router();
  router.use(authenticate(jwtSecret));
  router.param('id', (req, res, next, id) => {
    if (!OBJECT_ID.test(id)) return res.status(400).json({ error: 'invalid id' });
    req.roomId = new mongoose.Types.ObjectId(id);
    next();
  });
  const bookable = () => ({ status: 'scheduled', endsAt: { $gt: new Date() } });

  router.get('/', async (req, res) => {
    const userId = String(req.user._id);
    try {
      const list = await Room.find(bookable()).sort({ startsAt: 1 }).limit(100).lean();
      const booked = await Ticket.distinct('room', { user: req.user._id, room: { $in: list.map((r) => r._id) } });
      const bookedIds = new Set(booked.map(String));
      res.json(list.map((room) => view(room, userId, bookedIds.has(String(room._id)))));
    } catch {
      res.status(500).json({ error: 'database error' });
    }
  });

  router.post('/', async (req, res) => {
    const user = req.user;
    if (!adult(user)) return res.status(403).json({ error: 'adults only' });
    const { name, description = '', startsAt, durationMin, interactionMin, tickets } = req.body || {};
    const start = typeof startsAt === 'string' ? new Date(startsAt) : null;
    if (
      typeof name !== 'string' ||
      name.trim().length < 3 ||
      name.trim().length > 60 ||
      typeof description !== 'string' ||
      description.length > 1000 ||
      !(start && start.getTime() > Date.now()) ||
      !intIn(durationMin, 15, 180) ||
      !intIn(interactionMin, 1, 30) ||
      !intIn(tickets, 1, 50)
    ) {
      return res.status(400).json({
        error: 'name 3-60, description up to 1000, startsAt in the future, durationMin 15-180, interactionMin 1-30, tickets 1-50',
      });
    }
    try {
      const room = await Room.create({
        host: user._id,
        hostName: user.name || 'Host',
        name: filterText(name.trim()),
        description: filterText(description.trim()),
        startsAt: start,
        endsAt: new Date(start.getTime() + durationMin * minuteMs),
        durationMin,
        interactionMin,
        tickets,
      });
      res.status(201).json(view(room, String(user._id), false));
    } catch {
      res.status(500).json({ error: 'database error' });
    }
  });

  router.post('/:id/book', async (req, res) => {
    const user = req.user;
    if (!adult(user)) return res.status(403).json({ error: 'adults only' });
    try {
      const room = await Room.findOne({ _id: req.roomId, ...bookable() }).lean();
      if (!room) return res.status(404).json({ error: 'room not found' });
      if (room.host.equals(user._id)) return res.status(403).json({ error: 'hosts cannot book their own room' });
      if (await Block.between(String(room.host), String(user._id))) return res.status(403).json({ error: 'blocked' });
      try {
        await Ticket.create({ room: room._id, user: user._id });
      } catch (err) {
        if (err.code === 11000) return res.status(409).json({ error: 'already booked' });
        throw err;
      }
      // Conditional increment: concurrent bookings can never push sold past tickets.
      const updated = await Room.findOneAndUpdate(
        { _id: room._id, ...bookable(), $expr: { $lt: ['$sold', '$tickets'] } },
        { $inc: { sold: 1 } },
        { new: true }
      ).lean();
      if (!updated) {
        await Ticket.deleteOne({ room: room._id, user: user._id });
        return res.status(409).json({ error: 'sold out' });
      }
      res.json(view(updated, String(user._id), true));
    } catch {
      res.status(500).json({ error: 'database error' });
    }
  });

  router.delete('/:id/book', async (req, res) => {
    const user = req.user;
    try {
      const ticket = await Ticket.findOneAndDelete({ room: req.roomId, user: user._id });
      const room = ticket
        ? await Room.findOneAndUpdate({ _id: req.roomId }, { $inc: { sold: -1 } }, { new: true }).lean()
        : await Room.findById(req.roomId).lean();
      if (!room) return res.status(404).json({ error: 'room not found' });
      res.json(view(room, String(user._id), false));
    } catch {
      res.status(500).json({ error: 'database error' });
    }
  });

  router.delete('/:id', async (req, res) => {
    try {
      const room = await Room.findOneAndUpdate(
        { _id: req.roomId, host: req.user._id, status: 'scheduled' },
        { $set: { status: 'cancelled' } }
      );
      if (!room) return res.status(404).json({ error: 'room not found' });
      rooms.close(String(room._id));
      res.status(204).end();
    } catch {
      res.status(500).json({ error: 'database error' });
    }
  });

  router.post('/:id/report', async (req, res) => {
    const { reason, userId } = req.body || {};
    if (!REASONS.includes(reason) || (userId !== undefined && (typeof userId !== 'string' || !OBJECT_ID.test(userId)))) {
      return res.status(400).json({ error: `reason must be one of ${REASONS.join(', ')}; userId must be an id` });
    }
    try {
      const room = await Room.findById(req.roomId).lean();
      if (!room) return res.status(404).json({ error: 'room not found' });
      await Report.create({
        reporterDevice: String(req.user._id),
        reportedDevice: userId ? userId.toLowerCase() : String(room.host),
        reason,
        roomId: room._id,
      });
      res.status(201).json({ reported: true });
    } catch {
      res.status(500).json({ error: 'database error' });
    }
  });

  return router;
}

module.exports = roomRoutes;
