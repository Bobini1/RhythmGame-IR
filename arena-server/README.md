# RhythmGame Arena server

This package is the database-free, ephemeral lobby service for RhythmGame Online Arena. It serves process health at `GET /healthz` and the protocol 1.0 WebSocket at the exact path `/ws`.

The service verifies short-lived IR identity tickets through the public IR JWKS endpoint. It does not receive an IR database connection, Better Auth secret, signing key, session cookie, or persistent volume. Room passwords are Argon2id hashes kept only in process memory. Rooms, chat, reconnect seats, and lobby statistics are intentionally lost on every restart or deployment.

## Local operation

Install and verify with Bun 1.3.14:

```sh
bun install --frozen-lockfile
bun run verify
bun run start
```

The default local endpoints are `http://127.0.0.1:3001/healthz` and `ws://127.0.0.1:3001/ws`. Production TLS terminates at the reverse proxy; the container itself serves plain HTTP/WS.

## Runtime configuration

| Variable             | Default                               | Policy                                                |
| -------------------- | ------------------------------------- | ----------------------------------------------------- |
| `HOST`               | `0.0.0.0`                             | Container listen address.                             |
| `PORT`               | `3001`                                | Integer from 1 through 65535.                         |
| `IR_JWKS_URL`        | `https://rhythmgame.eu/api/auth/jwks` | HTTPS, except explicit loopback HTTP tests.           |
| `IR_ISSUER`          | `https://rhythmgame.eu`               | Exact ticket issuer.                                  |
| `ARENA_AUDIENCE`     | `https://arena.rhythmgame.eu`         | Exact ticket audience.                                |
| `RECONNECT_GRACE_MS` | `60000`                               | 10 seconds through 5 minutes.                         |
| `ROOM_CAPACITY`      | `16`                                  | Fixed by protocol 1.0; any other value fails startup. |
| `CHAT_BACKLOG`       | `200`                                 | 1 through 1000 messages per room.                     |

`GET /healthz` reports only process/protocol liveness. It deliberately does not contact IR or JWKS, so an IR outage cannot create a container restart loop. Anonymous browsing continues during a verifier outage; new authenticated hellos fail safely.

The gateway derives its peer key from Bun's direct socket address and does not trust `X-Forwarded-For`. It applies a deliberately high, expiring direct-peer upgrade ceiling because the Coolify proxy may be the shared peer; per-identity room-creation/password-attempt limits and room-level chat limits remain authoritative. Never add forwarded-header trust without an explicit, validated proxy-hop policy.

## Coolify deployment

Use these settings for the official service:

- Repository base directory: `/arena-server`.
- Build pack: Dockerfile.
- Internal/exposed port: `3001`; do not publish it directly on the host.
- Health path: `/healthz`.
- Public origin: `https://arena.rhythmgame.eu`.
- Public WebSocket: `wss://arena.rhythmgame.eu/ws`.
- TLS termination: Coolify/Traefik proxy.
- Proxy WebSocket idle timeout: at least five minutes.
- Replicas: exactly one.
- Persistent volumes: none.
- Restart policy: normal container restart; every restart destroys all rooms.
- Stop grace: allow at least ten seconds for `server_going_away` and forced WebSocket closure.
- Resource policy: set explicit CPU and memory limits appropriate for the host; Coolify does not add them automatically.

Do not configure `DATABASE_URL`, Better Auth secrets, signing private keys, IR session tokens, or certificates in this application. Only the public verifier and operational variables above belong here.

The image is pinned to `oven/bun:1.3.14-alpine`, installs production dependencies from the frozen package lock, runs as the non-root `bun` user, and embeds neither tests nor local environment files.

## Operational notes

- Deployments are intentionally disruptive because Phase 1 room state is process-local.
- Shutdown first broadcasts `server_going_away`, then closes active sockets with WebSocket code 1012.
- Tickets, room passwords, resume tokens, chat bodies, raw frames, and complete protocol deliveries are never written to structured logs.
- Use one replica until room state and fan-out move to shared infrastructure; multiple replicas would split the room directory.
- The native Bun 1.3.14 WebSocket implementation on Windows can spin in tests on server-initiated close, binary input, and native oversize rejection. Those real-socket cases run on Linux (including the deployment image); deterministic application and HTTP tests still run on Windows.
