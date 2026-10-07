# MongoDB Access Admin
#   docker compose up -d --build
FROM node:22-bookworm-slim

# openssl creates the self-signed certificate on first start.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund --loglevel=error && npm cache clean --force

COPY server.js matrix.js report.js auth.js tls.js manage.js healthcheck.js ./
COPY public ./public

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8443 \
    DATA_DIR=/data \
    AUTH=on \
    TLS=selfsigned

# Connections, audit log, app accounts and certificate live in /data.
RUN mkdir -p /data && chown node:node /data
VOLUME /data

USER node
EXPOSE 8443
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["node", "healthcheck.js"]
CMD ["node", "server.js"]
