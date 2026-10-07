#!/usr/bin/env node
// Command line tool for app accounts, run on the server.
//
//   node manage.js list-users
//   node manage.js add-user <username> [admin|operator|viewer]
//   node manage.js reset-password <username>
//   node manage.js set-role <username> <admin|operator|viewer>
//   node manage.js delete-user <username>
//   node manage.js setup-code
//
// New and reset accounts get a temporary password that must be changed at the first sign-in.
// Uses the same DATA_DIR as the server (environment variable or .env).
require('dotenv').config({ quiet: true });
const path = require('path');
const fs = require('fs');
const { createStore, randomPassword, ROLES } = require('./auth');

const dataDir = path.resolve(process.env.DATA_DIR || __dirname);
const store = createStore(dataDir);
const [cmd, a, b] = process.argv.slice(2);

function usage() {
  console.log(`Usage:
  node manage.js list-users
  node manage.js add-user <username> [${ROLES.join('|')}]   (default: viewer)
  node manage.js reset-password <username>
  node manage.js set-role <username> <${ROLES.join('|')}>
  node manage.js delete-user <username>
  node manage.js setup-code

Data directory: ${dataDir}`);
}

function warnOwner() {
  // The server runs as its own user; files created here must stay readable for it.
  if (process.getuid && process.getuid() === 0) {
    console.log('Note: you are running as root. Run as the service user so the files keep the right owner, e.g.');
    console.log('  sudo -u mongoadmin env DATA_DIR=... node manage.js …   (the installed wrapper "mongo-access-admin" does this for you)');
  }
}

try {
  switch (cmd) {
    case 'list-users': {
      const users = store.load();
      if (!users.length) { console.log('No app accounts yet.'); break; }
      for (const u of users) console.log(`${u.username.padEnd(24)} ${u.role.padEnd(9)} ${u.mustChangePassword ? 'temporary password  ' : '                    '}last sign-in: ${u.lastLoginAt || 'never'}`);
      break;
    }
    case 'add-user': {
      if (!a) { usage(); process.exit(1); }
      warnOwner();
      const password = randomPassword();
      store.add({ username: a, role: b || 'viewer', password, mustChangePassword: true });
      console.log(`Created ${a} (${b || 'viewer'}). Temporary password, must be changed at first sign-in:\n  ${password}`);
      break;
    }
    case 'reset-password': {
      if (!a) { usage(); process.exit(1); }
      warnOwner();
      const password = randomPassword();
      store.update(a, { password, mustChangePassword: true });
      console.log(`New temporary password for ${a} (must be changed at sign-in):\n  ${password}`);
      console.log('Restart the service to sign out any open sessions for this account.');
      break;
    }
    case 'set-role': {
      if (!a || !b) { usage(); process.exit(1); }
      store.update(a, { role: b });
      console.log(`${a} now has the role ${b}.`);
      break;
    }
    case 'delete-user': {
      if (!a) { usage(); process.exit(1); }
      store.remove(a);
      console.log(`Deleted ${a}.`);
      break;
    }
    case 'setup-code': {
      const f = path.join(dataDir, 'setup-code.txt');
      if (store.load().length) console.log('The first admin already exists, so there is no setup code.');
      else if (fs.existsSync(f)) console.log(`Setup code: ${fs.readFileSync(f, 'utf8').trim()}`);
      else console.log('No setup code yet. Start the server once; it creates one.');
      break;
    }
    default:
      usage();
      process.exit(cmd ? 1 : 0);
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
