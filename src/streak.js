const User = require('./models/user');

const STREAK_CALL_MS = 60 * 1000; // a call this long counts for the day

// ponytail: one time zone (STREAK_TZ) decides the day for everyone; per-user zones are not needed yet.
const dayKey = (date, env) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: env.STREAK_TZ || 'Asia/Kolkata' }).format(date);

/** The calendar day before a YYYY-MM-DD day. */
const previousDay = (day) => new Date(Date.parse(`${day}T00:00:00Z`) - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

/** { count, best } for display; count is 0 once a day was missed. */
function streakView(user, env, now = new Date()) {
  const s = user.streak || {};
  const today = dayKey(now, env);
  const alive = s.lastDay === today || s.lastDay === previousDay(today);
  return { count: alive ? s.count || 0 : 0, best: s.best || 0 };
}

/** Counts today for the user; returns { count, best }, or null if the user is gone or the database failed. */
async function recordStreak(userId, env, now = new Date()) {
  const today = dayKey(now, env);
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const user = await User.findById(userId, 'streak').lean();
      if (!user) return null;
      const s = user.streak || {};
      if (s.lastDay === today) return { count: s.count, best: s.best };
      const count = s.lastDay === previousDay(today) ? s.count + 1 : 1;
      const best = Math.max(count, s.best || 0);
      // Only if lastDay is still what was read, so parallel calls cannot count twice.
      const { modifiedCount } = await User.updateOne(
        { _id: userId, 'streak.lastDay': s.lastDay ?? null },
        { $set: { streak: { count, best, lastDay: today } } }
      );
      if (modifiedCount === 1) return { count, best };
    }
  } catch (err) {
    console.error('[db]', err.message);
  }
  return null;
}

module.exports = { recordStreak, streakView, dayKey, STREAK_CALL_MS };
