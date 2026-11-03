/**
 * Pure in-memory matcher. Entries are objects with
 * { deviceId, tags: string[], blocks: Set<deviceId>, lastPartner: deviceId|null }.
 * They are read live, so blocks added after queueing still apply.
 */
function createMatcher({ now = Date.now, waitMs = 10000 } = {}) {
  const queue = new Map(); // deviceId -> { entry, since }

  const sharedTags = (a, b) => a.tags.filter((tag) => b.tags.includes(tag));

  function allowed(a, b, t) {
    if (a.entry.deviceId === b.entry.deviceId) return false;
    if (a.entry.blocks.has(b.entry.deviceId) || b.entry.blocks.has(a.entry.deviceId)) return false;

    const waitedA = t - a.since >= waitMs;
    const waitedB = t - b.since >= waitMs;
    const previous = a.entry.lastPartner === b.entry.deviceId || b.entry.lastPartner === a.entry.deviceId;
    if (previous && !(queue.size === 2 && waitedA && waitedB)) return false;

    if (sharedTags(a.entry, b.entry).length) return true;
    return (!a.entry.tags.length || waitedA) && (!b.entry.tags.length || waitedB);
  }

  return {
    add(entry) {
      if (!queue.has(entry.deviceId)) queue.set(entry.deviceId, { entry, since: now() });
    },
    remove(deviceId) {
      queue.delete(deviceId);
    },
    has(deviceId) {
      return queue.has(deviceId);
    },
    get size() {
      return queue.size;
    },
    /** Returns { a, b, sharedTags } for the oldest matchable pair, or null. */
    next() {
      const t = now();
      for (const a of queue.values()) {
        const candidates = [...queue.values()].filter((b) => allowed(a, b, t));
        const b = candidates.find((c) => sharedTags(a.entry, c.entry).length) || candidates[0];
        if (b) {
          queue.delete(a.entry.deviceId);
          queue.delete(b.entry.deviceId);
          return { a: a.entry, b: b.entry, sharedTags: sharedTags(a.entry, b.entry) };
        }
      }
      return null;
    },
  };
}

module.exports = { createMatcher };
