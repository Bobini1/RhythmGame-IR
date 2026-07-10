# RhythmGame Arena server

This independently deployable Bun service provides the database-free, ephemeral room and synchronized-launch backend for RhythmGame Online Arena. Protocol 1.1 includes anonymous room browsing, authenticated create/join, password rooms, roster ownership and kicking, chat, disconnect reservation, exact library inventories, common-chart availability, immutable song/options selection, ready state, file probes, deterministic loading, and a synchronized future start. Gameplay telemetry, results, rankings, score upload, and skin overlays remain later-phase work.

The service trusts RhythmGame IR only as an identity issuer. It verifies short-lived Ed25519 tickets through the public IR JWKS endpoint, then retains only the public user ID, display name, and avatar URL. It never receives an IR database connection, Better Auth secret, signing key, session cookie, or persistent volume. Room passwords are Argon2id hashes kept only in process memory. Rooms, chat, reconnect seats, and lobby statistics are intentionally lost on every restart or deployment.

## Local development and verification

Use the pinned Bun 1.3.14 runtime:

```sh
bun install --frozen-lockfile
bun run verify
bun run smoke:phase1
bun run smoke:phase2
bun run start
```

`smoke:phase1` is credential-free. It starts an ephemeral loopback JWKS server with a generated Ed25519 key, the real Arena gateway, two split-process WebSocket clients, the production JOSE verifier, and the production Argon2id password hasher. Its nine phases cover anonymous gating, password admission, chat, moderation, room-lifetime bans, reconnect token rotation, owner transfer, grace expiry, and clean shutdown. The smoke uses the minimum accepted 10-second reconnect grace to stay bounded; normal operation defaults to 60 seconds.

`smoke:phase2` is also credential-free. Its default mode starts an ephemeral loopback Ed25519 JWKS issuer, the production JOSE verifier, the real Arena gateway, and split-process WebSocket clients using actual text and binary frames. The ten phases cover anonymous 1.0 browsing, two authenticated 1.1 seats in a password room, partially overlapping inventories, exact common `{B,C}`, non-common rejection, last-accepted B/C selection, frozen ready roster with a waiting join, exact probes, deterministic loads, targeted schedules, Playing, and hash-mismatch cancellation back to Selecting. It validates every observed text event and rejects any Phase 3 telemetry/result discriminator.

The default development endpoints are `http://127.0.0.1:3001/healthz` and `ws://127.0.0.1:3001/ws`. Production TLS terminates at the reverse proxy; the container itself serves plain HTTP/WS.

A deployed server can be checked without an account or credential:

```sh
bun run smoke:phase1 -- --anonymous-url wss://arena.rhythmgame.eu/ws
bun run smoke:phase2 -- wss://arena.rhythmgame.eu/ws
```

The URL modes accept only WSS or explicit loopback WS at the exact `/ws` path. They perform anonymous hello and directory subscription only; the complete authenticated Phase 2 contract is the no-argument local smoke. An arbitrary deployed server trusts its own configured IR issuer, so it cannot accept the smoke's ephemeral key without being launched as part of that harness. Neither URL mode accepts tickets, passwords, email addresses, bearer tokens, private keys, or seat tokens from arguments or the environment.

## Runtime configuration

| Variable                        | Default                               | Policy                                                      |
| ------------------------------- | ------------------------------------- | ----------------------------------------------------------- |
| `HOST`                          | `0.0.0.0`                             | Nonempty listen host, at most 253 characters.               |
| `PORT`                          | `3001`                                | Integer from 1 through 65535.                               |
| `IR_JWKS_URL`                   | `https://rhythmgame.eu/api/auth/jwks` | HTTPS, except explicit loopback HTTP for development/tests. |
| `IR_ISSUER`                     | `https://rhythmgame.eu`               | Exact ticket issuer; HTTPS except explicit loopback HTTP.   |
| `ARENA_AUDIENCE`                | `https://arena.rhythmgame.eu`         | Exact ticket audience; HTTPS except explicit loopback HTTP. |
| `RECONNECT_GRACE_MS`            | `60000`                               | Integer from 10 seconds through 5 minutes.                  |
| `ROOM_CAPACITY`                 | `16`                                  | Fixed by protocol 1.x; any other value fails startup.       |
| `CHAT_BACKLOG`                  | `200`                                 | Integer from 1 through 1000 messages per room.              |
| `INVENTORY_UPLOAD_TIMEOUT_MS`   | `60000`                               | Integer from 1 second through 5 minutes.                    |
| `MAX_PENDING_INVENTORY_BYTES`   | `134217728`                           | Process-wide partial-upload budget, at most 512 MiB.        |
| `MAX_COMMITTED_INVENTORY_BYTES` | `536870912`                           | Process-wide committed-seat budget, at most 2 GiB.          |

Invalid configuration fails before the listener starts. `GET /healthz` reports process and protocol 1.1 liveness only; it deliberately does not contact IR or JWKS, so an identity outage cannot create a container restart loop.

The gateway derives its peer key from Bun's direct socket address and never trusts `X-Forwarded-For`. The current limits are 6,000 direct-peer upgrades per minute, five room creations per identity per minute, ten password-bearing join attempts per identity per minute, and five accepted chat messages per seat per ten seconds. The high direct-peer ceiling accounts for Coolify's proxy potentially being the shared direct peer; forwarded-header trust requires a separate validated proxy-hop policy.

## HTTP and protocol behavior

- Exact `GET /healthz` returns no-store JSON with process status and protocol version.
- Exact `GET /ws` performs the WebSocket upgrade. A nonempty query is rejected with 400, other methods with 405 and `Allow: GET`, a failed upgrade with 426, and other paths with 404.
- During shutdown, new `/ws` requests receive 503.
- The first WebSocket message must be a protocol 1.x `client_hello`. Protocol 1.0 requires `rooms-v1`; protocol 1.1 additionally negotiates `rounds-v1` before any inventory or round command is accepted.
- Anonymous hello permits directory subscription but mutations return correlated `auth_required` errors without closing the socket.
- Authenticated create, join, or resume requires a fresh one-use IR ticket. Resume additionally requires the current in-memory seat token and rotates it on success.
- Client text frames are capped at 65,536 UTF-8 bytes. Encoded server frames are capped at 4,194,304 UTF-8 bytes. Binary client frames are accepted only for an active inventory upload, use the exact `RGA1` chunk envelope, and are capped at 65,536 bytes.
- A committed inventory contains sorted unique SHA-256 chart hashes, at most 250,000 hashes and 8,000,000 bytes per seat. Partial and committed data are also bounded by the process-wide budgets above.
- The server computes the exact room intersection and sends revisioned reset/delta availability transfers. Any player may replace the current common-chart selection; the accepted selection freezes its metadata, both note-randomization sides, DP mode, and lane seed.
- When every active seat is ready on the same revisions, the server freezes the participant roster, probes the exact chart hash, coordinates loading, compensates measured RTT, and sends one common future start deadline. A join during loading waits for the next round.
- Public directory summaries contain no identities, chat, passwords, tickets, or resume tokens. A private room snapshot carries only the receiving seat's resume token.
- Structured command errors are recoverable. Malformed, incompatible, or abusive transport input is closed with a stable fatal code.

An IR/JWKS outage affects new authenticated hellos only: health and anonymous browsing remain available, while ticket verification fails safely. An Arena outage means `/healthz` or `/ws` itself is unreachable and should be handled by client retry. Do not restart Arena merely because IR is temporarily unavailable.

## Docker verification

Build and inspect the pinned non-root image:

```sh
docker build --pull --tag rhythmgame-arena:phase2 --file arena-server/Dockerfile arena-server
docker image inspect rhythmgame-arena:phase2 --format '{{.Config.User}} {{json .Config.ExposedPorts}} {{json .Config.Healthcheck}}'
docker run --rm --entrypoint sh rhythmgame-arena:phase2 -c 'test ! -e /app/tests && test ! -e /app/scripts && test ! -e /app/docs && test ! -e /app/fixtures && test ! -e /app/.env && test ! -e /app/.git'
```

Run it without any private IR configuration:

```sh
docker run --rm --publish 127.0.0.1:3001:3001 rhythmgame-arena:phase2
curl --fail --silent --show-error http://127.0.0.1:3001/healthz
```

Invalid policy must fail startup:

```sh
docker run --rm --env ROOM_CAPACITY=8 rhythmgame-arena:phase2
```

The image is pinned to `oven/bun:1.3.14-alpine`, installs production dependencies from the frozen package lock, exposes only `3001/tcp`, runs as the non-root `bun` user, declares `SIGTERM` as its stop signal, and embeds neither tests, smoke scripts, documentation, fixtures, nor local environment/VCS files. Give the container memory headroom above the configured inventory budgets; a 512 MiB container limit is not compatible with a 512 MiB committed-inventory budget plus Bun and room state.

## Coolify deployment

| Setting                   | Required value                                               |
| ------------------------- | ------------------------------------------------------------ |
| Repository base directory | `/arena-server`                                              |
| Build pack                | Dockerfile                                                   |
| Internal protocol/port    | Plain HTTP/WS on `0.0.0.0:3001`                              |
| Public origin             | `https://arena.rhythmgame.eu`                                |
| Public WebSocket          | `wss://arena.rhythmgame.eu/ws`                               |
| Health path               | `/healthz`                                                   |
| Replicas                  | Exactly one                                                  |
| Persistent volume         | None                                                         |
| TLS                       | Coolify/Traefik termination with a valid public certificate  |
| Proxy idle timeout        | At least five minutes                                        |
| Stop grace                | At least ten seconds                                         |
| Restart policy            | Health-based; health is independent of IR/JWKS reachability  |
| Resource limits           | Explicit CPU, memory, connection, and request/payload limits |

Configure only these runtime values:

```text
HOST=0.0.0.0
PORT=3001
IR_JWKS_URL=https://rhythmgame.eu/api/auth/jwks
IR_ISSUER=https://rhythmgame.eu
ARENA_AUDIENCE=https://arena.rhythmgame.eu
RECONNECT_GRACE_MS=60000
ROOM_CAPACITY=16
CHAT_BACKLOG=200
INVENTORY_UPLOAD_TIMEOUT_MS=60000
MAX_PENDING_INVENTORY_BYTES=134217728
MAX_COMMITTED_INVENTORY_BYTES=536870912
```

Do not configure `DATABASE_URL`, Better Auth secrets, signing private keys, IR session tokens, cookie secrets, certificates, or a volume. Keep exactly one replica until room state and fan-out move to shared infrastructure; multiple replicas would split the directory.

The reverse proxy must preserve WebSocket upgrades, expose WSS only, validate the public certificate/hostname, allow at least a five-minute idle period, and enforce external connection and payload limits. Graceful shutdown broadcasts `server_going_away`, drains briefly, then closes active sockets with WebSocket code 1012. A deployment or restart intentionally destroys every room.

Post-deploy checks:

```sh
curl --fail --silent --show-error https://arena.rhythmgame.eu/healthz
bun run smoke:phase1 -- --anonymous-url wss://arena.rhythmgame.eu/ws
bun run smoke:phase2 -- wss://arena.rhythmgame.eu/ws
curl --include 'https://arena.rhythmgame.eu/ws?ticket=sentinel'
```

The health request must report protocol 1.1, both anonymous probes must receive hello and directory state without credentials, and the query-bearing WebSocket request must return 400. The full authenticated Phase 2 smoke remains the no-argument local command because deployed probes deliberately accept no credentials. Use a test-only sentinel, never a real ticket, in URL-policy probes.

## Security and operational notes

- Never log tickets, room passwords, resume tokens, chat bodies, raw frames, complete deliveries, full song inventories, or availability-transfer payloads.
- Structured logs contain stable event names and permitted connection/room identifiers only.
- No room, chat, credential, or reconnect state is persisted.
- IR/JWKS errors are identity-service failures; Arena socket/health errors are Arena-service failures. Diagnose them separately.
- The native Bun 1.3.14 WebSocket implementation on Windows can spin in tests involving server-initiated close, binary input, and native oversize rejection. Those real-socket cases remain enabled on Linux and in the deployment image; deterministic application/HTTP tests and both credential-free smoke suites run on Windows.
