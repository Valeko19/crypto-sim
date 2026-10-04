import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';

const originalPgDataDir = process.env.PGDATA_DIR;
const originalNodeEnv = process.env.NODE_ENV;
const dataDir = mkdtempSync(path.join(tmpdir(), 'crypto-sim-atomic-tests-'));
const crashDataDir = mkdtempSync(path.join(tmpdir(), 'crypto-sim-hard-crash-'));
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
process.env.PGDATA_DIR = dataDir;
process.env.NODE_ENV = 'test';

const { db, initDb } = await import('../../src/db/index.js');
const {
  ensurePlayerExists, getPlayer, getHolding, getAllPoolSnapshots,
  configureTradingBot, setTradingBotEnabled,
} = await import('../../src/db/queries.js');
const { createInitialState } = await import('../../src/engine/state.js');
const { executeTrade, TradeError } = await import('../../src/engine/trade.js');
const { runTradingBots } = await import('../../src/engine/tradingBot.js');
const { createRouter } = await import('../../src/api/routes.js');
const { tick } = await import('../../src/engine/tick.js');
const { persistPoolSnapshots } = await import('../../src/engine/poolPersistence.js');
const { todaysVolume } = await import('../../src/engine/dailyVolume.js');

const state = createInitialState();
const results: string[] = [];
let reopenedDb: PGlite | null = null;
let server: Server | null = null;

async function snapshot(playerId: string) {
  const player = await getPlayer(playerId);
  const holding = await getHolding(playerId, 'btcr');
  const tradeLogs = await db.query<{ count: number }>(
    'SELECT COUNT(*)::int AS count FROM trade_log WHERE player_id = $1',
    [playerId]
  );
  const requestRows = await db.query<{ count: number }>(
    'SELECT COUNT(*)::int AS count FROM trade_requests WHERE player_id = $1',
    [playerId]
  );
  const pools = await getAllPoolSnapshots();
  const pool = state.coins.btcr.pool;
  return {
    balance: player.usdd_balance,
    tradesCount: player.trades_count,
    totalVolume: player.total_volume,
    totalFeesPaid: player.total_fees_paid,
    realizedPnl: player.realized_pnl,
    holding: holding ? { amount: holding.amount, avgBuyPrice: holding.avg_buy_price } : null,
    tradeLogCount: tradeLogs.rows[0].count,
    requestCount: requestRows.rows[0].count,
    durablePool: pools.find(row => row.coin_id === 'btcr') ?? null,
    livePool: { ...pool },
    playerOwnedCoins: state.coins.btcr.playerOwnedCoins,
    dailyVolume: await todaysVolume(playerId),
  };
}

async function run(name: string, test: () => Promise<void>): Promise<void> {
  await test();
  results.push(name);
  console.log(`PASS ${name}`);
}

async function withQueryFailure<T>(needle: string, test: () => Promise<T>): Promise<T> {
  const originalTransaction = db.transaction.bind(db);
  let injected = false;
  (db as any).transaction = (callback: (tx: any) => Promise<unknown>) => originalTransaction((tx: any) => callback(new Proxy(tx, {
    get(target, property) {
      if (property === 'query') {
        return async (sql: string, params?: unknown[], options?: unknown) => {
          if (!injected && sql.includes(needle)) {
            injected = true;
            throw new Error(`injected failure: ${needle}`);
          }
          return target.query(sql, params, options);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  })));
  try {
    return await test();
  } finally {
    (db as any).transaction = originalTransaction;
    assert.equal(injected, true, `failure point was not reached: ${needle}`);
  }
}

async function main(): Promise<void> {
  await initDb();
  const app = express();
  app.use(express.json());
  app.use('/api', createRouter(state));
  server = createServer(app);
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));

  async function postTrade(playerId: string, body: Record<string, unknown>) {
    const response = await fetch(`http://127.0.0.1:${server!.address()!.port}/api/trade`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Dev-Player-Id': playerId },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }

  await run('manual /trade request IDs replay and reject parameter conflicts', async () => {
    const playerId = 'dev_atomic_http_idempotency';
    const request = { coinId: 'btcr', side: 'buy', amountUsdd: 20, requestId: 'http-buy-1' };
    const [first, replay] = await Promise.all([postTrade(playerId, request), postTrade(playerId, request)]);
    assert.equal(first.status, 200);
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.body, first.body);
    assert.equal('replayed' in replay.body, false);
    assert.equal((await getPlayer(playerId)).trades_count, 1);
    const conflict = await postTrade(playerId, { ...request, amountUsdd: 21 });
    assert.equal(conflict.status, 409);
    assert.equal((await getPlayer(playerId)).trades_count, 1);
    const missingId = await postTrade(playerId, { coinId: 'btcr', side: 'buy', amountUsdd: 1 });
    assert.equal(missingId.status, 400);
    const reservedId = await postTrade(playerId, { ...request, requestId: 'bot:manual-reserved' });
    assert.equal(reservedId.status, 400);
  });

  await run('BUY/SELL settle pool and player state durably', async () => {
    const playerId = 'atomic_success';
    const buy = await executeTrade(state, playerId, {
      coinId: 'btcr', side: 'buy', amountUsdd: 40, requestId: 'buy-1',
    });
    const afterBuy = await snapshot(playerId);
    assert.equal(afterBuy.balance, 60);
    assert.equal(afterBuy.tradesCount, 1);
    assert.equal(afterBuy.tradeLogCount, 1);
    assert.equal(afterBuy.requestCount, 1);
    assert.deepEqual(afterBuy.durablePool && {
      coinReserve: afterBuy.durablePool.coin_reserve,
      usddReserve: afterBuy.durablePool.usdd_reserve,
    }, afterBuy.livePool);
    assert.ok(afterBuy.holding && afterBuy.holding.amount > 0);

    const replay = await executeTrade(state, playerId, {
      coinId: 'btcr', side: 'buy', amountUsdd: 40, requestId: 'buy-1',
    });
    assert.equal(replay.replayed, true);
    assert.deepEqual({ ...replay, replayed: false }, buy);
    assert.deepEqual(await snapshot(playerId), afterBuy);
    await assert.rejects(
      executeTrade(state, playerId, { coinId: 'btcr', side: 'buy', amountUsdd: 39, requestId: 'buy-1' }),
      (error: unknown) => error instanceof TradeError && error.status === 409,
    );
    assert.deepEqual(await snapshot(playerId), afterBuy);

    const secondBuy = await executeTrade(state, playerId, {
      coinId: 'btcr', side: 'buy', amountUsdd: 10, requestId: 'buy-2',
    });
    assert.ok(secondBuy.coinAmount > 0);
    assert.equal((await getPlayer(playerId)).trades_count, 2);

    const held = await getHolding(playerId, 'btcr');
    const sell = await executeTrade(state, playerId, {
      coinId: 'btcr', side: 'sell', amountCoin: held!.amount / 2, requestId: 'sell-1',
    });
    assert.ok(sell.usddAmount > 0);
    const afterSell = await snapshot(playerId);
    assert.equal(afterSell.tradesCount, 3);
    assert.equal(afterSell.tradeLogCount, 3);
    assert.deepEqual(afterSell.durablePool && {
      coinReserve: afterSell.durablePool.coin_reserve,
      usddReserve: afterSell.durablePool.usdd_reserve,
    }, afterSell.livePool);

    const anotherPlayer = await executeTrade(state, 'atomic_other_player', {
      coinId: 'btcr', side: 'buy', amountUsdd: 1, requestId: 'buy-1',
    });
    assert.ok(anotherPlayer.coinAmount > 0);
    assert.equal((await getPlayer('atomic_other_player')).trades_count, 1);
  });

  await run('BUY faults rollback every persisted and in-memory effect', async () => {
    const failurePoints = [
      'INSERT INTO player_holdings',
      'UPDATE players SET usdd_balance = usdd_balance -',
      'INSERT INTO trade_log',
      'INSERT INTO coin_pools',
      'UPDATE trade_requests SET response',
    ];
    for (let i = 0; i < failurePoints.length; i++) {
      const playerId = `atomic_buy_fault_${i}`;
      await ensurePlayerExists(playerId);
      const before = await snapshot(playerId);
      await assert.rejects(withQueryFailure(failurePoints[i], () => executeTrade(state, playerId, {
        coinId: 'btcr', side: 'buy', amountUsdd: 10, requestId: `buy-fault-${i}`,
      })));
      assert.deepEqual(await snapshot(playerId), before, failurePoints[i]);
    }
  });

  await run('SELL faults rollback every persisted and in-memory effect', async () => {
    const failurePoints = [
      'UPDATE player_holdings SET amount',
      'UPDATE players SET usdd_balance = usdd_balance +',
      'INSERT INTO trade_log',
      'INSERT INTO coin_pools',
      'UPDATE trade_requests SET response',
    ];
    for (let i = 0; i < failurePoints.length; i++) {
      const playerId = `atomic_sell_fault_${i}`;
      await executeTrade(state, playerId, {
        coinId: 'btcr', side: 'buy', amountUsdd: 40, requestId: `seed-${i}`,
      });
      const before = await snapshot(playerId);
      const coinAmount = before.holding!.amount / 2;
      await assert.rejects(withQueryFailure(failurePoints[i], () => executeTrade(state, playerId, {
        coinId: 'btcr', side: 'sell', amountCoin: coinAmount, requestId: `sell-fault-${i}`,
      })));
      assert.deepEqual(await snapshot(playerId), before, failurePoints[i]);
    }
  });

  await run('bot totals/reschedule failure rolls back the committed trade', async () => {
    const playerId = 'atomic_bot_totals_fault';
    await ensurePlayerExists(playerId);
    await configureTradingBot(playerId, 'btcr', 'buy', 1_000, 10);
    await setTradingBotEnabled(playerId, true);
    const scheduledAt = new Date(Date.now() - 60_000).toISOString();
    await db.query('UPDATE trading_bots SET next_run_at = $2 WHERE player_id = $1', [playerId, scheduledAt]);
    const before = await snapshot(playerId);
    const beforeBot = await db.query(
      'SELECT run_total_usdd, run_total_coins, next_run_at FROM trading_bots WHERE player_id = $1', [playerId]
    );

    await assert.rejects(withQueryFailure('SET run_total_usdd = run_total_usdd +', () => executeTrade(state, playerId, {
      coinId: 'btcr', side: 'buy', amountUsdd: 10, requestId: `bot:${scheduledAt}`,
      botFiring: { scheduledAt, intervalMs: 1_000 },
    })));

    assert.deepEqual(await snapshot(playerId), before);
    const afterBot = await db.query(
      'SELECT run_total_usdd, run_total_coins, next_run_at FROM trading_bots WHERE player_id = $1', [playerId]
    );
    assert.deepEqual(afterBot.rows, beforeBot.rows);
  });

  await run('two players serialize trades against the same shared pool', async () => {
    const poolBefore = { ...state.coins.btcr.pool };
    const [a, b] = await Promise.all([
      executeTrade(state, 'atomic_pool_a', { coinId: 'btcr', side: 'buy', amountUsdd: 20, requestId: 'a-buy' }),
      executeTrade(state, 'atomic_pool_b', { coinId: 'btcr', side: 'buy', amountUsdd: 20, requestId: 'b-buy' }),
    ]);
    const holdingA = (await getHolding('atomic_pool_a', 'btcr'))!.amount;
    const holdingB = (await getHolding('atomic_pool_b', 'btcr'))!.amount;
    assert.ok(Math.abs(holdingA + holdingB - (poolBefore.coinReserve - state.coins.btcr.pool.coinReserve)) < 1e-9);
    assert.ok(Math.abs(holdingA + holdingB - a.coinAmount - b.coinAmount) < 1e-9);
  });

  await run('manual trade and bot share the same serialized execution path', async () => {
    const playerId = 'atomic_manual_bot';
    await ensurePlayerExists(playerId);
    await configureTradingBot(playerId, 'btcr', 'buy', 1_000, 5);
    await setTradingBotEnabled(playerId, true);
    await db.query('UPDATE trading_bots SET next_run_at = $2 WHERE player_id = $1', [playerId, new Date(Date.now() - 120_000).toISOString()]);
    const [manual] = await Promise.all([
      executeTrade(state, playerId, { coinId: 'btcr', side: 'buy', amountUsdd: 5, requestId: 'manual-buy' }),
      runTradingBots(state),
    ]);
    assert.ok(manual.coinAmount > 0);
    const player = await getPlayer(playerId);
    const bot = await db.query<{ run_total_usdd: number; run_total_coins: number }>(
      'SELECT run_total_usdd, run_total_coins FROM trading_bots WHERE player_id = $1', [playerId]
    );
    assert.equal(player.trades_count, 2);
    assert.equal(player.usdd_balance, 90);
    assert.equal(bot.rows[0].run_total_usdd, 5);
    assert.ok(bot.rows[0].run_total_coins > 0);
  });

  await run('stale t1 poll is a no-op after t1 and t2 have executed', async () => {
    const playerId = 'atomic_stale_bot_poll';
    await ensurePlayerExists(playerId);
    await configureTradingBot(playerId, 'btcr', 'buy', 1_000, 5);
    await setTradingBotEnabled(playerId, true);
    const t1 = new Date(Date.now() - 120_000).toISOString();
    await db.query('UPDATE trading_bots SET next_run_at = $2 WHERE player_id = $1', [playerId, t1]);

    const originalQuery = db.query.bind(db);
    let releaseStale!: () => void;
    let signalStale!: () => void;
    let heldFirstSnapshot = false;
    const staleGate = new Promise<void>(resolve => { releaseStale = resolve; });
    const staleCaptured = new Promise<void>(resolve => { signalStale = resolve; });
    db.query = async (sql, params, options) => {
      if (!heldFirstSnapshot && typeof sql === 'string' && sql.includes('SELECT * FROM trading_bots WHERE enabled = TRUE')) {
        const rows = await originalQuery(sql, params, options);
        heldFirstSnapshot = true;
        signalStale();
        await staleGate;
        return rows;
      }
      return originalQuery(sql, params, options);
    };

    const stalePoll = runTradingBots(state);
    try {
      await staleCaptured;
      db.query = originalQuery;
      await runTradingBots(state);
      const t2 = new Date(Date.now() - 60_000).toISOString();
      await db.query('UPDATE trading_bots SET next_run_at = $2 WHERE player_id = $1', [playerId, t2]);
      await runTradingBots(state);
      releaseStale();
      await stalePoll;
    } finally {
      releaseStale();
      db.query = originalQuery;
    }

    const player = await getPlayer(playerId);
    const bot = await db.query<{ run_total_usdd: number; run_total_coins: number }>(
      'SELECT run_total_usdd, run_total_coins FROM trading_bots WHERE player_id = $1', [playerId]
    );
    assert.equal(player.trades_count, 2);
    assert.equal(player.usdd_balance, 90);
    assert.equal(bot.rows[0].run_total_usdd, 10);
    assert.ok(bot.rows[0].run_total_coins > 0);
  });

  await run('overlapping polls of one due bot commit it only once', async () => {
    const playerId = 'atomic_overlapping_bot_polls';
    await ensurePlayerExists(playerId);
    await configureTradingBot(playerId, 'btcr', 'buy', 1_000, 5);
    await setTradingBotEnabled(playerId, true);
    await db.query('UPDATE trading_bots SET next_run_at = $2 WHERE player_id = $1', [playerId, new Date(Date.now() - 60_000).toISOString()]);

    const originalQuery = db.query.bind(db);
    let snapshots = 0;
    let releaseBoth!: () => void;
    let signalBoth!: () => void;
    const pollGate = new Promise<void>(resolve => { releaseBoth = resolve; });
    const bothCaptured = new Promise<void>(resolve => { signalBoth = resolve; });
    db.query = async (sql, params, options) => {
      if (typeof sql === 'string' && sql.includes('SELECT * FROM trading_bots WHERE enabled = TRUE')) {
        const rows = await originalQuery(sql, params, options);
        snapshots++;
        if (snapshots <= 2) {
          if (snapshots === 2) signalBoth();
          await pollGate;
        }
        return rows;
      }
      return originalQuery(sql, params, options);
    };
    try {
      const pollA = runTradingBots(state);
      const pollB = runTradingBots(state);
      await bothCaptured;
      releaseBoth();
      await Promise.all([pollA, pollB]);
    } finally {
      releaseBoth();
      db.query = originalQuery;
    }

    const player = await getPlayer(playerId);
    const bot = await db.query<{ run_total_usdd: number }>(
      'SELECT run_total_usdd FROM trading_bots WHERE player_id = $1', [playerId]
    );
    assert.equal(player.trades_count, 1);
    assert.equal(player.usdd_balance, 95);
    assert.equal(bot.rows[0].run_total_usdd, 5);
  });

  await run('tick and snapshot wait until an in-flight trade commits', async () => {
    const playerId = 'atomic_trade_tick_snapshot';
    let signalReached!: () => void;
    const reached = new Promise<void>(resolve => { signalReached = resolve; });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const originalTransaction = db.transaction.bind(db);
    let blocked = false;
    (db as any).transaction = (callback: (tx: any) => Promise<unknown>) => originalTransaction((tx: any) => callback(new Proxy(tx, {
      get(target, property) {
        if (property === 'query') return async (sql: string, params?: unknown[], options?: unknown) => {
          if (!blocked && sql.includes('UPDATE players SET usdd_balance = usdd_balance -')) {
            blocked = true;
            signalReached();
            await gate;
          }
          return target.query(sql, params, options);
        };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    })));
    const tickCountBefore = state.tickCount;
    const trade = executeTrade(state, playerId, { coinId: 'btcr', side: 'buy', amountUsdd: 10, requestId: 'blocked-buy' });
    try {
      await reached;
      const tickJob = (await import('../../src/engine/marketLock.js')).withMarketLock(() => tick(state));
      const snapshotJob = persistPoolSnapshots(state);
      await Promise.resolve();
      assert.equal(state.tickCount, tickCountBefore);
      release();
      await Promise.all([trade, tickJob, snapshotJob]);
    } finally {
      release();
      (db as any).transaction = originalTransaction;
    }
    assert.equal(state.tickCount, tickCountBefore + 1);
    const durable = (await getAllPoolSnapshots()).find(row => row.coin_id === 'btcr')!;
    assert.equal(durable.coin_reserve, state.coins.btcr.pool.coinReserve);
    assert.equal(durable.usdd_reserve, state.coins.btcr.pool.usddReserve);
  });

  await run('50 concurrent players commit exactly one trade each', async () => {
    const poolBefore = { ...state.coins.btcr.pool };
    const ids = Array.from({ length: 50 }, (_, i) => `atomic_burst_${i}`);
    const trades = await Promise.all(ids.map((playerId, i) => executeTrade(state, playerId, {
      coinId: 'btcr', side: 'buy', amountUsdd: 1, requestId: `burst-${i}`,
    })));
    const players = await Promise.all(ids.map(playerId => getPlayer(playerId)));
    assert.ok(players.every(player => player.trades_count === 1 && Math.abs(player.usdd_balance - 99) < 1e-9));
    const totalBought = trades.reduce((sum, trade) => sum + trade.coinAmount, 0);
    assert.ok(Math.abs(totalBought - (poolBefore.coinReserve - state.coins.btcr.pool.coinReserve)) < 1e-9);
    const durable = (await getAllPoolSnapshots()).find(row => row.coin_id === 'btcr')!;
    assert.equal(durable.coin_reserve, state.coins.btcr.pool.coinReserve);
    assert.equal(durable.usdd_reserve, state.coins.btcr.pool.usddReserve);
  });

  await run('hard process exit after commit restores the committed trade pool', async () => {
    const playerId = 'atomic_restart';
    await db.close();
    const childSource = `
      const { initDb } = await import('./server/src/db/index.ts');
      const { createInitialState } = await import('./server/src/engine/state.ts');
      const { executeTrade } = await import('./server/src/engine/trade.ts');
      await initDb();
      const result = await executeTrade(createInitialState(), ${JSON.stringify(playerId)}, {
        coinId: 'btcr', side: 'buy', amountUsdd: 10, requestId: 'hard-crash-buy',
      });
      if (!(result.coinAmount > 0)) process.exit(2);
      process.exit(0);
    `;
    const child = spawnSync(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '-e', childSource], {
      cwd: projectRoot,
      env: { ...process.env, PGDATA_DIR: crashDataDir, NODE_ENV: 'test' },
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(child.status, 0, child.stderr || child.error?.message);
    reopenedDb = new PGlite(crashDataDir);
    await reopenedDb.waitReady;
    const pool = await reopenedDb.query<{ coin_reserve: number; usdd_reserve: number }>(
      "SELECT coin_reserve, usdd_reserve FROM coin_pools WHERE coin_id = 'btcr'"
    );
    const holding = await reopenedDb.query<{ amount: number }>(
      'SELECT amount FROM player_holdings WHERE player_id = $1 AND coin_id = $2', [playerId, 'btcr']
    );
    const player = await reopenedDb.query<{ usdd_balance: number; trades_count: number }>(
      'SELECT usdd_balance, trades_count FROM players WHERE id = $1', [playerId]
    );
    assert.ok(pool.rows[0].coin_reserve < 12_000_000);
    assert.ok(pool.rows[0].usdd_reserve > 480_000_000_000);
    assert.ok(holding.rows[0].amount > 0);
    assert.equal(player.rows[0].usdd_balance, 90);
    assert.equal(player.rows[0].trades_count, 1);
  });
}

try {
  await main();
  console.log(`ATOMIC TRADE TESTS: ${results.length} passed`);
} catch (error) {
  console.error('ATOMIC TRADE TEST FAILURE', error);
  process.exitCode = 1;
} finally {
  if (server?.listening) await new Promise<void>(resolve => server!.close(() => resolve()));
  if (reopenedDb && !reopenedDb.closed) await reopenedDb.close();
  if (!db.closed) await db.close();
  if (originalPgDataDir === undefined) delete process.env.PGDATA_DIR;
  else process.env.PGDATA_DIR = originalPgDataDir;
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(crashDataDir, { recursive: true, force: true });
}
