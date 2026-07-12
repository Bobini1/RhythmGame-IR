# Arena Phase 4 server verification

Date: 2026-07-10  
Runtime: Bun 1.3.14  
Protocol: 1.2

This report covers the IR identity boundary, Arena server, production container,
and Coolify handoff. Client, accessibility, and representative-skin evidence is
recorded separately in the RhythmGame repository.

## Frozen heads and protocol non-drift

The release gate compared these repository heads before the integration report
was committed:

- RhythmGame-IR: `8df15e34c475f01fc502d75de04068f6a5528725`
- RhythmGame: `b022d10979a1dcc72a774b47e0b97538bc94baef`

SHA-256 was computed after normalizing CRLF to LF. Every shared fixture matched:

| Fixture                      | RhythmGame-IR                                                      | RhythmGame |
| ---------------------------- | ------------------------------------------------------------------ | ---------- |
| `protocol-v1.json`           | `f8fdb269b8e0421db1a244563d78d2b6a2d001069c4fc0fa54139b19f93912ac` | same       |
| `phase2-text-goldens.json`   | `cb5d7d7e05245b1a80f2ca20951accc75013e3e5f52afba1d039ad3280647cf0` | same       |
| `phase2-binary-goldens.json` | `ba4535da55a7a70383c72ae783b915d0f518aff87d1a0992adb9d391f44886a0` | same       |
| `phase3-text-goldens.json`   | `843c6e6c9d2c5e599119b988bc4c0edda9948167b6031426c4676454aec7820b` | same       |

The Phase 4 work did not change the protocol version.

## Automated server gates

All three end-to-end protocol smokes passed:

```text
bun run smoke:phase1  -> passed all 9 stages
bun run smoke:phase2  -> passed all 10 stages through WebSocket and JOSE
bun run smoke:phase3  -> passed all 10 competition stages
```

The deterministic malformed corpus passed `6/6` tests with `66` assertions:

```text
bun test tests/integration/phase4-malformed.test.ts
```

It directly covers the closed HTTP surface and metrics authorization, bounded
forwarding chains, malformed and oversized JSON, all structural RGA1 header
fields, transfer order/digest/count/budget failures, slow-reader delivery
classification, and sentinel-free metric labels. The complete suite supplies
the adjacent stateful cases: hello expiry and queued-frame close in
`websocket.test.ts`; stale generations/revisions in `room-inventory.test.ts`
and `selection-ready.test.ts`; stale rounds, load cancellation, and shutdown in
`round-loading.test.ts` and `shutdown.test.ts`; telemetry regressions/rate close
and final conflicts in `standings.test.ts`, `telemetry-limiter.test.ts`, and
`round-playing.test.ts`. The control cases in those suites verify that rejected
traffic does not mutate the room or retain upload/round state.

Windows verification:

```text
bun run verify
229 passed, 5 skipped, 0 failed, 22051 assertions
```

The five Windows skips are real Bun WebSocket close-path tests. The same source
was mounted read-only into `oven/bun:1.3.14-alpine` with Linux-installed locked
dependencies, where all of them executed:

```text
bun run verify
234 passed, 0 skipped, 0 failed, 22061 assertions
```

That Linux run exposed a Bun 1.3.14 defect: after a server-initiated WebSocket
close, `server.stop(true)` could stop progressing even after the server's own
socket registry was empty. Shutdown now waits at most one second for Bun's
force-stop promise, then unreferences the already-stopping listener and emits
only the aggregate `server_stop_timeout` event. The previously hanging hello,
flood, binary, and restart tests all pass on Linux.

## Bounded load and cleanup

`bun run load:phase4` uses an in-memory ticket verifier and deterministic clock
for the authoritative application workload. It created 200 authenticated seats
in 25 rooms of eight. Each seat committed one common and one unique chart hash,
so the inventories only partly overlapped. Every room selected the common chart,
sent chat, froze readiness, completed probe/load/start, accepted 5 Hz telemetry
for 30 logical seconds, resumed one seat, finalized, and was destroyed.

Representative result from the final Windows run (timings are observational,
not release thresholds):

```json
{
	"clients": 200,
	"rooms": 25,
	"telemetrySamples": 30000,
	"reconnects": 25,
	"finalizedRooms": 25,
	"rssBytes": { "start": 97972224, "peak": 166727680, "end": 161193984 },
	"eventLoopDelayMs": { "p50": 12.4813, "p95": 13.8076, "max": 14.325 },
	"bufferedBytes": { "current": 0, "peakEncodedDeliveryBatch": 17128 },
	"deliveryCount": 10548,
	"peakInventoryBytes": 12800,
	"droppedEphemeralStandings": 0,
	"postCleanup": {
		"connections": 0,
		"rooms": 0,
		"reservedSeats": 0,
		"activeRounds": 0,
		"inventoryBytes": 0
	},
	"wallDurationMs": 2385.7611
}
```

The production-container transport gate separately opened 200 simultaneous real
WebSockets. Together with the two container smoke connections, metrics reported
`arena_connections_total 202` and `arena_connections_current 0` after cleanup.
Those transport sockets are deliberately anonymous because the production image
accepts only real IR-signed tickets; authenticated room/round traffic is covered
by the 200-seat deterministic application soak. A future staging run with 200
real IR tickets can combine both layers, but no production credential or policy
was weakened to manufacture that result.

## Privacy and identity boundary

The runtime logging search found only fixed event names and one aggregate field,
`activeConnections`. There are no log fields for connection IDs, IP/header
values, tickets, authorization, identity, room, password, chat, telemetry, or
results. Tests inject sentinels into credentials, forwarded data, rooms, chat,
telemetry, results, errors, and metric reasons and assert they do not appear in
response, log, or Prometheus text. Metrics use fixed labels and map unknown
runtime values to `other`.

The exact Better Auth ticket test passed independently of the database by using
its own in-memory adapter:

```text
bunx vitest run src/lib/server/auth/tests/arena-ticket.test.ts --config <temporary no-DB config>
1 file passed, 5 tests passed
```

The normal repository-wide Vitest command remains unable to start its unrelated
database global setup: `docker-compose.test.yml` uses `postgres:latest` and mounts
`/var/lib/postgresql/data`; the resolved PostgreSQL 18 image requires the new
major-version-aware layout under `/var/lib/postgresql`. No production or test
database configuration was changed as part of Arena. Root Svelte validation did
run with documented placeholder environment values and passed with `0 errors`
and `0 warnings`.

## Production image and shutdown

The final source built successfully with:

```text
docker build --pull --tag rhythmgame-arena:phase4 .
base: oven/bun:1.3.14-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0
image manifest list: sha256:a3e4625f8d7c3183b62192e74819c8df4d19e95640f137011043e965aba38f7b
```

The container ran as UID 1000 (`bun`) with a read-only root filesystem and only
`/tmp` as tmpfs. Health was the exact no-store protocol body. Metrics returned
401 without a bearer and 200 with the test bearer. `/app/tests`, `/app/scripts`,
`/app/docs`, `/app/ops`, `.env`, and `.git` were absent. Image history contained
no database, Better Auth, metrics, cookie, private-key, or sentinel secret.
Metadata exposes only port 3001, uses `SIGTERM`, and includes OCI source,
revision, and version labels (the local verification build used the documented
`unknown`/`dev` defaults).

Container malformed probes produced the stable results below and health stayed
200 afterward:

```text
malformed JSON  -> 1002 malformed_message
binary frame    -> 1003 unexpected_binary
oversized text  -> 1006 transport end (1009 or transport 1006 is permitted)
```

The container accepted the Phase 1 anonymous smoke and Phase 2 remote protocol
probe. SIGTERM preserved health during the configured drain and logged:

```text
shutdown_requested 2026-07-10T11:54:25.111Z
server_stopped     2026-07-10T11:54:33.114Z activeConnections=0
```

## Coolify handoff and external blockers

`ops/coolify.md` and `ops/production.env.example` are the deployment contract:
one ephemeral replica, no volume, read-only root, `/tmp` tmpfs, at least 15
seconds stop grace, at least 300 seconds WebSocket idle timeout, explicit CPU,
memory, and connection ceilings, TLS at Traefik, private token-protected metrics,
and OCI build arguments. `TRUSTED_PROXY_CIDRS` must be the exact private
Coolify/Traefik network observed on the Netcup host; it is intentionally not
guessed or broadened.

Public deployment was not claimed. On the verification host:

```text
Resolve-DnsName arena.rhythmgame.eu
arena.rhythmgame.eu : DNS name does not exist.
```

Netcup/Coolify credentials and the real Traefik network were also unavailable.
Consequently the certificate, public WSS origin, controlled rolling restart, and
`smoke:production -- https://arena.rhythmgame.eu` remain external deployment
gates. All deployable artifacts and the exact credential-free smoke command are
ready; the safe proxy and authentication policies remain enforced.
