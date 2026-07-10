# Coolify deployment contract

This service is one ephemeral in-memory Arena process. Configure exactly one replica; a rolling second replica would split the room directory and is unsupported.

## Resource settings

- Repository: `https://github.com/Bobini1/RhythmGame-IR`
- Base directory: `/arena-server`
- Build pack: Dockerfile
- Internal listen address: `0.0.0.0:3001` over plain HTTP/WS
- Public origin: `https://arena.rhythmgame.eu`
- WebSocket path: `wss://arena.rhythmgame.eu/ws`
- Health path: `/healthz`
- Replica count: `1`
- Persistent volumes: none
- Stop grace: at least `15s`
- Traefik WebSocket idle timeout: at least `300s`
- CPU limit: set an explicit deployment-appropriate limit (initial recommendation: `2` CPUs)
- Memory limit: set at least `1536 MiB` with the example 512 MiB committed-inventory budget
- Coolify/Traefik connection limit: at least the configured `MAX_CONNECTIONS`, with an explicit external ceiling

Build with OCI metadata rather than leaving the revision ambiguous:

```text
--build-arg OCI_SOURCE=https://github.com/Bobini1/RhythmGame-IR
--build-arg OCI_REVISION=<deployed-git-sha>
--build-arg OCI_VERSION=<release-version>
```

The image runs as `bun`, declares `SIGTERM`, supports a read-only root filesystem, and needs only a writable tmpfs at `/tmp`. Do not add a volume.

## Environment and proxy trust

Copy the keys from `ops/production.env.example`. It intentionally contains no secret value. Do not deploy until `TRUSTED_PROXY_CIDRS` is the exact private Coolify/Traefik container-network CIDR observed on the host. Obtain it from the Coolify network or `docker network inspect`; do not guess it, use a public range, or use `0.0.0.0/0`/`::/0`. Startup rejects global trust ranges. An empty value is safe direct-peer mode for initial diagnostics but groups proxied clients under the Traefik peer and is not the final public configuration.

Generate `METRICS_BEARER_TOKEN` with at least 32 random bearer-safe bytes in Coolify's secret store, set `METRICS_ENABLED=true`, and expose `/metrics` only on a private/internal route. Never put the token in Git, image build arguments, a URL, or operator logs. The public `/healthz` endpoint deliberately contains no counts.

The Arena resource must not receive `DATABASE_URL`, Better Auth secrets, signing keys, IR bearer/session tokens, cookie secrets, TLS private keys, or certificates. It receives only the public IR issuer/JWKS URLs. TLS terminates at Traefik.

## Deployment checks

1. Confirm one replica, no volume, 15-second-or-longer stop grace, 300-second-or-longer proxy idle timeout, and explicit CPU/memory/connection ceilings.
2. Confirm Traefik preserves WebSocket upgrade headers and presents a valid certificate for `arena.rhythmgame.eu`.
3. Confirm the exact private proxy CIDR and private/token-protected metrics route.
4. Deploy, then run `bun run smoke:production -- https://arena.rhythmgame.eu` from a host with public DNS access.
5. During a controlled restart, confirm new `/ws` upgrades return 503, connected clients receive `server_going_away`, remaining sockets close with 1012, and the new process starts with an empty room directory.

Without Netcup/Coolify/DNS credentials, preparation stops at these artifacts and the credential-free public smoke command. Do not weaken proxy or metrics policy to manufacture a deployment pass.
