# RhythmGame Arena server

This independently deployable Bun service provides the database-free, ephemeral room, synchronized-launch, and live-competition backend for RhythmGame Online Arena. Protocol 1.2 includes anonymous room browsing; authenticated create/join; password rooms; ownership, kicking, and chat; reconnect reservation; exact library inventories and common-chart availability; immutable song/options selection; deterministic probe/load/start; bounded five-hertz telemetry; live standings; DNF lifecycle; and atomic final rankings with room-lifetime wins. Ordinary score upload remains an independent client-to-IR operation and never passes through Arena.

The service trusts RhythmGame IR only as an identity issuer. It verifies short-lived Ed25519 tickets through the public IR JWKS endpoint, then retains only the public user ID, display name, and avatar URL. It never receives an IR database connection, Better Auth secret, signing key, session cookie, or persistent volume. Room passwords are Argon2id hashes kept only in process memory. Rooms, chat, reconnect seats, and lobby statistics are intentionally lost on every restart or deployment.

## Local development and verification

Use the pinned Bun 1.3.14 runtime:

```sh
bun install --frozen-lockfile
bun run verify
bun run smoke:phase1
bun run smoke:phase2
bun run smoke:phase3
bun run smoke:production -- https://arena.rhythmgame.eu
bun run start
```

`smoke:phase1` is credential-free. It starts an ephemeral loopback JWKS server with a generated Ed25519 key, the real Arena gateway, two split-process WebSocket clients, the production JOSE verifier, and the production Argon2id password hasher. Its nine phases cover anonymous gating, password admission, chat, moderation, room-lifetime bans, reconnect token rotation, owner transfer, grace expiry, and clean shutdown. The smoke uses the minimum accepted 10-second reconnect grace to stay bounded; normal operation defaults to 60 seconds.

`smoke:phase2` is also credential-free. Its default mode starts an ephemeral loopback Ed25519 JWKS issuer, the production JOSE verifier, the real Arena gateway, and split-process WebSocket clients using actual text and binary frames. Its ten phases retain the complete inventory/common-chart/selection/probe/load/start compatibility proof beneath protocol 1.0 capability negotiation.

`smoke:phase3` runs a deterministic in-process three-seat assertion driver. It proves legacy admission gating, exact chart-length launch, no-data versus zero, coalesced `1,1,3` live and final ranks, ephemeral full-snapshot repair, joint wins, retained last result, reconnect, abandon, deadline DNF, and room-state destruction. `--docker-image` is reserved for the Docker/Linux integration host, where the image must be paired with an ephemeral loopback JWKS issuer; the local in-process mode never writes a signing key or contacts an IR score endpoint.

`smoke:production` accepts exactly one credential-free HTTPS origin. It validates the public certificate through HTTPS and WSS, checks exact health and query rejection, then performs an anonymous protocol 1.0 hello and directory subscription. It has no ticket, password, token, or private-key input path.

The default development endpoints are `http://127.0.0.1:3001/healthz` and `ws://127.0.0.1:3001/ws`. Production TLS terminates at the reverse proxy; the container itself serves plain HTTP/WS.

A deployed server can be checked without an account or credential:

```sh
bun run smoke:phase1 -- --anonymous-url wss://arena.rhythmgame.eu/ws
bun run smoke:phase2 -- wss://arena.rhythmgame.eu/ws
```

The URL modes accept only WSS or explicit loopback WS at the exact `/ws` path. They perform anonymous hello and directory subscription only; the complete authenticated Phase 2 contract is the no-argument local smoke. An arbitrary deployed server trusts its own configured IR issuer, so it cannot accept the smoke's ephemeral key without being launched as part of that harness. Neither URL mode accepts tickets, passwords, email addresses, bearer tokens, private keys, or seat tokens from arguments or the environment.

## Runtime configuration

| Variable                                  | Default                               | Policy                                                                    |
| ----------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------- |
| `HOST`                                    | `0.0.0.0`                             | Nonempty listen host, at most 253 characters.                             |
| `PORT`                                    | `3001`                                | Integer from 1 through 65535.                                             |
| `IR_JWKS_URL`                             | `https://rhythmgame.eu/api/auth/jwks` | HTTPS, except explicit loopback HTTP for development/tests.               |
| `IR_ISSUER`                               | `https://rhythmgame.eu`               | Exact ticket issuer; HTTPS except explicit loopback HTTP.                 |
| `ARENA_AUDIENCE`                          | `https://arena.rhythmgame.eu`         | Exact ticket audience; HTTPS except explicit loopback HTTP.               |
| `RECONNECT_GRACE_MS`                      | `60000`                               | Integer from 10 seconds through 5 minutes.                                |
| `ROOM_CAPACITY`                           | `16`                                  | Fixed by protocol 1.x; any other value fails startup.                     |
| `CHAT_BACKLOG`                            | `200`                                 | Integer from 1 through 1000 messages per room.                            |
| `INVENTORY_UPLOAD_TIMEOUT_MS`             | `60000`                               | Integer from 1 second through 5 minutes.                                  |
| `MAX_PENDING_INVENTORY_BYTES`             | `134217728`                           | Process-wide partial-upload budget, at most 512 MiB.                      |
| `MAX_COMMITTED_INVENTORY_BYTES`           | `536870912`                           | Process-wide committed-seat budget, at most 2 GiB.                        |
| `MAX_ROOMS`                               | `1000`                                | Process-wide in-memory room cap.                                          |
| `MAX_CONNECTIONS`                         | `5000`                                | WebSocket upgrade cap; excess receives HTTP 503.                          |
| `TELEMETRY_INTERVAL_MS`                   | `200`                                 | Protocol-canonical value; other values fail startup.                      |
| `TRUSTED_PROXY_CIDRS`                     | empty                                 | Comma-separated exact private proxy networks; global ranges are rejected. |
| `UPGRADE_ATTEMPTS_PER_ADDRESS_PER_MINUTE` | `120`                                 | Rolling upgrade attempts retained per HMAC address key.                   |
| `MAX_CONNECTIONS_PER_ADDRESS`             | `20`                                  | Concurrent upgraded sockets per HMAC address key.                         |
| `CLIENT_HELLO_TIMEOUT_MS`                 | `10000`                               | Incomplete hello policy-close deadline.                                   |
| `MAX_TRACKED_ADDRESSES`                   | `20000`                               | Process-wide bounded admission entries.                                   |
| `METRICS_ENABLED`                         | `false`                               | Enables private exact `GET /metrics` only.                                |
| `METRICS_BEARER_TOKEN`                    | empty                                 | Required bearer-safe value of at least 32 bytes when enabled.             |
| `SHUTDOWN_DRAIN_MS`                       | `8000`                                | Maximum reliable-send drain before 1012 close.                            |

Invalid configuration fails before the listener starts. `GET /healthz` reports process and protocol 1.0 liveness only; it deliberately does not contact IR or JWKS, so an identity outage cannot create a container restart loop.

The gateway trusts `X-Forwarded-For` only when Bun's direct peer belongs to a configured `TRUSTED_PROXY_CIDRS` network. It accepts at most eight entries and 512 bytes, strips configured proxy hops right-to-left, and otherwise falls back to the direct peer. Raw addresses and forwarding headers are never logged or used as metric labels; admission keys are HMAC-SHA-256 values under a process-random salt. Configure only the actual private Traefik/container-network CIDR. Empty direct-peer mode is safe, while malformed, duplicate, or global trust ranges fail startup.

## HTTP and protocol behavior

- Exact `GET /healthz` returns no-store JSON with process status and protocol version.
- Exact `GET /metrics` is disabled by default. When enabled it requires a constant-time-checked bearer token, returns bounded Prometheus text with no-store, and exposes no room/user/IP/chart/score/chat identifiers.
- Exact `GET /ws` performs the WebSocket upgrade. A nonempty query is rejected with 400, other methods with 405 and `Allow: GET`, a failed upgrade with 426, and other paths with 404.
- During shutdown, new `/ws` requests receive 503.
- The first WebSocket message must be a protocol 1.x `client_hello`. Minor 0 negotiates `rooms-v1`, minor 1 adds `rounds-v1`, and minor 2 adds `competition-v1`. Older clients may browse but cannot enter a playable room.
- Anonymous hello permits directory subscription but mutations return correlated `auth_required` errors without closing the socket.
- Authenticated create, join, or resume requires a fresh one-use IR ticket. Resume additionally requires the current in-memory seat token and rotates it on success.
- An authenticated room join by an identity that already owns a seat reclaims that seat instead of creating a duplicate. This recovery path preserves room and round state, advances the connection generation, rotates the resume token, cancels stale connection work, and fences any older live socket. It covers process restarts and crashes where the client no longer has its in-memory resume token; explicit leave and kick still remove the seat.
- Client text frames are capped at 65,536 UTF-8 bytes. Encoded server frames are capped at 4,194,304 UTF-8 bytes. Binary client frames are accepted only for an active inventory upload, use the exact `RGA1` chunk envelope, and are capped at 65,536 bytes.
- A committed inventory contains sorted unique SHA-256 chart hashes, at most 250,000 hashes and 8,000,000 bytes per seat. Partial and committed data are also bounded by the process-wide budgets above.
- The server computes the exact room intersection and sends revisioned reset/delta availability transfers. Any player may replace the current common-chart selection; the accepted selection freezes its metadata, both note-randomization sides, DP mode, and lane seed.
- When every active seat is ready on the same revisions, the server freezes the participant roster, probes the exact chart hash, coordinates loading, compensates measured RTT, and sends one common future start deadline. A join during loading waits for the next round.
- Successful loads must agree on chart length. Playing accepts bounded monotonic telemetry, publishes complete standings no more than every 200 ms, and finalizes immutable EX-score ranks after a final result or explicit/lifecycle DNF from every frozen participant.
- Live standings are the only droppable delivery. They stop while a socket is backpressured and recover with the next complete snapshot. Reliable delivery that would cross 5 MiB closes with 1013 `try_again_later`, reserves the seat, and relies on the authoritative resume snapshot.
- Public directory summaries contain no identities, chat, passwords, tickets, or resume tokens. A private room snapshot carries only the receiving seat's resume token.
- Structured command errors are recoverable. Malformed, incompatible, or abusive transport input is closed with a stable fatal code.

An IR/JWKS outage affects new authenticated hellos only: health and anonymous browsing remain available, while ticket verification fails safely. An Arena outage means `/healthz` or `/ws` itself is unreachable and should be handled by client retry. Do not restart Arena merely because IR is temporarily unavailable.

## Docker verification

Build and inspect the pinned non-root image:

```sh
docker build --pull --tag rhythmgame-arena:phase4 --file arena-server/Dockerfile arena-server
docker image inspect rhythmgame-arena:phase4 --format '{{.Config.User}} {{json .Config.ExposedPorts}} {{json .Config.Healthcheck}} {{json .Config.Labels}}'
docker run --rm --entrypoint sh rhythmgame-arena:phase4 -c 'test ! -e /app/tests && test ! -e /app/scripts && test ! -e /app/docs && test ! -e /app/ops && test ! -e /app/fixtures && test ! -e /app/.env && test ! -e /app/.git'
```

Run it without any private IR configuration:

```sh
docker run --rm --read-only --tmpfs /tmp --publish 127.0.0.1:3001:3001 rhythmgame-arena:phase4
curl --fail --silent --show-error http://127.0.0.1:3001/healthz
```

Invalid policy must fail startup:

```sh
docker run --rm --env ROOM_CAPACITY=8 rhythmgame-arena:phase4
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
| Stop grace                | At least fifteen seconds                                     |
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
ROOM_CAPACITY=32
CHAT_BACKLOG=200
INVENTORY_UPLOAD_TIMEOUT_MS=60000
MAX_PENDING_INVENTORY_BYTES=134217728
MAX_COMMITTED_INVENTORY_BYTES=536870912
MAX_ROOMS=1000
MAX_CONNECTIONS=5000
TELEMETRY_INTERVAL_MS=200
TRUSTED_PROXY_CIDRS=<exact-private-traefik-network-cidr>
UPGRADE_ATTEMPTS_PER_ADDRESS_PER_MINUTE=120
MAX_CONNECTIONS_PER_ADDRESS=20
CLIENT_HELLO_TIMEOUT_MS=10000
MAX_TRACKED_ADDRESSES=20000
METRICS_ENABLED=true
METRICS_BEARER_TOKEN=<coolify-secret-at-least-32-bytes>
SHUTDOWN_DRAIN_MS=8000
```

Do not configure `DATABASE_URL`, Better Auth secrets, signing private keys, IR session tokens, cookie secrets, certificates, or a volume. Keep exactly one replica until room state and fan-out move to shared infrastructure; multiple replicas would split the directory. The exact operational checklist and credential boundary are in [`ops/coolify.md`](ops/coolify.md).

The reverse proxy must preserve WebSocket upgrades, expose WSS only, validate the public certificate/hostname, allow at least a five-minute idle period, and enforce external connection and payload limits. Graceful shutdown broadcasts `server_going_away`, drains briefly, then closes active sockets with WebSocket code 1012. A deployment or restart intentionally destroys every room.

Post-deploy checks:

```sh
curl --fail --silent --show-error https://arena.rhythmgame.eu/healthz
bun run smoke:phase1 -- --anonymous-url wss://arena.rhythmgame.eu/ws
bun run smoke:phase2 -- wss://arena.rhythmgame.eu/ws
bun run smoke:production -- https://arena.rhythmgame.eu
curl --include 'https://arena.rhythmgame.eu/ws?ticket=sentinel'
```

The health request must report protocol 1.0, both anonymous probes must receive hello and directory state without credentials, and the query-bearing WebSocket request must return 400. Full authenticated Phase 2/3 smokes remain local or image-owned because deployed probes deliberately accept no credentials. Use a test-only sentinel, never a real ticket, in URL-policy probes.

## Security and operational notes

- Never log tickets, room passwords, resume tokens, chat bodies, raw frames, complete deliveries, full song inventories, or availability-transfer payloads.
- Structured logs contain stable event names and bounded aggregate counts only; connection, room, member, user, address, chart, score, chat, and credential values are excluded.
- No room, chat, credential, or reconnect state is persisted.
- IR/JWKS errors are identity-service failures; Arena socket/health errors are Arena-service failures. Diagnose them separately.
- The native Bun 1.3.14 WebSocket implementation on Windows can spin in tests involving server-initiated close, binary input, and native oversize rejection. Those real-socket cases remain enabled on Linux and in the deployment image; deterministic application/HTTP tests and both credential-free smoke suites run on Windows.
