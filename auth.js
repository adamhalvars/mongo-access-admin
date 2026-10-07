// Sign-in for the app itself: app accounts, sessions and roles.
//
// Roles (each includes the one below):
//   admin    – everything, including connections and app accounts
//   operator – manage MongoDB users, roles and access; export reports
//   viewer   – read only: users, roles, matrix, report and audit log
//
// Accounts are stored in app-users.json in the data directory, with scrypt-hashed passwords.
// Sessions live in memory, so everyone signs in again after a restart.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const ROLES = ['viewer', 'operator', 'admin'];
const rank = (role) => ROLES.indexOf(role);
const MIN_PASSWORD = 12;
const IDLE_MS = Number(process.env.SESSION_IDLE_MINUTES || 60) * 60 * 1000;
const MAX_MS = Number(process.env.SESSION_MAX_HOURS || 12) * 3600 * 1000;
const LOCK_AFTER = 5; // failed sign-ins per user and address …
const LOCK_WINDOW_MS = 15 * 60 * 1000; // … within this window locks for the same time
const COOKIE = 'maa_session';

class AuthError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---------- Password hashing ----------

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, user) {
  const { hash } = hashPassword(password, user.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.hash, 'hex'));
}

function checkPasswordStrength(password, username) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) throw new AuthError(400, `The password must be at least ${MIN_PASSWORD} characters.`);
  if (username && password.toLowerCase().includes(String(username).toLowerCase())) throw new AuthError(400, 'The password must not contain the username.');
}

function randomPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_!%';
  return [...crypto.randomBytes(20)].map((n) => chars[n % chars.length]).join('');
}

// ---------- Account store ----------

function createStore(dataDir) {
  const file = path.join(dataDir, 'app-users.json');
  const load = () => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw new Error(`Could not read ${file}: ${err.message}`);
    }
  };
  const save = (users) => {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(users, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  const find = (username) => load().find((u) => u.username.toLowerCase() === String(username || '').toLowerCase());
  const pub = (u) => ({ username: u.username, role: u.role, mustChangePassword: !!u.mustChangePassword, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt });

  function add({ username, role, password, mustChangePassword }) {
    username = String(username || '').trim();
    if (!/^[A-Za-z0-9._@-]{2,64}$/.test(username)) throw new AuthError(400, 'The username may contain letters, digits and . _ @ - (2–64 characters).');
    if (!ROLES.includes(role)) throw new AuthError(400, 'Unknown role.');
    checkPasswordStrength(password, username);
    const users = load();
    if (users.some((u) => u.username.toLowerCase() === username.toLowerCase())) throw new AuthError(409, `An app account named "${username}" already exists.`);
    users.push({ username, role, ...hashPassword(password), mustChangePassword: !!mustChangePassword, createdAt: new Date().toISOString() });
    save(users);
  }

  function update(username, changes) {
    const users = load();
    const u = users.find((x) => x.username.toLowerCase() === String(username).toLowerCase());
    if (!u) throw new AuthError(404, 'The app account does not exist.');
    if (changes.role !== undefined) {
      if (!ROLES.includes(changes.role)) throw new AuthError(400, 'Unknown role.');
      if (u.role === 'admin' && changes.role !== 'admin' && users.filter((x) => x.role === 'admin').length === 1) throw new AuthError(400, 'There must be at least one admin.');
      u.role = changes.role;
    }
    if (changes.password !== undefined) {
      checkPasswordStrength(changes.password, u.username);
      Object.assign(u, hashPassword(changes.password));
      u.mustChangePassword = !!changes.mustChangePassword;
      u.passwordChangedAt = new Date().toISOString();
    }
    if (changes.lastLoginAt) u.lastLoginAt = changes.lastLoginAt;
    save(users);
    return u;
  }

  function remove(username) {
    const users = load();
    const u = users.find((x) => x.username.toLowerCase() === String(username).toLowerCase());
    if (!u) throw new AuthError(404, 'The app account does not exist.');
    if (u.role === 'admin' && users.filter((x) => x.role === 'admin').length === 1) throw new AuthError(400, 'The last admin cannot be deleted.');
    save(users.filter((x) => x !== u));
  }

  return { file, load, find, pub, add, update, remove };
}

// ---------- Middleware and routes ----------

/**
 * enabled: whether sign-in is required.
 * secureCookies: set the Secure flag (when served over HTTPS).
 * audit(req, action, target, details, error): writes to the audit log.
 */
function createAuth({ dataDir, enabled, secureCookies, audit }) {
  const store = createStore(dataDir);
  const sessions = new Map(); // token -> { username, created, seen }
  const failures = new Map(); // "user|ip" -> { count, first, lockedUntil }
  let setupCode = null;

  // With no app accounts, the first admin is created with a one-time code printed in the server log.
  function ensureSetupCode() {
    if (!enabled || store.load().length) { setupCode = null; return null; }
    if (!setupCode) {
      const raw = crypto.randomBytes(5).toString('hex').toUpperCase();
      setupCode = `${raw.slice(0, 5)}-${raw.slice(5)}`;
      try { fs.writeFileSync(path.join(dataDir, 'setup-code.txt'), setupCode + '\n', { mode: 0o600 }); } catch (_) { /* best effort */ }
    }
    return setupCode;
  }
  function clearSetupCode() {
    setupCode = null;
    try { fs.unlinkSync(path.join(dataDir, 'setup-code.txt')); } catch (_) { /* not there */ }
  }

  // req.ip honours 'trust proxy' (X-Forwarded-For behind a proxy/route), otherwise it is the socket address.
  const clientIp = (req) => req.ip || req.socket.remoteAddress || 'unknown';

  function readToken(req) {
    const m = /(?:^|;\s*)maa_session=([a-f0-9]{64})/.exec(req.get('cookie') || '');
    return m ? m[1] : null;
  }

  function currentUser(req) {
    if (!enabled) return { username: 'local', role: 'admin', local: true };
    const token = readToken(req);
    const s = token && sessions.get(token);
    if (!s) return null;
    const now = Date.now();
    if (now - s.seen > IDLE_MS || now - s.created > MAX_MS) { sessions.delete(token); return null; }
    const u = store.find(s.username);
    if (!u) { sessions.delete(token); return null; } // account deleted
    s.seen = now;
    return { username: u.username, role: u.role, mustChangePassword: !!u.mustChangePassword };
  }

  function setCookie(res, token, maxAgeMs) {
    const parts = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${Math.floor(maxAgeMs / 1000)}`];
    if (secureCookies) parts.push('Secure');
    res.set('Set-Cookie', parts.join('; '));
  }

  function startSession(res, username) {
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { username, created: Date.now(), seen: Date.now() });
    setCookie(res, token, MAX_MS);
  }

  function endSessionsFor(username, exceptToken) {
    for (const [t, s] of sessions) if (s.username.toLowerCase() === username.toLowerCase() && t !== exceptToken) sessions.delete(t);
  }

  function failureKey(req, username) { return `${String(username || '').toLowerCase()}|${clientIp(req)}`; }
  function checkLocked(key) {
    const f = failures.get(key);
    if (f && f.lockedUntil && f.lockedUntil > Date.now()) {
      const min = Math.ceil((f.lockedUntil - Date.now()) / 60000);
      throw new AuthError(429, `Too many failed sign-ins. Try again in ${min} minute${min === 1 ? '' : 's'}.`);
    }
  }
  function recordFailure(key) {
    const now = Date.now();
    let f = failures.get(key);
    if (!f || now - f.first > LOCK_WINDOW_MS) f = { count: 0, first: now };
    f.count++;
    if (f.count >= LOCK_AFTER) f.lockedUntil = now + LOCK_WINDOW_MS;
    failures.set(key, f);
  }

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  const router = express.Router();

  router.get('/auth/me', (req, res) => {
    const user = currentUser(req);
    res.json({ authEnabled: enabled, user, needsSetup: enabled && !store.load().length });
  });

  router.post('/auth/setup', wrap(async (req, res) => {
    if (!enabled) throw new AuthError(400, 'Sign-in is turned off.');
    if (store.load().length) throw new AuthError(409, 'The first admin has already been created.');
    const key = failureKey(req, '__setup__');
    checkLocked(key);
    const code = String(req.body.code || '').trim().toUpperCase();
    const expected = ensureSetupCode();
    const ok = code.length === expected.length && crypto.timingSafeEqual(Buffer.from(code), Buffer.from(expected));
    if (!ok) { recordFailure(key); throw new AuthError(403, 'The setup code is wrong. It is printed in the server log.'); }
    store.add({ username: req.body.username, role: 'admin', password: req.body.password });
    store.update(req.body.username, { lastLoginAt: new Date().toISOString() });
    clearSetupCode();
    req.appUser = { username: store.find(req.body.username).username };
    audit(req, 'appSetup', req.appUser.username, {});
    startSession(res, req.appUser.username);
    res.status(201).json({ ok: true });
  }));

  router.post('/auth/login', wrap(async (req, res) => {
    if (!enabled) return res.json({ ok: true });
    const username = String(req.body.username || '').trim();
    const key = failureKey(req, username);
    checkLocked(key);
    const u = store.find(username);
    // Always run the hash so a missing account takes as long as a wrong password.
    const ok = u ? verifyPassword(String(req.body.password || ''), u) : (hashPassword(String(req.body.password || '')), false);
    if (!ok) {
      recordFailure(key);
      req.appUser = { username: username || '(empty)' };
      audit(req, 'loginFailed', username || '(empty)', { ip: clientIp(req) }, new Error('Wrong username or password'));
      throw new AuthError(401, 'Wrong username or password.');
    }
    failures.delete(key);
    store.update(u.username, { lastLoginAt: new Date().toISOString() });
    startSession(res, u.username);
    req.appUser = { username: u.username };
    audit(req, 'login', u.username, { ip: clientIp(req) });
    res.json({ ok: true });
  }));

  router.post('/auth/logout', (req, res) => {
    const token = readToken(req);
    if (token) sessions.delete(token);
    setCookie(res, '', 0);
    res.json({ ok: true });
  });

  // Everything else under /api requires a signed-in user.
  function requireUser(req, res, next) {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ error: 'Please sign in.', code: 'Unauthenticated' });
    req.appUser = user;
    // Someone with a temporary password may only change it.
    if (user.mustChangePassword && !(req.method === 'POST' && req.path === '/auth/password')) {
      return res.status(403).json({ error: 'Change your temporary password first.', code: 'MustChangePassword' });
    }
    next();
  }

  const requireRole = (role) => (req, res, next) => {
    if (rank(req.appUser.role) >= rank(role)) return next();
    res.status(403).json({ error: `This requires the ${role} role in the app.`, code: 'Forbidden' });
  };

  // Routes for a signed-in user.
  const userRouter = express.Router();

  userRouter.post('/auth/password', wrap(async (req, res) => {
    if (req.appUser.local) throw new AuthError(400, 'Sign-in is turned off.');
    const u = store.find(req.appUser.username);
    if (!verifyPassword(String(req.body.current || ''), u)) throw new AuthError(400, 'The current password is wrong.');
    if (req.body.current === req.body.password) throw new AuthError(400, 'Choose a new password that differs from the current one.');
    store.update(u.username, { password: req.body.password, mustChangePassword: false });
    endSessionsFor(u.username, readToken(req));
    audit(req, 'changeAppPassword', u.username, {});
    res.json({ ok: true });
  }));

  userRouter.get('/app-users', requireRole('admin'), (req, res) => {
    res.json({ users: store.load().map(store.pub), roles: ROLES });
  });

  userRouter.post('/app-users', requireRole('admin'), wrap(async (req, res) => {
    const password = randomPassword();
    store.add({ username: req.body.username, role: req.body.role, password, mustChangePassword: true });
    audit(req, 'createAppUser', String(req.body.username).trim(), { role: req.body.role });
    res.status(201).json({ ok: true, temporaryPassword: password });
  }));

  userRouter.put('/app-users/:username', requireRole('admin'), wrap(async (req, res) => {
    const { username } = req.params;
    if (req.body.role !== undefined) {
      store.update(username, { role: req.body.role });
      audit(req, 'changeAppRole', username, { role: req.body.role });
    }
    let temporaryPassword;
    if (req.body.resetPassword) {
      temporaryPassword = randomPassword();
      store.update(username, { password: temporaryPassword, mustChangePassword: true });
      endSessionsFor(username);
      audit(req, 'resetAppPassword', username, {});
    }
    res.json({ ok: true, temporaryPassword });
  }));

  userRouter.delete('/app-users/:username', requireRole('admin'), wrap(async (req, res) => {
    const { username } = req.params;
    if (username.toLowerCase() === req.appUser.username.toLowerCase()) throw new AuthError(400, 'You cannot delete your own account.');
    store.remove(username);
    endSessionsFor(username);
    audit(req, 'deleteAppUser', username, {});
    res.json({ ok: true });
  }));

  // Creates the first admin when there are no accounts yet. Returns true if it did.
  function seedAdmin(username, password) {
    if (store.load().length) return false;
    store.add({ username, role: 'admin', password, mustChangePassword: true });
    clearSetupCode();
    return true;
  }

  return { router, requireUser, requireRole, userRouter, ensureSetupCode, seedAdmin, store, enabled };
}

module.exports = { createAuth, createStore, randomPassword, ROLES, AuthError };
