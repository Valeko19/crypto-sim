import type { PGliteInterface } from '@electric-sql/pglite';

// Measured on PGlite 0.2.17; see scripts/tests/WAL_MAINTENANCE.md.
export const CHECKPOINT_INTERVAL_MS = 5 * 60_000;

export interface CheckpointEvent {
  event: 'checkpoint_success' | 'checkpoint_failure';
  durationMs: number;
  walBytes?: number;
  error?: string;
}
export interface DbMaintenance {
  // A busy/stopped invocation is dropped, never added to a checkpoint queue.
  runNow(): Promise<CheckpointEvent | null>;
  // Stop admission synchronously, then drain the one pending/running operation.
  stop(): Promise<void>;
}
const instances = new WeakMap<PGliteInterface, DbMaintenance>();

export function startDbMaintenance(db: PGliteInterface, options: {
  intervalMs?: number;
  log?: (event: CheckpointEvent) => void;
} = {}): DbMaintenance {
  const existing = instances.get(db);
  if (existing) return existing;
  const intervalMs = options.intervalMs ?? CHECKPOINT_INTERVAL_MS;
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0 || intervalMs > 2_147_483_647) {
    throw new Error('Invalid checkpoint interval');
  }
  const log = options.log ?? ((event: CheckpointEvent) => {
    const output = event.event === 'checkpoint_failure' ? console.error : console.info;
    output('[db-maintenance]', JSON.stringify(event));
  });
  let stopped = false;
  let pending: Promise<CheckpointEvent> | undefined;
  const maintenance: DbMaintenance = {
    runNow() {
      if (stopped || pending) return Promise.resolve(null);
      // Set pending before starting asynchronous work, including mutex admission.
      pending = Promise.resolve().then(async () => {
        const started = performance.now();
        let event: CheckpointEvent;
        try {
          // Use the ROOT DB instance, never tx.exec or db.transaction.
          // PGlite 0.2.17 public exec acquires its transaction mutex, waiting for
          // COMMIT/ROLLBACK before executing this standalone SQL statement.
          // Do not wrap in runExclusive (query-mutex inversion) or acquire the
          // market lock here: maintenance never publishes market state.
          await db.exec('CHECKPOINT');
          event = { event: 'checkpoint_success', durationMs: performance.now() - started };
          try {
            const result = await db.query<{ bytes: string }>(
              'SELECT COALESCE(SUM(size), 0)::text AS bytes FROM pg_ls_waldir()');
            event.walBytes = Number(result.rows[0].bytes);
          } catch { /* Optional diagnostics must not turn a successful checkpoint into a failure. */ }
        } catch (error) {
          event = { event: 'checkpoint_failure', durationMs: performance.now() - started,
            error: error instanceof Error ? error.message : String(error) };
        }
        try { log(event); } catch { /* A logger must not stop the maintenance loop. */ }
        return event;
      }).finally(() => { pending = undefined; });
      return pending;
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      await pending;
      if (instances.get(db) === maintenance) instances.delete(db);
    },
  };
  const timer = setInterval(() => { void maintenance.runNow(); }, intervalMs);
  timer.unref();
  instances.set(db, maintenance);
  return maintenance;
}
