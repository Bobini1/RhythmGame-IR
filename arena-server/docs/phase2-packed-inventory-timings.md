# Phase 2 packed-inventory timings

Measured on 2026-07-10 with Bun 1.3.14 on the Windows x64 development host.
These are diagnostic measurements, not pass/fail thresholds. One 1,000-hash
construction warmed the implementation before the measured operations.

| Operation                                        | Result count |      Time |
| ------------------------------------------------ | -----------: | --------: |
| Intersect two identical 88,000-hash vectors      |       88,000 |  1.559 ms |
| Validate and copy one 250,000-hash vector        |      250,000 | 56.006 ms |
| Intersect two identical 250,000-hash vectors     |      250,000 |  2.548 ms |
| Intersect sixteen identical 250,000-hash vectors |      250,000 | 10.728 ms |

The benchmark constructs canonical packed vectors in memory and calls the same
`PackedInventory.fromSortedBytes`, `intersect`, and `intersectAll` methods used
by the room domain. It does not include WebSocket transfer time or client-side
SQLite enumeration. Identical vectors use the packed module's equality fast
path; partial and disjoint correctness remains covered by unit tests.
