# PGlite WAL maintenance

The server uses the existing PGlite instance for standalone SQL `CHECKPOINT`
at startup and every 300 seconds. PGlite 0.2.17 `exec` acquires its transaction
mutex before its query mutex, so checkpoint waits for COMMIT/ROLLBACK.
Maintenance never acquires the market lock and must not be wrapped in
`runExclusive` or a transaction callback.

One controller owns each DB instance. The pending flag includes mutex waiting,
execution and diagnostics: interval callbacks during that period are dropped.
Errors are logged; subsequent intervals retry. Shutdown stops admission,
drains maintenance and server work, persists the final snapshot, then closes DB.
PostgreSQL recycles WAL; application code never removes WAL files. Durability
settings, pruning policy and VACUUM are unchanged.

## Interval experiment

TEMP disk-backed PGlite 0.2.17, actual `startEngineLoop` callback, all 11 coins,
atomic durable ticks plus existing snapshots every ten logical seconds.
Scheduling was accelerated: one callback represents one game second, not one
elapsed wall-clock second. Each candidate executed 3,600 callbacks without
player trades. The long stress test adds concurrent trades.

| Interval | Initial WAL | Final WAL | Final PGDATA bytes | Wall time | Checkpoint time |
| --- | ---: | ---: | ---: | ---: | ---: |
| none | 5 MiB | 14 MiB | 37,707,061 | 175.17 s | 0 |
| 60 s | 5 MiB | 5 MiB | 28,286,261 | 163.14 s | 712.69 ms |
| 300 s | 5 MiB | 5 MiB | 28,286,261 | 163.95 s | 196.43 ms |
| 900 s | 5 MiB | 5 MiB | 28,286,261 | 166.69 s | 130.07 ms |

`base` stayed at 22,406,701 bytes throughout all comparisons. Samples were taken
at 0/900/1800/2700/3600 ticks. At 300 seconds, checkpoint duration was
11.65-43.23 ms: total 0.12% of accelerated runtime. Runtime differences between
separate random market runs are not evidence of a throughput gain.
300 seconds retains the observed plateau with five times fewer checkpoints
than 60 seconds and three times more write-burst headroom than 900 seconds.
This is an empirical interval, not a hard size limit under arbitrary load,
stalled transactions or persistent I/O failure.

A TEMP copy of the baseline with 14 MiB of existing WAL remained at 14 MiB
after checkpoints and another 3,000 durable ticks with 300-tick checkpoints.
Recycling stops further growth; it does not necessarily shrink a previously
allocated WAL directory immediately. `fsync` and `full_page_writes` were `on`.

## Completed long stress run

20,000 durable ticks, all 11 coins, 727 committed trades (initial BUY plus
66 batches of ten concurrent BUYs and a SELL), 2,000 periodic snapshots,
66 checkpoints. Runtime: 1,626.28 seconds, with other regression suites also
running on the host. Every tick was asserted committed, not merely scheduled.

| Tick | PGDATA bytes | pg_wal bytes | base bytes |
| ---: | ---: | ---: | ---: |
| 0 | 28,392,757 | 5,242,880 | 22,529,581 |
| 5,000 | 28,548,405 | 5,242,880 | 22,660,653 |
| 10,000 | 28,687,669 | 5,242,880 | 22,783,533 |
| 15,000 | 28,843,317 | 5,242,880 | 22,914,605 |
| 20,000 | 28,974,389 | 5,242,880 | 23,021,101 |

All 21 samples (every 1,000 ticks) had exactly 5 MiB WAL. PGDATA increased
581,632 bytes while accumulating trade history; this is a WAL plateau, not a
promise that tables with new records never grow. Checkpoint time including
mutex waiting totaled 3,865.75 ms (0.238% of wall time), mean 58.57 ms,
maximum 96.35 ms. This measures checkpoint duration, not a controlled estimate
of throughput loss on Render hardware.

After the run, exact DB snapshots of players, holdings, pools, valuation,
rank progress, request receipts, trade log and daily volume survived normal
restart and forced termination before/during/after checkpoint. Retrying the
initial BUY returned its durable result without another economic mutation.
The expected financial snapshot includes the market receipt; idempotent replay
is allowed to publish a new market receipt and changes no financial rows.

The standalone maintenance suite passed, including commit-then-driver-error
recovery while checkpoint was pending. A separate TEMP smoke also ran the real
server entrypoint through startup/checkpoint/tick/SIGTERM/drain/close/restart.
Atomic, recovery/fail-closed, all-11 supply, MAX BUY, ranks, quests, daily volume,
bot lifecycle, auth, account isolation and numeric suites passed; server/client
builds passed. The extra existing tick-backpressure suite fails on its second
latency case: line 68 reconfigures the bot left enabled by its first case.
That test and its tick/configure implementation are unchanged by this diff.

## Regression commands

From `server`:

```text
npm run test:maintenance
npm run test:wal
```

Both ignore production PGDATA. The first uses memory; the second allocates TEMP
directories and prints their paths and size samples. Default stress length is
20,000 actual durable ticks with 300-second checkpoint scheduling. Every 300
ticks it executes ten concurrent distinct BUYs and a SELL; snapshot persistence
remains enabled every ten ticks. It checks every callback committed one tick,
the late WAL plateau, exact persistent financial state after restart, idempotent
replay, and forced process termination around checkpoint. The `during` kill
races checkpoint admission/execution; it does not claim a specific WAL-write
or fsync instruction was interrupted.

For shorter comparisons set `WAL_TEST_TICKS=3600` and `WAL_TEST_INTERVAL` to
0 (baseline), 60, 300 or 900. These repeat the workload with trades included.
The maintenance suite covers 64 overlapping interval callbacks, transaction
commit/rollback boundaries, 64 duplicate and ten distinct concurrent requests,
commit-success/driver-error recovery, errors, logging failure and stop/drain.

The 10-second `persistPoolSnapshots` call is retained. Normal tick and trade
transactions already persist pools and valuation; the helper also participates
in the shutdown/recovery barrier. Removing the periodic call is a separate
optimization; this fix does not depend on removing its writes.

## Operational limits

Logs report success/failure, duration (including DB mutex waiting) and optional
WAL bytes. They occur at startup and at most once per interval. Repeated failures
require operator attention: maintenance cannot promise a plateau when storage
no longer accepts writes. It does not bound intentional table growth, including
trade requests, logs and sessions. No production PGDATA was used in these tests.
