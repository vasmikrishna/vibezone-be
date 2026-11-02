/**
 * Sends a login code. Returns false when no provider can be used (production without SMS_API_*).
 * Never logs phone numbers, and never logs a code in production.
 */
async function sendCode(env, phone, code) {
  if (env.SMS_API_URL && env.SMS_API_KEY) {
    const res = await fetch(env.SMS_API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.SMS_API_KEY}` },
      body: JSON.stringify({ to: phone, message: `Your Vibezone code is ${code}` }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`SMS provider returned ${res.status}`);
    return true;
  }
  if (env.NODE_ENV === 'production') return false;
  console.log(`[otp] dev code ${code}`);
  return true;
}

module.exports = { sendCode };
