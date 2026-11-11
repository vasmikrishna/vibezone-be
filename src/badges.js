// ponytail: badges are computed from calls, the streak and referrals on each read; store them only if a badge ever needs an earned date.
const BADGES = [
  { id: 'first-call', name: 'First Hello', description: 'Have your first video call of at least a minute.', earned: (u) => (u.calls || 0) >= 1 },
  { id: 'regular', name: 'Regular', description: 'Have 10 video calls of at least a minute.', earned: (u) => (u.calls || 0) >= 10 },
  { id: 'certified', name: 'Certified Viber', description: 'Have 50 video calls of at least a minute.', earned: (u) => (u.calls || 0) >= 50 },
  { id: 'hot-streak', name: 'Hot Streak', description: 'Keep a streak of 5 days or more. You lose this badge when your streak ends.', earned: (u, s) => s.count >= 5 },
  { id: 'week-warrior', name: 'Week Warrior', description: 'Reach a best streak of 7 days.', earned: (u, s) => s.best >= 7 },
  { id: 'royalty', name: 'Vibe Royalty', description: 'Reach a best streak of 30 days.', earned: (u, s) => s.best >= 30 },
  { id: 'invite-1', name: 'Friend Bringer', description: 'Invite a friend who has a video call of at least a minute.', earned: (u) => (u.referrals || 0) >= 1 },
  { id: 'invite-5', name: 'Connector', description: 'Invite 5 friends who each have a video call of at least a minute.', earned: (u) => (u.referrals || 0) >= 5 },
  { id: 'invite-25', name: 'Ambassador', description: 'Invite 25 friends who each have a video call of at least a minute.', earned: (u) => (u.referrals || 0) >= 25 },
];

/** Every badge with earned true/false, in display order. */
const badgesView = (user, streak) =>
  BADGES.map(({ id, name, description, earned }) => ({ id, name, description, earned: earned(user, streak) }));

module.exports = { badgesView };
