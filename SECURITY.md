# Security policy

MongoDB Access Admin holds admin credentials for your MongoDB servers, so security reports are taken seriously.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private reporting instead: open the repository's **Security** tab and click **Report a vulnerability**.

Include what you found, how to reproduce it and which version or commit you tested. You will get an answer as soon as possible.

## Supported versions

Only the latest version on the `main` branch receives fixes.

## Running it safely

- Keep the app on an internal network or behind a VPN. It is not meant to face the internet.
- Use a dedicated MongoDB account with `userAdminAnyDatabase` instead of `root` where you can.
- The data directory contains the MongoDB passwords. Restrict access to it and treat backups as secret.
- See the *Security* section in the README for what the app does to protect itself.
