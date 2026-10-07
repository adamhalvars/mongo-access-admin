// Used by Docker's HEALTHCHECK: exits 0 if the app answers on /healthz.
const tls = (process.env.TLS || 'selfsigned').toLowerCase() !== 'off';
const lib = require(tls ? 'https' : 'http');
const req = lib.get({ host: '127.0.0.1', port: process.env.PORT || 8443, path: '/healthz', rejectUnauthorized: false, timeout: 4000 },
  (res) => process.exit(res.statusCode === 200 ? 0 : 1));
req.on('error', () => process.exit(1));
req.on('timeout', () => { req.destroy(); process.exit(1); });
