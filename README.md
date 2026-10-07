# mongo-access-admin
Web UI for managing MongoDB users, roles and database access across prod, test and dev – with an access matrix, Excel reports and an audit log.

How To Install the Mongo Access Admin GUI

Install in 5 steps

These steps install MongoDB Access Admin on a Linux server (Debian or Ubuntu) from GitHub.

Install git and get the code
bash sudo apt-get update && sudo apt-get install -y git git clone https://github.com/adamhalvars/mongo-access-admin.git cd mongo-access-admin

Run the installer
bash sudo ./deploy/install.sh --hostnames "mongoadmin.lab.local,10.0.0.50"

List the host names and IP addresses people use to reach the server. The script installs Node.js if needed and starts the app as a service. At the end it prints the address, the certificate fingerprint and a one-time setup code. Save the code.

Open the port in the firewall (if ufw is enabled)
bash sudo ufw allow 8443/tcp

Sign in for the first time Open https://:8443. The browser warns you because the certificate is self-signed. Compare the fingerprint in the certificate details with the one the installer printed, and only continue if they match. Then enter the setup code and choose a user name and password for the first admin. The password must be at least 12 characters.

Add connections and colleagues Click Connections, add your MongoDB servers and check each one with Test connection. The MongoDB account needs the userAdminAnyDatabase or root role. Then invite colleagues from your name in the top right corner, under Manage app accounts.

Update later:

bash cd mongo-access-admin && git pull && sudo ./deploy/install.sh

Settings and data are kept.

Prefer Docker? Replace step 2 with docker compose up -d --build and get the setup code with docker compose logs.

