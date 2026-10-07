// MongoDB Access Admin – a local web app for managing users, roles and privileges
// in one or more MongoDB environments (e.g. prod, test, dev).
require('dotenv').config({ quiet: true });
const path = require('path');
const fs = require('fs');
const os = require('os');
// os.userInfo() throws when the UID has no passwd entry (OpenShift runs containers with a random UID).
function osUser() {
  try { return os.userInfo().username; } catch { return process.env.USER || `uid ${process.getuid?.() ?? '?'}`; }
}
const crypto = require('crypto');
const express = require('express');
const { MongoClient } = require('mongodb');
const { buildMatrix } = require('./matrix');
const { buildReport } = require('./report');
const { createAuth } = require('./auth');
const { loadTls } = require('./tls');
const http = require('http');
const https = require('https');

// ---------- Settings (environment variables or .env) ----------
const HOST = process.env.HOST || '127.0.0.1';
const LOOPBACK = ['127.0.0.1', 'localhost', '::1'].includes(HOST);
const PORT = Number(process.env.PORT || (LOOPBACK ? 3000 : 8443));
// Data directory: connections, audit log, app accounts and certificate.
const DATA_DIR = path.resolve(process.env.DATA_DIR || __dirname);
fs.mkdirSync(DATA_DIR, { recursive: true });
const AUDIT_FILE = path.resolve(DATA_DIR, process.env.AUDIT_FILE || 'audit-log.jsonl');
const CONNECTIONS_FILE = path.resolve(DATA_DIR, process.env.CONNECTIONS_FILE || 'connections.json');
const ENVIRONMENTS = ['prod', 'test', 'dev', 'other'];
// Sign-in is on by default when the app listens on the network, off when it only listens on this computer.
const AUTH = (process.env.AUTH || (LOOPBACK ? 'off' : 'on')).toLowerCase() !== 'off';
// HTTPS: 'selfsigned' (default on the network), 'files' (your own certificate) or 'off'.
const TLS = (process.env.TLS || (LOOPBACK ? 'off' : 'selfsigned')).toLowerCase();

// Behind a reverse proxy or an OpenShift route that terminates HTTPS:
// TRUST_PROXY=1 trusts one proxy hop, so the client's real address (X-Forwarded-For) is used.
const TRUST_PROXY = process.env.TRUST_PROXY || '';
// Mark the session cookie Secure. On by default with HTTPS or behind a trusted proxy.
const COOKIE_SECURE = process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : (TLS !== 'off' || !!TRUST_PROXY);

if (!AUTH && !LOOPBACK) {
  console.error(`Refusing to start: AUTH=off is only allowed when HOST is 127.0.0.1 (HOST is ${HOST}).`);
  process.exit(1);
}
if (!['off', 'selfsigned', 'files'].includes(TLS)) {
  console.error(`Unknown TLS setting "${TLS}". Use selfsigned, files or off.`);
  process.exit(1);
}

// ---------- Connections ----------
// connections.json: [{ id, name, env, uri }]. The file contains passwords – it never leaves the server.

let connections = [];
const clients = new Map(); // id -> { client, ready: Promise, connectedAs }

function loadConnections() {
  try {
    connections = JSON.parse(fs.readFileSync(CONNECTIONS_FILE, 'utf8'));
    if (!Array.isArray(connections)) throw new Error('invalid format');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`Could not read ${CONNECTIONS_FILE}: ${err.message}`);
      process.exit(1);
    }
    connections = [];
    // Backwards compatible: MONGO_URI in .env becomes the first connection.
    if (process.env.MONGO_URI) {
      connections.push({ id: 'standard', name: 'Default', env: 'other', uri: process.env.MONGO_URI });
      saveConnections();
    }
  }
}

function saveConnections() {
  fs.writeFileSync(CONNECTIONS_FILE, JSON.stringify(connections, null, 2) + '\n', { mode: 0o600 });
}

// Shows the URI without the password.
function maskUri(uri) {
  return uri.replace(/^(mongodb(?:\+srv)?:\/\/)([^:@/]+)(?::[^@/]*)?@/, '$1$2:••••@');
}

function publicConnection(c) {
  const h = clients.get(c.id);
  return { id: c.id, name: c.name, env: c.env, uri: maskUri(c.uri), connectedAs: h && h.connectedAs };
}

async function whoAmI(client) {
  const status = await client.db('admin').command({ connectionStatus: 1 });
  return status.authInfo.authenticatedUsers.map((u) => `${u.user}@${u.db}`).join(', ') || null;
}

function newClient(uri) {
  // appName makes the app's own connections recognisable in MongoDB's own logs.
  return new MongoClient(uri, { serverSelectionTimeoutMS: 8000, appName: 'MongoDB Access Admin' });
}

// Connects the first time a connection is used and reuses it afterwards.
async function getClient(conn) {
  let h = clients.get(conn.id);
  if (!h) {
    const client = newClient(conn.uri);
    h = { client, connectedAs: null };
    h.ready = client.connect().then(async () => { h.connectedAs = await whoAmI(client); });
    clients.set(conn.id, h);
  }
  try {
    await h.ready;
  } catch (err) {
    clients.delete(conn.id); // so the next attempt reconnects
    h.client.close().catch(() => {});
    throw new HttpError(502, `Could not connect to "${conn.name}": ${err.message}`);
  }
  return h;
}

function dropClient(id) {
  const h = clients.get(id);
  if (h) { clients.delete(id); h.client.close().catch(() => {}); }
}

// ---------- Helpers ----------

const BUILTIN_ROLES = {
  anyDb: ['read', 'readWrite', 'dbAdmin', 'dbOwner', 'userAdmin'],
  adminOnly: [
    'readAnyDatabase', 'readWriteAnyDatabase', 'userAdminAnyDatabase', 'dbAdminAnyDatabase',
    'clusterMonitor', 'clusterManager', 'hostManager', 'clusterAdmin',
    'backup', 'restore', 'root',
  ],
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function requireStr(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `The field "${field}" is missing.`);
  return value.trim();
}

function normalizeRoles(roles) {
  if (!Array.isArray(roles) || roles.length === 0) throw new HttpError(400, 'Specify at least one role.');
  return roles.map((r) => ({ role: requireStr(r && r.role, 'role'), db: requireStr(r && r.db, 'database') }));
}

function audit(req, action, target, details, error) {
  const entry = {
    ts: new Date().toISOString(),
    connection: req.conn ? req.conn.name : undefined,
    connectionId: req.conn ? req.conn.id : undefined,
    env: req.conn ? req.conn.env : undefined,
    action,
    target,
    details: details || {},
    ok: !error,
    error: error ? String(error.message || error) : undefined,
    appUser: req.appUser ? req.appUser.username : undefined,
    actor: req.mongo ? req.mongo.connectedAs : undefined,
    osUser: osUser(),
  };
  fs.appendFile(AUDIT_FILE, JSON.stringify(entry) + '\n', { mode: 0o600 }, (err) => {
    if (err) console.error('Could not write to the audit log:', err.message);
  });
}

// Runs a write command and logs the result, whether it succeeds or not.
async function mutate(req, action, target, details, fn) {
  try {
    const result = await fn();
    audit(req, action, target, details);
    return result;
  } catch (err) {
    audit(req, action, target, details, err);
    throw err;
  }
}

async function listDbNames(client) {
  let names;
  try {
    const res = await client.db('admin').admin().listDatabases({ nameOnly: true });
    names = res.databases.map((d) => d.name);
  } catch (err) {
    // No privilege to list databases (e.g. only userAdminAnyDatabase):
    // derive the databases from the users' roles instead.
    const res = await client.db('admin').command({ usersInfo: { forAllDBs: true } });
    names = [...new Set(res.users.flatMap((u) => [u.db, ...(u.roles || []).map((r) => r.db)]))];
  }
  names = names.filter((n) => n !== 'local' && n !== 'config');
  if (!names.includes('admin')) names.unshift('admin');
  return names.sort();
}

// Walks one or more databases; skips those we lack privileges for.
async function rolesInDbs(client, dbNames, withPrivileges) {
  const out = [];
  for (const name of dbNames) {
    try {
      const res = await client.db(name).command({ rolesInfo: 1, showPrivileges: !!withPrivileges, showBuiltinRoles: false });
      out.push(...res.roles);
    } catch (_) { /* no privilege in that database */ }
  }
  return out;
}

async function allUsers(client) {
  try {
    const res = await client.db('admin').command({ usersInfo: { forAllDBs: true } });
    return res.users;
  } catch (err) {
    // Fallback if forAllDBs is not allowed: query database by database.
    const users = [];
    for (const name of await listDbNames(client)) {
      try {
        const res = await client.db(name).command({ usersInfo: 1 });
        users.push(...res.users);
      } catch (_) { /* skip */ }
    }
    if (users.length === 0) throw err;
    return users;
  }
}

function slimUser(u) {
  return {
    user: u.user,
    db: u.db,
    roles: (u.roles || []).map((r) => ({ role: r.role, db: r.db })),
    mechanisms: u.mechanisms || [],
    customData: u.customData,
  };
}

// ---------- App ----------

const app = express();
app.disable('x-powered-by');
if (TRUST_PROXY) app.set('trust proxy', /^\d+$/.test(TRUST_PROXY) ? Number(TRUST_PROXY) : TRUST_PROXY === 'true' ? true : TRUST_PROXY);
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    'Cache-Control': 'no-store',
  });
  next();
});
app.use(express.json({ limit: '200kb' }));

// Health check for Docker/monitoring. Needs no sign-in and reveals nothing.
app.get('/healthz', (req, res) => res.json({ ok: true }));

// Protects against other web pages in your browser sending requests here (CSRF).
app.use('/api', (req, res, next) => {
  if (req.method === 'GET') return next();
  const origin = req.get('origin');
  const host = req.get('host');
  if (req.get('x-requested-with') !== 'mongo-admin' || (origin && new URL(origin).host !== host)) {
    return res.status(403).json({ error: 'Request denied (wrong origin).' });
  }
  next();
});

const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);

// ----- Sign-in and roles -----
const auth = createAuth({ dataDir: DATA_DIR, enabled: AUTH, secureCookies: COOKIE_SECURE, audit: (...a) => audit(...a) });
app.use('/api', auth.router);       // /auth/me, /auth/login, /auth/setup, /auth/logout
app.use('/api', auth.requireUser);  // everything below needs a signed-in user
app.use('/api', auth.userRouter);   // own password, app accounts (admin)
// Managing connections needs the admin role; viewing them does not.
app.use('/api/connections', (req, res, next) => (req.method === 'GET' ? next() : auth.requireRole('admin')(req, res, next)));

// ----- Manage connections -----

function readConnBody(body, { requireUri }) {
  const name = requireStr(body.name, 'name');
  const env = ENVIRONMENTS.includes(body.env) ? body.env : 'other';
  const uri = typeof body.uri === 'string' ? body.uri.trim() : '';
  if (requireUri && !uri) throw new HttpError(400, 'The field "connection string" is missing.');
  if (uri && !/^mongodb(\+srv)?:\/\//.test(uri)) throw new HttpError(400, 'The connection string must start with mongodb:// or mongodb+srv://');
  return { name, env, uri };
}

app.get('/api/connections', (req, res) => {
  res.json({ connections: connections.map(publicConnection), environments: ENVIRONMENTS });
});

// Tests a connection string (or a saved connection) without saving anything.
app.post('/api/connections/test', wrap(async (req, res) => {
  let uri = typeof req.body.uri === 'string' ? req.body.uri.trim() : '';
  if (!uri && req.body.id) uri = (connections.find((c) => c.id === req.body.id) || {}).uri;
  if (!uri) throw new HttpError(400, 'Enter a connection string.');
  const client = newClient(uri);
  try {
    await client.connect();
    const connectedAs = await whoAmI(client);
    const info = await client.db('admin').command({ buildInfo: 1 });
    res.json({ ok: true, connectedAs, serverVersion: info.version });
  } catch (err) {
    throw new HttpError(400, `Connection failed: ${err.message}`);
  } finally {
    client.close().catch(() => {});
  }
}));

app.post('/api/connections', wrap(async (req, res) => {
  const { name, env, uri } = readConnBody(req.body, { requireUri: true });
  if (connections.some((c) => c.name.toLowerCase() === name.toLowerCase())) throw new HttpError(409, `A connection named "${name}" already exists.`);
  const conn = { id: crypto.randomBytes(6).toString('hex'), name, env, uri };
  connections.push(conn);
  saveConnections();
  res.status(201).json({ connection: publicConnection(conn) });
}));

app.put('/api/connections/:id', wrap(async (req, res) => {
  const conn = connections.find((c) => c.id === req.params.id);
  if (!conn) throw new HttpError(404, 'The connection does not exist.');
  const { name, env, uri } = readConnBody(req.body, { requireUri: false });
  if (connections.some((c) => c !== conn && c.name.toLowerCase() === name.toLowerCase())) throw new HttpError(409, `A connection named "${name}" already exists.`);
  conn.name = name; conn.env = env;
  if (uri) { conn.uri = uri; dropClient(conn.id); } // empty field = keep the current one
  saveConnections();
  res.json({ connection: publicConnection(conn) });
}));

app.delete('/api/connections/:id', wrap(async (req, res) => {
  const i = connections.findIndex((c) => c.id === req.params.id);
  if (i < 0) throw new HttpError(404, 'The connection does not exist.');
  dropClient(connections[i].id);
  connections.splice(i, 1);
  saveConnections();
  res.json({ ok: true });
}));

// ----- Audit log (all connections) -----

app.get('/api/audit', wrap(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 1000, 10000);
  let lines = [];
  try {
    lines = (await fs.promises.readFile(AUDIT_FILE, 'utf8')).split('\n').filter(Boolean);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const entries = lines.slice(-limit).reverse().map((l) => {
    try { return JSON.parse(l); } catch (_) { return null; }
  }).filter(Boolean);
  res.json({ entries, file: AUDIT_FILE });
}));

// ----- Excel report -----

function reportFileName(label) {
  const date = new Date().toISOString().slice(0, 10);
  const safe = label.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
  return `access-report-${safe || 'mongodb'}-${date}.xlsx`;
}

async function sectionFor(conn) {
  try {
    const h = await getClient(conn);
    const matrix = await buildMatrix(h.client, { listDbNames, allUsers });
    return { conn, connectedAs: h.connectedAs, matrix };
  } catch (err) {
    return { conn, error: err.message };
  }
}

async function sendReport(req, res, conns, label) {
  // The report contains sensitive information: require the request to come from the app's own page.
  if (req.get('x-requested-with') !== 'mongo-admin') throw new HttpError(403, 'Request denied (wrong origin).');
  const sections = [];
  for (const c of conns) sections.push(await sectionFor(c));
  const buf = await buildReport({ sections, generatedBy: osUser() });
  audit(req, 'exportReport', label, { connections: conns.map((c) => c.name) });
  const name = reportFileName(label);
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', `attachment; filename="${name}"`);
  res.set('X-Filename', name);
  res.send(Buffer.from(buf));
}

app.get('/api/report-all.xlsx', wrap(async (req, res) => {
  if (!connections.length) throw new HttpError(400, 'There are no connections.');
  await sendReport(req, res, connections, 'all-connections');
}));

// ----- Everything below runs against the connection given in the X-Connection header -----

const db = express.Router();
app.use('/api', db);

async function attachConnection(req) {
  const id = req.get('x-connection');
  if (!id) throw new HttpError(400, 'No connection selected.');
  const conn = connections.find((c) => c.id === id);
  if (!conn) throw new HttpError(404, 'The selected connection no longer exists.');
  req.conn = conn;
  req.mongo = await getClient(conn);
  req.client = req.mongo.client;
}
// Changing anything in MongoDB needs the operator role; reading needs viewer.
db.use((req, res, next) => (req.method === 'GET' ? next() : auth.requireRole('operator')(req, res, next)));
db.use((req, res, next) => { attachConnection(req).then(() => next(), next); });

db.get('/status', wrap(async (req, res) => {
  const info = await req.client.db('admin').command({ buildInfo: 1 });
  req.mongo.connectedAs = await whoAmI(req.client);
  res.json({
    connectedAs: req.mongo.connectedAs || '(no authentication)',
    authEnabled: !!req.mongo.connectedAs,
    serverVersion: info.version,
    host: req.client.options.hosts.map((h) => h.toString()).join(', '),
  });
}));

db.get('/matrix', wrap(async (req, res) => {
  res.json(await buildMatrix(req.client, { listDbNames, allUsers }));
}));

db.get('/report.xlsx', wrap(async (req, res) => {
  await sendReport(req, res, [req.conn], req.conn.name);
}));

db.get('/databases', wrap(async (req, res) => {
  res.json({ databases: await listDbNames(req.client) });
}));

db.get('/roles/catalog', wrap(async (req, res) => {
  const custom = await rolesInDbs(req.client, await listDbNames(req.client), false);
  res.json({ builtin: BUILTIN_ROLES, custom: custom.map((r) => ({ role: r.role, db: r.db })) });
}));

// ----- Users -----

db.get('/users', wrap(async (req, res) => {
  const users = (await allUsers(req.client)).map(slimUser);
  users.sort((a, b) => (a.db + a.user).localeCompare(b.db + b.user));
  res.json({ users });
}));

db.post('/users', wrap(async (req, res) => {
  const user = requireStr(req.body.user, 'username');
  const dbName = requireStr(req.body.db || 'admin', 'database');
  const pwd = requireStr(req.body.password, 'password');
  const roles = Array.isArray(req.body.roles) && req.body.roles.length ? normalizeRoles(req.body.roles) : [];
  await mutate(req, 'createUser', `${user}@${dbName}`, { roles }, () =>
    req.client.db(dbName).command({ createUser: user, pwd, roles }));
  res.status(201).json({ ok: true });
}));

db.delete('/users/:db/:user', wrap(async (req, res) => {
  const { db: dbName, user } = req.params;
  await mutate(req, 'dropUser', `${user}@${dbName}`, {}, () => req.client.db(dbName).command({ dropUser: user }));
  res.json({ ok: true });
}));

db.post('/users/:db/:user/password', wrap(async (req, res) => {
  const { db: dbName, user } = req.params;
  const pwd = requireStr(req.body.password, 'password');
  await mutate(req, 'changePassword', `${user}@${dbName}`, {}, () => req.client.db(dbName).command({ updateUser: user, pwd }));
  res.json({ ok: true });
}));

db.post('/users/:db/:user/grant', wrap(async (req, res) => {
  const { db: dbName, user } = req.params;
  const roles = normalizeRoles(req.body.roles);
  await mutate(req, 'grantRolesToUser', `${user}@${dbName}`, { roles }, () =>
    req.client.db(dbName).command({ grantRolesToUser: user, roles }));
  res.json({ ok: true });
}));

db.post('/users/:db/:user/revoke', wrap(async (req, res) => {
  const { db: dbName, user } = req.params;
  const roles = normalizeRoles(req.body.roles);
  await mutate(req, 'revokeRolesFromUser', `${user}@${dbName}`, { roles }, () =>
    req.client.db(dbName).command({ revokeRolesFromUser: user, roles }));
  res.json({ ok: true });
}));

// ----- Roles / groups -----

db.get('/roles', wrap(async (req, res) => {
  const [roles, users] = await Promise.all([
    listDbNames(req.client).then((names) => rolesInDbs(req.client, names, true)),
    allUsers(req.client),
  ]);
  const result = roles.map((r) => ({
    role: r.role,
    db: r.db,
    privileges: (r.privileges || []).map((p) => ({ resource: p.resource, actions: p.actions })),
    roles: (r.roles || []).map((x) => ({ role: x.role, db: x.db })),
    members: users
      .filter((u) => (u.roles || []).some((x) => x.role === r.role && x.db === r.db))
      .map((u) => ({ user: u.user, db: u.db })),
  }));
  result.sort((a, b) => (a.db + a.role).localeCompare(b.db + b.role));
  res.json({ roles: result });
}));

function normalizePrivileges(privs) {
  if (!Array.isArray(privs)) return [];
  return privs.map((p) => {
    const dbName = typeof p.db === 'string' ? p.db.trim() : '';
    const collection = typeof p.collection === 'string' ? p.collection.trim() : '';
    if (!Array.isArray(p.actions) || p.actions.length === 0) throw new HttpError(400, 'Each privilege needs at least one action.');
    return { resource: { db: dbName, collection }, actions: p.actions.map(String) };
  });
}

db.post('/roles', wrap(async (req, res) => {
  const role = requireStr(req.body.role, 'role name');
  const dbName = requireStr(req.body.db, 'database');
  const privileges = normalizePrivileges(req.body.privileges);
  const roles = Array.isArray(req.body.roles) && req.body.roles.length ? normalizeRoles(req.body.roles) : [];
  if (!privileges.length && !roles.length) throw new HttpError(400, 'A role needs at least one privilege or inherited role.');
  await mutate(req, 'createRole', `${role}@${dbName}`, { privileges, roles }, () =>
    req.client.db(dbName).command({ createRole: role, privileges, roles }));
  res.status(201).json({ ok: true });
}));

db.put('/roles/:db/:role/privileges', wrap(async (req, res) => {
  const { db: dbName, role } = req.params;
  const privileges = normalizePrivileges(req.body.privileges);
  await mutate(req, 'updateRolePrivileges', `${role}@${dbName}`, { privileges }, () =>
    req.client.db(dbName).command({ updateRole: role, privileges }));
  res.json({ ok: true });
}));

db.delete('/roles/:db/:role', wrap(async (req, res) => {
  const { db: dbName, role } = req.params;
  await mutate(req, 'dropRole', `${role}@${dbName}`, {}, () => req.client.db(dbName).command({ dropRole: role }));
  res.json({ ok: true });
}));

db.post('/roles/:db/:role/grant', wrap(async (req, res) => {
  const { db: dbName, role } = req.params;
  const roles = normalizeRoles(req.body.roles);
  await mutate(req, 'grantRolesToRole', `${role}@${dbName}`, { roles }, () =>
    req.client.db(dbName).command({ grantRolesToRole: role, roles }));
  res.json({ ok: true });
}));

db.post('/roles/:db/:role/revoke', wrap(async (req, res) => {
  const { db: dbName, role } = req.params;
  const roles = normalizeRoles(req.body.roles);
  await mutate(req, 'revokeRolesFromRole', `${role}@${dbName}`, { roles }, () =>
    req.client.db(dbName).command({ revokeRolesFromRole: role, roles }));
  res.json({ ok: true });
}));

// ---------- Static files and error handling ----------

app.use(express.static(path.join(__dirname, 'public')));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  // Already exists: 51002/51003 in newer MongoDB, 11000 in older
  const exists = [11000, 51002, 51003].includes(err.code) || /already exists/i.test(err.errmsg || err.message || '');
  const status = err.status || (err.codeName === 'Unauthorized' ? 403 : exists ? 409 : 400);
  res.status(status).json({ error: err.status ? err.message : (err.errmsg || err.message), code: err.codeName });
});

// ---------- Start ----------

loadConnections();
let server;
let tlsInfo = null;
if (TLS === 'off') {
  server = http.createServer(app);
} else {
  try {
    const t = loadTls({ mode: TLS, dataDir: DATA_DIR, certFile: process.env.TLS_CERT_FILE, keyFile: process.env.TLS_KEY_FILE, extraNames: process.env.TLS_HOSTNAMES });
    tlsInfo = t;
    server = https.createServer({ key: t.key, cert: t.cert, minVersion: 'TLSv1.2' }, app);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
server.listen(PORT, HOST, () => {
  const scheme = TLS === 'off' ? 'http' : 'https';
  const shown = HOST === '0.0.0.0' || HOST === '::' ? os.hostname() : HOST;
  console.log(`MongoDB Access Admin is running at ${scheme}://${shown}:${PORT}`);
  if (tlsInfo) {
    console.log(`HTTPS certificate (${TLS === 'files' ? 'your own' : 'self-signed'}${tlsInfo.created ? ', just created' : ''}): ${tlsInfo.info.subjectAltName}`);
    console.log(`  SHA-256 fingerprint: ${tlsInfo.info.sha256}`);
    console.log(`  Valid until: ${tlsInfo.info.validTo}`);
  }
  if (!AUTH) console.log('Sign-in is turned off (AUTH=off). Only use this on your own computer.');
  if (TLS === 'off' && !LOOPBACK) console.log('HTTPS is off: a proxy or OpenShift route in front of the app must provide HTTPS.');
  // The first admin can come from the environment (e.g. an OpenShift Secret) instead of the setup code.
  if (AUTH && process.env.INITIAL_ADMIN_USERNAME && process.env.INITIAL_ADMIN_PASSWORD) {
    try {
      if (auth.seedAdmin(process.env.INITIAL_ADMIN_USERNAME, process.env.INITIAL_ADMIN_PASSWORD)) {
        console.log(`Created the first admin "${process.env.INITIAL_ADMIN_USERNAME}" from INITIAL_ADMIN_USERNAME/INITIAL_ADMIN_PASSWORD. The password must be changed at the first sign-in.`);
      }
    } catch (err) {
      console.error(`Could not create the first admin from the environment: ${err.message}`);
    }
  }
  const code = auth.ensureSetupCode();
  if (code) {
    console.log('');
    console.log('No app accounts yet. Open the address above and create the first admin with this one-time setup code:');
    console.log(`  SETUP CODE: ${code}`);
    console.log('');
  }
  console.log(connections.length
    ? `Connections: ${connections.map((c) => `${c.name} (${c.env})`).join(', ')}`
    : 'No connections yet – add one in the browser.');
  console.log(`Data directory: ${DATA_DIR}`);
});
