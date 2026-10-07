// Builds the "who has access to what" Excel report for one or more connections.
const ExcelJS = require('exceljs');
const { summarize } = require('./matrix');

const LEVEL_LABEL = { owner: 'Owner', write: 'Write', read: 'Read', other: 'Other' };
const LEVEL_FILL = { owner: 'FFE9D7FE', write: 'FFD1FADF', read: 'FFD1E9FF', other: 'FFEAECF0' };
const CLUSTER_LABEL = { full: 'Full (root)', admin: 'Admin', monitor: 'Monitor' };
const ENV_LABEL = { prod: 'Prod', test: 'Test', dev: 'Dev', other: 'Other' };
const ENV_FILL = { prod: 'FFFEE4E2', test: 'FFFEF0C7', dev: 'FFD1E9FF', other: 'FFEAECF0' };
const HEADER_FILL = 'FF1F2937';

const fill = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const thin = { style: 'thin', color: { argb: 'FFD0D5DD' } };
const border = { top: thin, left: thin, bottom: thin, right: thin };

function cellText(c) {
  if (!c || !c.level) return '';
  let t = LEVEL_LABEL[c.level];
  if (c.partial) t += ' (partial)';
  const tags = [];
  if (c.dbAdmin && c.level !== 'owner') tags.push('DB admin');
  if (c.userAdmin && c.level !== 'owner') tags.push('can grant access');
  if (tags.length) t += ' + ' + tags.join(', ');
  return t;
}

function scopeText(s) {
  if (s.kind === 'any') return 'Everything (whole server)';
  if (s.kind === 'allDbs') return 'All databases';
  if (s.kind === 'db') return 'Whole database';
  return `Collection: ${s.collection}${s.allDbs ? ' (in all databases)' : ''}`;
}

function styleHeader(row) {
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = fill(HEADER_FILL);
    cell.alignment = { vertical: 'middle', wrapText: true };
    cell.border = border;
  });
  row.height = 22;
}

function sheetName(name, used) {
  let base = name.replace(/[\[\]:*?/\\]/g, ' ').trim().slice(0, 28) || 'Connection';
  let n = base, i = 2;
  while (used.has(n.toLowerCase())) n = `${base.slice(0, 26)} ${i++}`;
  used.add(n.toLowerCase());
  return n;
}

/**
 * sections: [{ conn: {name, env, uri}, connectedAs, matrix } | { conn, error }]
 */
async function buildReport({ sections, generatedBy, generatedAt = new Date() }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'MongoDB Access Admin';
  wb.created = generatedAt;
  const used = new Set(['overview', 'details']);

  // ---------- Overview ----------
  const ov = wb.addWorksheet('Overview', { views: [{ showGridLines: false }] });
  ov.columns = [{ width: 24 }, { width: 12 }, { width: 34 }, { width: 22 }, { width: 12 }, { width: 12 }, { width: 14 }, { width: 10 }, { width: 16 }, { width: 14 }, { width: 40 }];
  ov.addRow(['MongoDB access report']).font = { bold: true, size: 16 };
  ov.addRow([`Created ${generatedAt.toLocaleString('sv-SE')} by ${generatedBy}`]).font = { color: { argb: 'FF667085' } };
  ov.addRow([]);
  styleHeader(ov.addRow(['Connection', 'Environment', 'Server', 'Signed in as', 'Users', 'Databases', 'With write access', 'Owners', 'Can grant access', 'No access', 'Status']));
  for (const s of sections) {
    const hosts = s.conn.uri.replace(/^mongodb(\+srv)?:\/\/([^@/]*@)?/, '').split(/[/?]/)[0];
    const row = s.error
      ? ov.addRow([s.conn.name, ENV_LABEL[s.conn.env] || s.conn.env, hosts, '', '', '', '', '', '', '', `Could not be read: ${s.error}`])
      : (() => {
        const sum = summarize(s.matrix);
        return ov.addRow([s.conn.name, ENV_LABEL[s.conn.env] || s.conn.env, hosts, s.connectedAs || '', sum.users, sum.databases, sum.writers, sum.owners, sum.accessAdmins, sum.noAccess,
          s.matrix.unknownRoles.length ? `OK (could not read the roles ${s.matrix.unknownRoles.join(', ')})` : 'OK']);
      })();
    row.eachCell({ includeEmpty: true }, (c) => { c.border = border; c.alignment = { vertical: 'top', wrapText: true }; });
    row.getCell(2).fill = fill(ENV_FILL[s.conn.env] || ENV_FILL.other);
    if (s.error) row.getCell(11).font = { color: { argb: 'FFB42318' } };
  }
  ov.addRow([]);
  ov.addRow(['Legend']).font = { bold: true, size: 12 };
  const legend = [
    ['Owner', 'Read, write, administer the database and grant access (e.g. dbOwner or root).', 'owner'],
    ['Write', 'Read and change data (insert, update, remove).', 'write'],
    ['Read', 'Read data (find).', 'read'],
    ['Other', 'Other privileges without being able to read data, e.g. user administration only.', 'other'],
    ['(partial)', 'Applies to some collections only, see the Details sheet.', null],
    ['+ DB admin', 'Can, among other things, drop the database (dropDatabase).', null],
    ['+ can grant access', 'Can create users and grant roles, and can therefore give itself more access.', null],
    ['Cluster', 'Privileges for the whole server: Full (root), Admin or Monitor.', null],
  ];
  for (const [k, v, lvl] of legend) {
    const r = ov.addRow([k, v]);
    ov.mergeCells(r.number, 2, r.number, 11);
    r.getCell(1).font = { bold: true };
    if (lvl) r.getCell(1).fill = fill(LEVEL_FILL[lvl]);
  }

  // ---------- One matrix per connection ----------
  for (const s of sections) {
    if (s.error) continue;
    const m = s.matrix;
    const ws = wb.addWorksheet(sheetName(s.conn.name, used), {
      views: [{ state: 'frozen', xSplit: 2, ySplit: 3 }],
      properties: { tabColor: { argb: (ENV_FILL[s.conn.env] || ENV_FILL.other) } },
    });
    const title = ws.addRow([`${s.conn.name} (${ENV_LABEL[s.conn.env] || s.conn.env})`]);
    title.font = { bold: true, size: 13 };
    ws.addRow([`Signed in as ${s.connectedAs || '–'} · ${m.users.length} users · ${m.databases.length} databases`]).font = { color: { argb: 'FF667085' } };
    const header = ws.addRow(['User', 'Auth DB', ...m.databases, 'Cluster', 'Direct roles']);
    styleHeader(header);
    ws.getColumn(1).width = 26;
    ws.getColumn(2).width = 10;
    m.databases.forEach((_, i) => { ws.getColumn(3 + i).width = 16; });
    ws.getColumn(3 + m.databases.length).width = 13;
    ws.getColumn(4 + m.databases.length).width = 50;

    for (const u of m.users) {
      const row = ws.addRow([
        u.user, u.db,
        ...m.databases.map((d) => cellText(u.cells[d])),
        CLUSTER_LABEL[u.cluster] || '',
        u.roles.map((r) => `${r.role}@${r.db}`).join(', '),
      ]);
      row.eachCell({ includeEmpty: true }, (c) => { c.border = border; c.alignment = { vertical: 'top', wrapText: true }; });
      row.getCell(1).font = { bold: true };
      m.databases.forEach((d, i) => {
        const c = u.cells[d];
        if (c && c.level) {
          const cell = row.getCell(3 + i);
          cell.fill = fill(LEVEL_FILL[c.level]);
          if (c.userAdmin) cell.font = { bold: true };
        }
      });
      if (u.cluster === 'full') row.getCell(3 + m.databases.length).fill = fill(LEVEL_FILL.owner);
    }
    ws.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3, column: 4 + m.databases.length } };
  }

  // ---------- Details ----------
  const dt = wb.addWorksheet('Details', { views: [{ state: 'frozen', ySplit: 1 }] });
  dt.columns = [
    { header: 'Connection', width: 18 }, { header: 'Environment', width: 12 },
    { header: 'User', width: 22 }, { header: 'Auth DB', width: 10 },
    { header: 'Database', width: 16 }, { header: 'Level', width: 22 },
    { header: 'Via role', width: 22 }, { header: 'Role DB', width: 10 }, { header: 'Role type', width: 10 },
    { header: 'Scope', width: 26 }, { header: 'Actions', width: 70 },
  ];
  styleHeader(dt.getRow(1));
  for (const s of sections) {
    if (s.error) continue;
    for (const u of s.matrix.users) {
      for (const d of s.matrix.databases) {
        const c = u.cells[d];
        if (!c) continue;
        for (const src of c.sources) {
          for (const sc of src.scopes) {
            const row = dt.addRow([
              s.conn.name, ENV_LABEL[s.conn.env] || s.conn.env, u.user, u.db, d, cellText(c),
              src.role, src.db, src.builtin ? 'Built-in' : 'Custom', scopeText(sc), sc.actions.join(', '),
            ]);
            row.alignment = { vertical: 'top', wrapText: true };
            if (c.level) row.getCell(6).fill = fill(LEVEL_FILL[c.level]);
          }
        }
      }
    }
  }
  dt.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 11 } };

  // Same font everywhere, and landscape printing fitted to the page width.
  for (const ws of wb.worksheets) {
    ws.pageSetup = { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } };
    ws.headerFooter = { oddFooter: '&L&8MongoDB Access Admin&C&8&A&R&8Page &P of &N' };
    ws.eachRow({ includeEmpty: true }, (row) => row.eachCell({ includeEmpty: true }, (c) => {
      c.font = { name: 'Calibri', size: 11, ...(c.font || {}) };
    }));
  }
  return wb.xlsx.writeBuffer();
}

module.exports = { buildReport };
