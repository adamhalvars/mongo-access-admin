// Works out the effective access per user and database.
// Walks every user's roles (built-in, custom and inherited) and merges the privileges.

const WRITE_ACTIONS = ['insert', 'update', 'remove'];
const USER_ADMIN_ACTIONS = ['createUser', 'dropUser', 'grantRole', 'revokeRole', 'createRole'];
const CLUSTER_ADMIN_ACTIONS = ['shutdown', 'setParameter', 'replSetConfigure', 'addShard', 'killop', 'fsync'];
const CLUSTER_MONITOR_ACTIONS = ['serverStatus', 'top', 'inprog', 'getLog', 'hostInfo'];

// Levels in ascending order.
const LEVELS = ['other', 'read', 'write', 'owner'];
const rank = (level) => (level ? LEVELS.indexOf(level) : -1);

function classify(actions) {
  if (!actions.size) return { level: null, dbAdmin: false, userAdmin: false };
  const read = actions.has('find');
  const write = WRITE_ACTIONS.some((a) => actions.has(a));
  const dbAdmin = actions.has('dropDatabase');
  const userAdmin = USER_ADMIN_ACTIONS.some((a) => actions.has(a));
  let level = write ? 'write' : read ? 'read' : 'other';
  if (write && dbAdmin && userAdmin) level = 'owner';
  return { level, dbAdmin, userAdmin };
}

const isSystemColl = (c) => typeof c === 'string' && c.startsWith('system.');

// Fetches the combined privileges for every role in use.
async function effectiveRoles(client, roleKeys) {
  const map = new Map();
  const chunks = [];
  for (let i = 0; i < roleKeys.length; i += 100) chunks.push(roleKeys.slice(i, i + 100));
  for (const chunk of chunks) {
    try {
      const res = await client.db('admin').command({ rolesInfo: chunk, showPrivileges: true, showBuiltinRoles: true });
      for (const r of res.roles) map.set(`${r.role}@${r.db}`, r);
    } catch (_) {
      // Ask role by role in its own database if a combined query is not allowed.
      for (const k of chunk) {
        try {
          const res = await client.db(k.db).command({ rolesInfo: { role: k.role, db: k.db }, showPrivileges: true, showBuiltinRoles: true });
          for (const r of res.roles) map.set(`${r.role}@${r.db}`, r);
        } catch (_) { /* no privilege to read the role */ }
      }
    }
  }
  return map;
}

async function buildMatrix(client, { listDbNames, allUsers }) {
  const [dbNames, users] = await Promise.all([listDbNames(client), allUsers(client)]);
  const dbs = new Set(dbNames);

  const keys = new Map();
  for (const u of users) for (const r of u.roles || []) keys.set(`${r.role}@${r.db}`, { role: r.role, db: r.db });
  const roles = await effectiveRoles(client, [...keys.values()]);
  const unknownRoles = [...keys.keys()].filter((k) => !roles.has(k));

  // Databases that are only mentioned in roles are included as columns too.
  for (const r of roles.values()) {
    for (const p of r.inheritedPrivileges || []) {
      const d = p.resource && p.resource.db;
      // Real database names cannot contain $ / \ . or spaces (filters out internal resources).
      if (d && d !== 'local' && d !== 'config' && !/[$/\\. "]/.test(d)) dbs.add(d);
    }
  }
  const databases = [...dbs].sort();

  const rows = users.map((u) => {
    const cells = {};
    const clusterActions = new Set();
    let anyResource = false;

    for (const dbName of databases) {
      const whole = new Set();
      const perColl = new Map();
      const sources = [];

      for (const ur of u.roles || []) {
        const info = roles.get(`${ur.role}@${ur.db}`);
        if (!info) continue;
        const touched = { role: ur.role, db: ur.db, builtin: !!info.isBuiltin, scopes: [] };
        for (const p of info.inheritedPrivileges || []) {
          const res = p.resource || {};
          let scope;
          if (res.anyResource) scope = { kind: 'any' };
          else if (res.cluster) continue;
          else if (res.db === dbName || res.db === '') {
            if (isSystemColl(res.collection)) continue;
            scope = res.collection
              ? { kind: 'collection', collection: res.collection, allDbs: res.db === '' }
              : { kind: res.db === '' ? 'allDbs' : 'db' };
          } else continue;

          if (scope.kind === 'collection') {
            if (!perColl.has(scope.collection)) perColl.set(scope.collection, new Set());
            p.actions.forEach((a) => perColl.get(scope.collection).add(a));
          } else {
            p.actions.forEach((a) => whole.add(a));
          }
          touched.scopes.push({ ...scope, actions: [...p.actions].sort() });
        }
        if (touched.scopes.length) sources.push(touched);
      }

      const base = classify(whole);
      let { level } = base;
      let partial = false;
      let collections = [];
      for (const [coll, acts] of perColl) {
        const merged = new Set([...whole, ...acts]);
        const c = classify(merged);
        if (rank(c.level) > rank(base.level)) collections.push({ coll, level: c.level });
      }
      if (collections.length) {
        const best = collections.reduce((m, c) => (rank(c.level) > rank(m) ? c.level : m), null);
        if (rank(best) > rank(level)) {
          level = best;
          partial = true;
          collections = collections.filter((c) => c.level === best).map((c) => c.coll).sort();
        } else collections = [];
      } else collections = [];

      if (level || sources.length) {
        cells[dbName] = {
          level,
          partial,
          collections,
          dbAdmin: base.dbAdmin,
          userAdmin: base.userAdmin,
          sources,
        };
      }
    }

    for (const ur of u.roles || []) {
      const info = roles.get(`${ur.role}@${ur.db}`);
      for (const p of (info && info.inheritedPrivileges) || []) {
        if (p.resource && p.resource.anyResource) anyResource = true;
        if (p.resource && (p.resource.cluster || p.resource.anyResource)) p.actions.forEach((a) => clusterActions.add(a));
      }
    }
    let cluster = null;
    if (anyResource) cluster = 'full';
    else if (CLUSTER_ADMIN_ACTIONS.some((a) => clusterActions.has(a))) cluster = 'admin';
    else if (CLUSTER_MONITOR_ACTIONS.some((a) => clusterActions.has(a))) cluster = 'monitor';

    return {
      user: u.user,
      db: u.db,
      roles: (u.roles || []).map((r) => ({ role: r.role, db: r.db, builtin: !!(roles.get(`${r.role}@${r.db}`) || {}).isBuiltin })),
      cells,
      cluster,
    };
  });

  rows.sort((a, b) => (a.user + '@' + a.db).localeCompare(b.user + '@' + b.db));
  return { databases, users: rows, unknownRoles };
}

// Summary per connection (used in the report).
function summarize(matrix) {
  let writers = 0, owners = 0, accessAdmins = 0, noAccess = 0;
  for (const u of matrix.users) {
    const cells = Object.values(u.cells);
    if (cells.some((c) => c.level === 'write' || c.level === 'owner')) writers++;
    if (cells.some((c) => c.level === 'owner') || u.cluster === 'full') owners++;
    if (cells.some((c) => c.userAdmin) || u.cluster === 'full') accessAdmins++;
    if (!cells.some((c) => c.level) && !u.cluster) noAccess++;
  }
  return { users: matrix.users.length, databases: matrix.databases.length, writers, owners, accessAdmins, noAccess };
}

module.exports = { buildMatrix, summarize, LEVELS };
