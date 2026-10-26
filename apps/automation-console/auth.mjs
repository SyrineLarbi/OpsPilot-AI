// Authentication for the console: scrypt password hashes, server-side sessions in PostgreSQL.
import crypto from 'node:crypto';

export const COOKIE = 'opspilot_session';
const SESSION_HOURS = 12;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export async function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await db.query(
    `INSERT INTO automation.sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(hours => $3))`,
    [sha256(token), userId, SESSION_HOURS],
  );
  await db.query('DELETE FROM automation.sessions WHERE expires_at < now()');
  return { token, maxAge: SESSION_HOURS * 3600 };
}

export function readCookie(req, name) {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

export async function currentUser(db, req) {
  const token = readCookie(req, COOKIE);
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const { rows } = await db.query(
    `SELECT u.id, u.email, u.name, u.role, u.company_id, c.name AS company_name, c.currency AS company_currency
     FROM automation.sessions s JOIN automation.users u ON u.id = s.user_id JOIN automation.companies c ON c.id = u.company_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`, [sha256(token)]);
  return rows[0] ?? null;
}

export async function destroySession(db, req) {
  const token = readCookie(req, COOKIE);
  if (token) await db.query('DELETE FROM automation.sessions WHERE token_hash = $1', [sha256(token)]);
}

export function sessionCookie(token, maxAge) {
  return `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}

/** Brute-force protection: at most `limit` failed attempts per key per window; a success clears the counter. */
export function failureLimiter(limit = 10, windowMs = 15 * 60 * 1000) {
  const fails = new Map();
  const entry = (key) => {
    const now = Date.now();
    let f = fails.get(key);
    if (!f || f.reset < now) { f = { count: 0, reset: now + windowMs }; fails.set(key, f); }
    return f;
  };
  return {
    blocked: (key) => entry(key).count >= limit,
    fail: (key) => { entry(key).count += 1; },
    clear: (key) => fails.delete(key),
  };
}
