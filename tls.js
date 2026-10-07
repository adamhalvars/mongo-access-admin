// HTTPS: either your own certificate files, or a self-signed certificate that is
// created the first time with openssl and stored in the data directory.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

function localNames() {
  const names = new Set(['localhost', os.hostname()]);
  const ips = new Set(['127.0.0.1']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' || a.family === 4) ips.add(a.address);
  }
  return { names, ips };
}

function fingerprint(certPem) {
  const x = new crypto.X509Certificate(certPem);
  return { sha256: x.fingerprint256, validTo: x.validTo, subjectAltName: x.subjectAltName };
}

/**
 * mode 'files': read TLS_CERT_FILE / TLS_KEY_FILE.
 * mode 'selfsigned': use dataDir/tls/{cert,key}.pem, creating them if missing.
 * extraNames: comma separated host names / IPs to put in the certificate (TLS_HOSTNAMES).
 */
function loadTls({ mode, dataDir, certFile, keyFile, extraNames }) {
  if (mode === 'files') {
    if (!certFile || !keyFile) throw new Error('TLS=files needs TLS_CERT_FILE and TLS_KEY_FILE.');
    const cert = fs.readFileSync(certFile, 'utf8');
    return { cert, key: fs.readFileSync(keyFile, 'utf8'), info: fingerprint(cert), created: false };
  }
  const dir = path.join(dataDir, 'tls');
  const cf = path.join(dir, 'cert.pem');
  const kf = path.join(dir, 'key.pem');
  let created = false;
  if (!fs.existsSync(cf) || !fs.existsSync(kf)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const { names, ips } = localNames();
    for (const n of String(extraNames || '').split(',').map((s) => s.trim()).filter(Boolean)) {
      (/^\d{1,3}(\.\d{1,3}){3}$/.test(n) ? ips : names).add(n);
    }
    const san = [...[...names].map((n) => `DNS:${n}`), ...[...ips].map((i) => `IP:${i}`)].join(',');
    try {
      execFileSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '825',
        '-keyout', kf, '-out', cf,
        '-subj', `/CN=${os.hostname()}/O=MongoDB Access Admin`,
        '-addext', `subjectAltName=${san}`,
        '-addext', 'extendedKeyUsage=serverAuth',
      ], { stdio: 'pipe' });
    } catch (err) {
      throw new Error(`Could not create a self-signed certificate with openssl (${err.message.split('\n')[0]}). Install openssl, or set TLS=files with your own certificate.`);
    }
    fs.chmodSync(kf, 0o600);
    created = true;
  }
  const cert = fs.readFileSync(cf, 'utf8');
  return { cert, key: fs.readFileSync(kf, 'utf8'), info: fingerprint(cert), created, certPath: cf };
}

module.exports = { loadTls };
