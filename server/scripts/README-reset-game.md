# Canonical Full Game Reset

Use `npm run reset:game` from `server`. This is an **offline** operation, not
an HTTP endpoint, boot hook, or deployment pre-start command.

1. Stop every HTTP server, market engine, scheduler and worker using the target
   PGlite directory. Keep the service stopped until verification succeeds.
2. Remove `RUN_PLAYER_RESET` from the environment. Identify the existing absolute
   PGDATA directory explicitly; the command never uses a default database.
3. Inspect it first (examples below are templates, not commands already run):

   `npm run reset:game -- --pgdata "<absolute-existing-PGDATA>" --maintenance`

4. Apply with a unique operation ID and keep that ID and the output:

   `npm run reset:game -- --pgdata "<absolute-existing-PGDATA>" --maintenance --yes --operation-id "<unique-reset-id>"`

5. Require `VERIFIED FULL RESET` and exit code 0 before starting the normal server.
   Reopen the Mini App: it bootstraps a new session and receives the current epoch.

`--maintenance` is the operator's explicit confirmation of exclusive offline
ownership, not an OS process detector. Even dry-run needs exclusive ownership of
PGlite. Dry-run runs SELECTs only: no schema migration or game-state write. Opening
and closing the database can still update PGlite's internal storage metadata.
Its proposed epoch is a preview; an actual invocation generates its own epoch.
The command creates no backup.

## State and recovery

All players, including `dev_*`, retain identity, username and creation time.
All receive the canonical new-player balance (100 USDD) and zero trade counters.
Holdings, claims, daily volume, ranks, earned totals, staking, bots, trade history,
idempotency results and sessions are deleted. The eleven pools, reference prices,
valuations, market receipt, epoch and completion marker are committed together.
Existing admin reset log entries remain.

A failure before COMMIT rolls everything back. A driver error after COMMIT is
resolved by reading the durable `full_game_reset:<operation-id>` marker; the CLI
can reopen the DB to perform this read. It never automatically repeats the
destructive transaction. An operator retry must use the **same operation ID**.
If the marker exists, only verification runs. If gameplay has already resumed,
clean-state verification can fail: that does not authorize another reset. Keep
maintenance mode and inspect the marker/state rather than supplying a fresh ID.

After the first full reset all API mutations require the current `X-Game-Epoch`.
An old or missing epoch is rejected even with a new valid session. The client
captures epoch before asynchronous authentication and preserves it across retry;
an epoch change invalidates its auth generation and personal WS state. Existing
epoch `0` installations accept missing headers only before their first reset.
WebSocket has no financial mutation protocol. Offline shutdown ends old bot jobs
and sockets, and deletion of bot rows prevents old schedules from resuming.

Legacy `reset-players`, `reset-market-pools` and the boot-time player reset are
development-only, incomplete resets; they reject `NODE_ENV=production`. Do not
combine them for a beta reset. They remain available for existing dev workflows.

## Tests

`npm run test:reset` uses memory and newly created temporary directories only.
It exercises dirty state, nine rollback points, commit-then-driver-error, dry-run,
offline CLI guards, process restart, sessions/epochs, trades, rewards and bot setup.
`npm run test:accounts` also tests a pending client mutation across reset, 401,
bootstrap, clearing personal WS state, and a fresh post-reset BUY.
