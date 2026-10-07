# MongoDB Access Admin

**A web UI for managing MongoDB users, roles and database access across prod, test and dev – with an access matrix, Excel reports and an audit log.**

[![CI](https://github.com/YOUR-GITHUB-USER/mongo-access-admin/actions/workflows/ci.yml/badge.svg)](https://github.com/YOUR-GITHUB-USER/mongo-access-admin/actions/workflows/ci.yml)
![Node.js 20.19+](https://img.shields.io/badge/node-%3E%3D20.19-339933?logo=node.js&logoColor=white)
![MongoDB 4.4–9.0](https://img.shields.io/badge/MongoDB-4.4%E2%80%939.0-47A248?logo=mongodb&logoColor=white)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

![The access matrix in a production connection](docs/screenshots/matrix.png)

Granting and removing access in MongoDB usually means typing `db.grantRolesToUser(...)` in a shell and hoping you picked the right auth database. MongoDB Access Admin gives you a point-and-click interface instead, shows who can actually do what in every database, and records every change.

Run it on your own computer, on a Linux server for the whole team (systemd or Docker), or on OpenShift.

## Features

- **Multiple connections** – prod, test, dev and more; switch in the top menu. Prod is unmistakably red, and every change in prod shows a warning.
- **Users** – create, delete and change passwords, with a password generator.
- **Access** – grant and remove roles per database, always with an "are you sure?" step before anything is removed.
- **Custom roles** – privileges per database or collection, inherited roles and members.
- **Access matrix** – users × databases with the *effective* access (Owner, Write, Read, Other), including custom, inherited and cluster-wide roles such as `readAnyDatabase`. Click a cell to see exactly where the access comes from.
- **Excel report** – one connection or all of them: overview, colour-coded matrix and a filterable details sheet.
- **Audit log** – every change, export and sign-in, with time, connection, target and who did it. Passwords are never logged.
- **Built-in guide** – how MongoDB access works: auth database, roles per database, built-in and custom roles, pitfalls.
- **Team mode** – app accounts with Admin, Operator and Viewer roles, HTTPS, lock-out after failed sign-ins.
- **Light and dark theme.**

| Prod is clearly marked | Where does access come from? | Built-in guide |
| --- | --- | --- |
| ![Users in a production connection, dark theme](docs/screenshots/prod-dark.png) | ![Details for one matrix cell](docs/screenshots/cell.png) | ![The guide tab](docs/screenshots/guide.png) |

## Quick start

You need **Node.js 20.19+** (or Docker) and a **self-hosted MongoDB 4.4+** account with `userAdminAnyDatabase` or `root`. MongoDB Atlas is not supported, because Atlas does not allow user and role commands over the database connection.

### On your own computer

```bash
git clone https://github.com/YOUR-GITHUB-USER/mongo-access-admin.git
cd mongo-access-admin
npm install
npm start
```

Open <http://127.0.0.1:3000>, click **Connections** and add your first server: name, environment and connection string. **Test connection** tells you right away whether it works. On your own computer the app only listens on 127.0.0.1 and needs no sign-in.

### On a Linux server (Debian/Ubuntu)

```bash
git clone https://github.com/YOUR-GITHUB-USER/mongo-access-admin.git
cd mongo-access-admin
sudo ./deploy/install.sh --hostnames "mongoadmin.example.com,10.0.0.50"
```

Open `https://<server>:8443` and create the first admin with the setup code the installer prints. Details: [Running on a Linux server](#running-on-a-linux-server).

### With Docker

```bash
git clone https://github.com/YOUR-GITHUB-USER/mongo-access-admin.git
cd mongo-access-admin
docker compose up -d --build
docker compose logs        # shows the setup code
```

### On OpenShift

```bash
oc new-project mongo-access-admin
oc apply -k openshift/
oc start-build mongo-access-admin --follow
```

Details: [Running on OpenShift](#running-on-openshift).

## Contents

- [Requirements](#requirements)
- [Getting started on your own computer](#getting-started-on-your-own-computer)
- [Running on a Linux server](#running-on-a-linux-server)
- [Running on OpenShift](#running-on-openshift)
- [Connection strings](#connection-strings)
- [How access works in MongoDB](#how-access-works-in-mongodb)
- [Security](#security)
- [Contributing](#contributing)

## Requirements

- Node.js 20.19 or newer
- Self-hosted MongoDB 4.4 or newer. MongoDB Atlas is not supported: Atlas does not allow user and role commands over the database connection, so users there are managed in the Atlas web UI.
- One MongoDB account per server with the `userAdminAnyDatabase` or `root` role.

## Getting started on your own computer

```bash
git clone https://github.com/YOUR-GITHUB-USER/mongo-access-admin.git
cd mongo-access-admin
npm install
npm start
```

Then open <http://127.0.0.1:3000>. On your own computer the app only listens on 127.0.0.1 and needs no sign-in. Click **Connections** and add your first server: name, environment and connection string. **Test connection** tells you right away whether it works.

If `npm install` fails with `UNABLE_TO_VERIFY_LEAF_SIGNATURE` (corporate proxy), first run:

```powershell
# Windows PowerShell
$env:NODE_OPTIONS="--use-system-ca"
```

```bash
# Linux/macOS
export NODE_OPTIONS="--use-system-ca"
```

### Upgrading

Run `git pull` and `npm install`, then restart. Your `.env`, `connections.json` and `audit-log.jsonl` are not in Git and are kept.

If you still have `MONGO_URI` in `.env` from the first version, it automatically becomes the connection "Default". Rename it and set the right environment under **Connections → Edit**.

## Running on a Linux server

On a server the app listens on the network, so it always requires **sign-in** and uses **HTTPS**. It creates a self-signed certificate the first time it starts. There are two ways to run it.

### Option 1: systemd service (Debian/Ubuntu)

```bash
git clone https://github.com/YOUR-GITHUB-USER/mongo-access-admin.git
cd mongo-access-admin
sudo ./deploy/install.sh --hostnames "mongoadmin.example.com,10.0.0.50"
```

`--hostnames` adds the names and IP addresses people use to reach the server to the certificate. It is optional.

The script:

- installs Node.js if needed (from the distribution, or from NodeSource if the distribution's version is too old) and openssl
- creates the system user `mongoadmin` and copies the app to `/opt/mongo-access-admin`
- creates a hardened systemd service `mongo-access-admin` that starts at boot and can only write to its data directory
- prints the address, the certificate fingerprint and the **one-time setup code** for the first admin

| What | Where |
| --- | --- |
| Settings (port, certificate, sessions) | `/etc/mongo-access-admin/env` |
| Data: connections, audit log, app accounts, certificate | `/var/lib/mongo-access-admin` |
| The app | `/opt/mongo-access-admin` |
| Log | `journalctl -u mongo-access-admin -f` |
| Restart after changing settings | `sudo systemctl restart mongo-access-admin` |

**Update:** `git pull`, then run `sudo ./deploy/install.sh` again. Settings and data are kept.

**Uninstall:** `sudo ./deploy/uninstall.sh` (keeps data) or `sudo ./deploy/uninstall.sh --purge` (deletes everything).

If the firewall is on: `sudo ufw allow 8443/tcp`.

### Option 2: Docker

```bash
git clone https://github.com/YOUR-GITHUB-USER/mongo-access-admin.git
cd mongo-access-admin
# Optional: put your server's names/IPs in TLS_HOSTNAMES in docker-compose.yml
docker compose up -d --build
docker compose logs          # shows the setup code and the certificate fingerprint
```

Data lives in the Docker volume `data` (mounted at `/data`). **Update:** `git pull`, then `docker compose up -d --build` again.

If the build fails with certificate errors behind a corporate proxy, add the company's root certificate to the build, or build on a machine outside the proxy.

### First sign-in

1. Open `https://<server>:8443`. The certificate is self-signed, so the browser warns the first time. Check that the SHA-256 fingerprint in the browser's certificate details matches the one the installer/log printed, then continue.
2. Enter the **setup code** from the installer or log, and choose a username and password for the first admin.
3. Click your name at the top right → **Manage app accounts** to add colleagues. Each new account gets a temporary password that must be changed at the first sign-in.

Lost the setup code? `sudo mongo-access-admin setup-code` (service) or `docker compose exec app node manage.js setup-code`.

### App roles

| Role | Can |
| --- | --- |
| Admin | Everything, including connections and app accounts |
| Operator | Create and delete MongoDB users, grant and remove access, manage roles, export reports |
| Viewer | Read only: users, roles, matrix, reports and the audit log |

The server enforces the roles; buttons a role cannot use are also hidden.

### Account commands on the server

```bash
# Service
sudo mongo-access-admin list-users
sudo mongo-access-admin reset-password <username>      # prints a temporary password
sudo mongo-access-admin add-user <username> admin|operator|viewer
sudo mongo-access-admin set-role <username> <role>
sudo mongo-access-admin delete-user <username>

# Docker
docker compose exec app node manage.js list-users
docker compose exec app node manage.js reset-password <username>
```

### Settings

| Setting | Default on a server | Meaning |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Address to listen on. `127.0.0.1` = this computer only |
| `PORT` | `8443` | Port |
| `DATA_DIR` | `/var/lib/mongo-access-admin` (Docker: `/data`) | Where data is stored |
| `AUTH` | `on` | Sign-in. Can only be turned off when `HOST` is `127.0.0.1` |
| `TLS` | `selfsigned` | `selfsigned`, `files` (your own certificate) or `off` (only behind a proxy that does HTTPS) |
| `TLS_HOSTNAMES` | | Extra names/IPs in the self-signed certificate. Delete `DATA_DIR/tls` and restart to recreate it |
| `TLS_CERT_FILE`, `TLS_KEY_FILE` | | Your own certificate and key (PEM) when `TLS=files` |
| `SESSION_IDLE_MINUTES` | `60` | Sign out after this long without activity |
| `SESSION_MAX_HOURS` | `12` | Sign in again after this long regardless |
| `TRUST_PROXY` | | Set when a reverse proxy sits in front (OpenShift: `1`). The client address from `X-Forwarded-For` is then used for lockout and the audit log. `1` = trust one proxy hop |
| `COOKIE_SECURE` | `true` when HTTPS or `TRUST_PROXY` is set | Send the session cookie only over HTTPS |
| `INITIAL_ADMIN_USERNAME`, `INITIAL_ADMIN_PASSWORD` | | Creates the first admin at start-up instead of the setup code (only when there are no accounts). The password must be changed at the first sign-in |

### Backup

Back up the data directory. It contains `connections.json` (with the MongoDB passwords), `audit-log.jsonl`, `app-users.json` (hashed passwords) and the certificate. Treat the backup as secret.

### Moving from your own computer

Copy `connections.json` and `audit-log.jsonl` into the data directory and give them to the service user: `sudo chown mongoadmin: /var/lib/mongo-access-admin/*.json*` (service) or `docker compose cp` (Docker).

## Running on OpenShift

Everything for OpenShift is in `openshift/`. OpenShift builds the image from your Git repo (`openshift/Containerfile`, Red Hat UBI 9 + Node.js 22) and runs it with a random user ID, read-only file system and the `restricted-v2` security policy. The route gives HTTPS with the cluster's certificate.

| File | What it is |
|---|---|
| `Containerfile` | Image build (UBI 9 Node.js 22, runs as non-root, port 8080) |
| `buildconfig.yaml`, `imagestream.yaml` | Builds the image from Git into the project |
| `deployment.yaml` | The app: 1 replica, health checks, the data volume |
| `pvc.yaml` | 1 GiB volume for connections, audit log and app accounts |
| `service.yaml`, `route.yaml` | Internal service and the HTTPS address |
| `networkpolicy.yaml` | Only the OpenShift router may reach the app |
| `initial-admin-secret.example.yaml` | Example only – not applied |
| `kustomization.yaml` | Ties it together for `oc apply -k` |

### 1. Put the code in your repo

```bash
cd mongo-access-admin
git remote add origin https://git.example.com/team/mongo-access-admin.git
git push -u origin main
```

Then change `spec.source.git.uri` (and `ref` if your branch is not `main`) in `openshift/buildconfig.yaml`, commit and push.

### 2. Create the project and deploy

```bash
oc login https://api.cluster.example.com:6443
oc new-project mongo-access-admin            # or: oc project <existing project>

# Only if the repo is private (use a personal access token / deploy token):
oc create secret generic git-credentials \
  --from-literal=username=<user> --from-literal=password=<token> \
  --type=kubernetes.io/basic-auth
#   ...and uncomment sourceSecret in openshift/buildconfig.yaml

oc apply -k openshift/
oc start-build mongo-access-admin --follow   # builds the image; the deployment starts by itself afterwards
oc rollout status deploy/mongo-access-admin
oc get route mongo-access-admin -o jsonpath='{.spec.host}{"\n"}'
```

### 3. First sign-in

Either read the one-time setup code from the log and open the route address:

```bash
oc logs deploy/mongo-access-admin | grep -A1 -i "setup code"
```

or create the first admin from a Secret **before** the first start (the password must be changed at first sign-in; delete the secret afterwards):

```bash
oc create secret generic mongo-access-admin-initial-admin \
  --from-literal=username=adam --from-literal=password='<at least 12 characters>'
oc rollout restart deploy/mongo-access-admin
```

### Day-to-day

| What | Command |
|---|---|
| Deploy a new version | `git push`, then `oc start-build mongo-access-admin --follow` (or set up the webhook in `buildconfig.yaml`) |
| Log | `oc logs -f deploy/mongo-access-admin` |
| Reset an app password | `oc exec deploy/mongo-access-admin -- node manage.js reset-password <user>` |
| List app accounts | `oc exec deploy/mongo-access-admin -- node manage.js list-users` |
| Back up the data | `for f in connections.json app-users.json audit-log.jsonl; do oc exec deploy/mongo-access-admin -- cat /data/$f > $f; done` (treat the files as secret) |
| Move data in (e.g. from your own computer) | `oc exec -i deploy/mongo-access-admin -- sh -c 'cat > /data/connections.json' < connections.json` (same for `audit-log.jsonl`), then `oc rollout restart deploy/mongo-access-admin` |
| Remove everything | `oc delete -k openshift/` (also deletes the volume and its data) |

### Good to know

- **One replica only.** Sessions are kept in memory and the data lives on a `ReadWriteOnce` volume, so do not scale up. The deployment uses `Recreate` so the old pod stops before the new one starts.
- **The pod must reach MongoDB.** Use the MongoDB service name if it runs in the cluster (`mongodb://user:pw@mongodb.db-project.svc:27017/?authSource=admin`), otherwise its host name. If your cluster restricts outgoing traffic (egress policy / firewall), open the MongoDB port.
- **No internet during the build?** Set the `NPM_REGISTRY` build argument in `buildconfig.yaml` to your internal npm mirror (Nexus/Artifactory). If `registry.access.redhat.com` is blocked, change the two `FROM` lines in the Containerfile to your mirror.
- **Building in CI instead** (GitLab CI, GitHub Actions, Tekton): build `openshift/Containerfile` with the repo root as context, push the image to your registry, remove `buildconfig.yaml` and `imagestream.yaml` from `kustomization.yaml`, remove the trigger annotation from `deployment.yaml` and set the image with the `images:` block in `kustomization.yaml`.
- **Limit who can open it:** uncomment `haproxy.router.openshift.io/ip_whitelist` in `route.yaml`.
- **Own host name:** set `spec.host` in `route.yaml`.
- `networkpolicy.yaml` assumes the default OpenShift router label. If the route answers with "Application is not available", check it first: `oc delete networkpolicy mongo-access-admin-allow-from-router`.

## Connection strings

```
mongodb://admin:password@server:27017/?authSource=admin
mongodb+srv://admin:password@cluster.example.com/?authSource=admin
```

Special characters in the password must be URL-encoded, for example `@` → `%40` and `:` → `%3A`.

## How access works in MongoDB

- A user is created in an **auth database** (usually `admin`). That is where they sign in, whatever databases they are later given access to.
- Access is granted as **role + database**, e.g. `readWrite` on `shop`.
- Roles such as `readAnyDatabase` and `root` apply to the whole cluster and are always granted on `admin`.
- A **custom role** works as a group: define the privileges once and add users as members.
- Changes take effect immediately, even for users who are already signed in.

The **Guide** tab in the app explains this in more detail.

## How the matrix levels are calculated

| Level | Meaning |
| --- | --- |
| Owner | Can read, write, administer the database and grant access (e.g. `dbOwner`, `root`) |
| Write | Can read and change data (`insert`, `update`, `remove`) |
| Read | Can read data (`find`) |
| Other | Has privileges but cannot read data, e.g. only `userAdmin` |
| +DB admin | Can also drop the database (`dropDatabase`) |
| +access | Can also create users and grant roles, and can therefore give itself more access |

System collections (`system.*`) are not counted. The Cluster column shows privileges for the whole server: Full (`root`), Admin or Monitor.

## Security

- **`connections.json` contains the passwords to all your servers in plain text.** It stays on your computer, is never sent to the browser (where the password is shown as `••••`) and is excluded in `.gitignore`. Do not share it, and preferably give the app its own account with `userAdminAnyDatabase` instead of `root`.
- On your own computer the app only listens on `127.0.0.1`. On a server (`HOST=0.0.0.0`) it refuses to start without sign-in, and uses HTTPS by default.
- App passwords are hashed with scrypt. Sessions use a cookie that JavaScript cannot read (`HttpOnly`, `Secure`, `SameSite=Strict`) and end after 60 minutes without activity. After 5 failed sign-ins for the same account from the same address, sign-in is locked for 15 minutes.
- The service runs as its own user without privileges and can only write to its data directory.
- Requests that change something must come from the app's own page, so other web pages in your browser cannot send changes behind your back.
- Removing access, members and inherited roles requires a confirmation. Deleting users and roles requires typing the name. The account the app itself is signed in with is marked **you**, and you are warned before removing its access.

## Files

| File | Contents |
| --- | --- |
| `server.js` | Backend (Express + the MongoDB driver) |
| `matrix.js` | Works out the effective access per user and database |
| `report.js` | Builds the Excel report |
| `auth.js` | Sign-in, sessions and app roles |
| `tls.js` | HTTPS certificate |
| `manage.js` | Command line tool for app accounts |
| `healthcheck.js` | Health check for Docker |
| `deploy/install.sh`, `deploy/uninstall.sh` | Install/remove as a systemd service |
| `Dockerfile`, `docker-compose.yml` | Run with Docker |
| `openshift/` | Containerfile and manifests for OpenShift (see *Running on OpenShift*) |
| `docs/screenshots/` | Screenshots used in this README |
| `.github/workflows/ci.yml` | GitHub Actions: syntax check, start test, shellcheck, image builds |
| `LICENSE`, `SECURITY.md` | MIT license and how to report security problems |
| `public/index.html` | The whole interface |
| `.env.example` | Template for optional settings |
| `connections.json` | Created automatically; your connections |
| `audit-log.jsonl` | Created automatically; the audit log for all connections |
| `app-users.json` | Created automatically on a server; app accounts |

## Contributing

Issues and pull requests are welcome. Please do not post connection strings, passwords or audit logs in issues. To report a security problem, see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
