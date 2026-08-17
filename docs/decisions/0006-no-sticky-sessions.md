# 0006 — No sticky sessions

**Status:** accepted, 2026-08-17

## Context

Socket.IO behind a load balancer is the classic case for session affinity. Its default transport
sequence starts with HTTP long-polling: several separate HTTP requests carry the same `sid`, and if
two of them land on different replicas you get an intermittent `400 Session ID unknown` loop.

[0005](./0005-nginx-dns-resolver-load-balancing.md) also makes `ip_hash` unavailable — it cannot be
used with a variable `proxy_pass`.

## Decision

No stickiness. Plain round-robin across replicas.

## Consequences

This is safe, but only because of a specific set of facts. All of them have to stay true:

1. **Both clients are websocket-only.** The web app (`Frontend/src/lib/socket.ts`) and the Expo app
   (`App/src/context/SocketContext.tsx`) both pass `transports: ["websocket"]`. A websocket-only
   client makes exactly one HTTP request — the Upgrade — and then holds one connection. The
   multi-request handshake that needs affinity never happens.
2. **The Socket.IO Redis adapter is installed**, so room broadcasts, `fetchSockets()` and
   `disconnectSockets()` work across replicas.
3. **The OTP store is in Redis**, so the two-step password reset can hit different replicas.
4. **Auth is stateless** — a JWT verified per request and per socket handshake. No server-side
   session store.
5. **Per-socket pollers** live and die with the connection they belong to.
6. **SSE is one long-lived GET**, so the client is naturally pinned for its duration, and every
   replica has an equivalent Redis-fed price cache.

**If HTTP long-polling is ever enabled on any client, this breaks** — as intermittent
`400 Session ID unknown` errors that will look like a network problem. The fix at that point is
either a sticky strategy (which means abandoning [0005](./0005-nginx-dns-resolver-load-balancing.md))
or pinning to `--scale api=1`. The Nginx config carries this warning as a comment so it is found at
the point of change rather than rediscovered six months later.

Secondary benefit: `ip_hash` would have been actively harmful here anyway. Most mobile users arrive
through a small number of CGNAT addresses and would have hashed onto a single replica.
