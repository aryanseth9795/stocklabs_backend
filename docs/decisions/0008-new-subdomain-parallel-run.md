# 0008 — New subdomain, Let's Encrypt, parallel run before cutover

**Status:** accepted, 2026-08-17

## Context

Production is `https://stocklabs-server.onrender.com`, baked into both clients. The new stack needs a
public address. Either the existing host's DNS is repointed at the VM (no client change, but the
switch is DNS-timed and irreversible on a propagation delay), or a new name is issued and the clients
are moved deliberately.

TLS is not optional: `NODE_ENV=production` sets cookies `secure: true, sameSite: "none"`, so over
plain HTTP the browser silently drops the session cookie and every web login becomes a 401 loop with
no error anywhere.

## Decision

A new subdomain (e.g. `api.aryantechie.in`) with Let's Encrypt certificates issued and renewed by a
Certbot sidecar. The new stack runs **in parallel** with Render, is validated against real behaviour,
and only then do the clients move. Render stays up as an instant rollback.

## Consequences

- **Rollback is repointing the clients, not restoring a backup.** The old stack never stops working
  during the transition.
- **Both hosts must accept the web origin at once.** `CORS_ORIGINS` on the new stack and the Render
  configuration both need the production web origin during the overlap.
- **The web client requires a rebuild, not an env edit.** `NEXT_PUBLIC_API_URL` is inlined at build
  time, so changing `Frontend/.env.local` alone does nothing.
- **Mobile moves via EAS Update, not a store release.** Set `EXPO_PUBLIC_SERVER_URL` in `eas.json`
  (absent from every profile today) and ship an OTA update against the channel in `app.json`.
- **Fix `App/src/config/index.ts` first.** Its production default is
  `https://stocklabs-backend.onrender.com` — which is *not* where production actually is
  (`stocklabs-server.onrender.com`). Any EAS build without an explicit env var ships the wrong host
  today, and that latent bug will be blamed on the migration if it is not fixed before it.
- **Render must stay up until OTA adoption is high.** Installed apps that have not picked up the
  update keep hitting the old host.
- **Same-site improves as a side effect.** Moving the API onto the same registrable domain as the web
  app makes the cookie same-site, where today it is cross-site and depends on `SameSite=None`.
- **Certificate issuance must be rehearsed against Let's Encrypt staging first.** The duplicate
  certificate limit is five per week and a typo'd domain in a retry loop burns it quickly.
- **Two pre-flight checks gate everything**, because they can invalidate the whole plan: Binance spot
  WebSocket reachability from the VM's egress IP (measured by *messages received*, not by a
  successful handshake), and reachability of the third-party commodity feed. See the
  [runbook](../runbook.md).
