import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { createServer, Server } from 'node:http';

const originalPgDataDir = process.env.PGDATA_DIR;
const originalNodeEnv = process.env.NODE_ENV;
const temporaryDbDir = await mkdtemp(path.join(tmpdir(), 'crypto-sim-numeric-tests-'));
process.env.PGDATA_DIR = temporaryDbDir;
process.env.NODE_ENV = 'test';

const { initDb, db } = await import('../../src/db/index.js');
const { createInitialState } = await import('../../src/engine/state.js');
const { createRouter } = await import('../../src/api/routes.js');
const { executeTrade, TradeError } = await import('../../src/engine/trade.js');
const { buyWithUsdd, sellCoin, quoteBuy, quoteSell, price } = await import('../../src/engine/amm.js');

const omitted = Symbol('omitted');
const invalidHttpValues: unknown[] = ['abc', '', null, omitted, {}, [], ['1'], '100'];
const invalidNumbers = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -1];
const coinId = 'btcr';
const results: { name: string; error?: unknown }[] = [];
let server: Server | null = null;
let state = createInitialState();
let requestNumber = 0;

function resetState(): void {
  Object.assign(state, createInitialState());
}

function playerId(): string {
  requestNumber += 1;
  return `dev_numeric_${requestNumber}`;
}

async function run(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    results.push({ name });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, error });
    console.error(`FAIL ${name}`, error);
  }
}

async function http(method: 'GET' | 'POST', player: string, endpoint: string, body?: unknown) {
  const response = await fetch(`http://127.0.0.1:${server!.address()!.port}/api${endpoint}`, {
    method,
    headers: { 'content-type': 'application/json', 'X-Dev-Player-Id': player },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function snapshot(player: string) {
  const query = await db.query<{
    usdd_balance: number;
    amount: number | null;
    trades_count: number;
    total_volume: number;
    total_fees_paid: number;
    realized_pnl: number;
  }>(
    `SELECT p.usdd_balance, h.amount, p.trades_count, p.total_volume, p.total_fees_paid, p.realized_pnl
     FROM players p LEFT JOIN player_holdings h ON h.player_id = p.id AND h.coin_id = $1
     WHERE p.id = $2`,
    [coinId, player],
  );
  const row = query.rows[0];
  const pool = state.coins[coinId].pool;
  return {
    reserveCoin: pool.coinReserve,
    reserveUsdd: pool.usddReserve,
    price: price(pool),
    playerOwnedCoins: state.coins[coinId].playerOwnedCoins,
    balance: row.usdd_balance,
    holding: row.amount ?? 0,
    tradesCount: row.trades_count,
    totalVolume: row.total_volume,
    totalFeesPaid: row.total_fees_paid,
    realizedPnl: row.realized_pnl,
  };
}

function assertFiniteSnapshot(value: Awaited<ReturnType<typeof snapshot>>): void {
  for (const number of Object.values(value)) assert.ok(Number.isFinite(number), `non-finite state: ${JSON.stringify(value)}`);
}

function withAmount(side: 'buy' | 'sell', field: 'amountUsdd' | 'amountCoin', value: unknown) {
  const body: Record<string, unknown> = { coinId, side };
  if (value !== omitted) body[field] = value;
  return body;
}

async function main(): Promise<void> {
  await initDb();
  const app = express();
  app.use(express.json());
  app.use('/api', createRouter(state));
  server = createServer(app);
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));

  await run('AMM rejects invalid BUY/SELL inputs without mutating reserves', () => {
    for (const value of invalidNumbers) {
      for (const operation of [buyWithUsdd, sellCoin]) {
        const pool = { coinReserve: 100, usddReserve: 200 };
        const before = { ...pool };
        assert.throws(() => operation(pool, value));
        assert.deepEqual(pool, before);
        assert.equal(price(pool), 2);
      }
    }
    for (const invalidPool of [
      { coinReserve: Number.NaN, usddReserve: 200 },
      { coinReserve: 100, usddReserve: Number.POSITIVE_INFINITY },
      { coinReserve: 0, usddReserve: 200 },
      { coinReserve: -1, usddReserve: 200 },
    ]) {
      for (const operation of [buyWithUsdd, sellCoin]) {
        const before = { ...invalidPool };
        assert.throws(() => operation(invalidPool, 1));
        assert.deepEqual(invalidPool, before);
      }
    }
  });

  await run('quote functions reject non-finite/non-positive internal amounts', () => {
    for (const value of invalidNumbers) {
      assert.throws(() => quoteBuy({ coinReserve: 100, usddReserve: 200 }, value));
      assert.throws(() => quoteSell({ coinReserve: 100, usddReserve: 200 }, value));
    }
  });

  await run('BUY REST rejects non-number JSON values without financial side effects', async () => {
    for (const value of invalidHttpValues) {
      resetState();
      const player = playerId();
      await http('GET', player, '/portfolio');
      const before = await snapshot(player);
      const result = await http('POST', player, '/trade', withAmount('buy', 'amountUsdd', value));
      assert.equal(result.status, 400, JSON.stringify(value));
      assert.deepEqual(await snapshot(player), before);
      if (value !== omitted) {
        const extraFieldResult = await http('POST', player, '/trade', {
          coinId, side: 'buy', amountUsdd: 10, amountCoin: value,
        });
        assert.equal(extraFieldResult.status, 400, `extra amountCoin=${String(value)}`);
        assert.deepEqual(await snapshot(player), before);
      }
      assertFiniteSnapshot(before);
    }
  });

  await run('SELL amountCoin REST rejects non-number JSON values without side effects', async () => {
    for (const value of invalidHttpValues) {
      resetState();
      const player = playerId();
      const seeded = await http('POST', player, '/trade', { coinId, side: 'buy', amountUsdd: 10 });
      assert.equal(seeded.status, 200);
      const before = await snapshot(player);
      const result = await http('POST', player, '/trade', withAmount('sell', 'amountCoin', value));
      assert.equal(result.status, 400, JSON.stringify(value));
      assert.deepEqual(await snapshot(player), before);
      if (value !== omitted) {
        const extraFieldResult = await http('POST', player, '/trade', {
          coinId, side: 'sell', amountCoin: 1e-8, amountUsdd: value,
        });
        assert.equal(extraFieldResult.status, 400, `extra amountUsdd=${String(value)}`);
        assert.deepEqual(await snapshot(player), before);
      }
      assertFiniteSnapshot(before);
    }
  });

  await run('SELL amountUsdd REST rejects non-number JSON values without side effects', async () => {
    for (const value of invalidHttpValues) {
      resetState();
      const player = playerId();
      const seeded = await http('POST', player, '/trade', { coinId, side: 'buy', amountUsdd: 10 });
      assert.equal(seeded.status, 200);
      const before = await snapshot(player);
      const result = await http('POST', player, '/trade', withAmount('sell', 'amountUsdd', value));
      assert.equal(result.status, 400, JSON.stringify(value));
      assert.deepEqual(await snapshot(player), before);
      assertFiniteSnapshot(before);
    }
  });

  await run('BUY, SELL coin and SELL USDD quote reject non-number JSON values', async () => {
    for (const value of invalidHttpValues) {
      for (const [side, field] of [
        ['buy', 'amountUsdd'],
        ['sell', 'amountCoin'],
        ['sell', 'amountUsdd'],
      ] as const) {
        resetState();
        const before = { ...state.coins[coinId].pool };
        const result = await http('POST', playerId(), '/trade/quote', withAmount(side, field, value));
        assert.equal(result.status, 400, `${side}.${field}=${String(value)}`);
        assert.deepEqual(state.coins[coinId].pool, before);
        assert.ok(Object.values(result.body).every(v => v !== null));
        if (value !== omitted) {
          const mixedBody = side === 'buy'
            ? { coinId, side, amountUsdd: 10, amountCoin: value }
            : { coinId, side, amountCoin: 1e-8, amountUsdd: value };
          const mixedResult = await http('POST', playerId(), '/trade/quote', mixedBody);
          assert.equal(mixedResult.status, 400, `mixed ${side} amount=${String(value)}`);
        }
      }
    }
  });

  await run('executeTrade rejects NaN, infinities, zero and negatives at its boundary', async () => {
    for (const value of invalidNumbers) {
      resetState();
      const player = playerId();
      await http('GET', player, '/portfolio');
      const beforeBuy = await snapshot(player);
      await assert.rejects(
        executeTrade(state, player, { coinId, side: 'buy', amountUsdd: value }),
        TradeError,
      );
      assert.deepEqual(await snapshot(player), beforeBuy);

      const seeded = await http('POST', player, '/trade', { coinId, side: 'buy', amountUsdd: 10 });
      assert.equal(seeded.status, 200);
      const beforeSell = await snapshot(player);
      await assert.rejects(
        executeTrade(state, player, { coinId, side: 'sell', amountCoin: value }),
        TradeError,
      );
      assert.deepEqual(await snapshot(player), beforeSell);
      await assert.rejects(
        executeTrade(state, player, { coinId, side: 'sell', amountUsdd: value }),
        TradeError,
      );
      assert.deepEqual(await snapshot(player), beforeSell);
      assertFiniteSnapshot(beforeSell);
    }
  });

  await run('valid numeric BUY, SELL and quotes still work', async () => {
    resetState();
    const player = playerId();
    const beforeBuy = await snapshotAfterEnsure(player);
    const quoteBuyResult = await http('POST', player, '/trade/quote', { coinId, side: 'buy', amountUsdd: 10 });
    assert.equal(quoteBuyResult.status, 200);
    const buy = await http('POST', player, '/trade', { coinId, side: 'buy', amountUsdd: 10 });
    assert.equal(buy.status, 200);
    assert.ok(Number.isFinite(buy.body.coinAmount as number));
    assert.ok((await snapshot(player)).holding > beforeBuy.holding);

    const amountCoin = (buy.body.coinAmount as number) / 2;
    const quoteSellResult = await http('POST', player, '/trade/quote', { coinId, side: 'sell', amountCoin });
    assert.equal(quoteSellResult.status, 200);
    const quoteSellUsddResult = await http('POST', player, '/trade/quote', { coinId, side: 'sell', amountUsdd: 1 });
    assert.equal(quoteSellUsddResult.status, 200);
    const beforeSell = await snapshot(player);
    const sell = await http('POST', player, '/trade', { coinId, side: 'sell', amountCoin });
    assert.equal(sell.status, 200);
    assert.ok(Number.isFinite(sell.body.usddAmount as number));
    assert.ok((await snapshot(player)).holding < beforeSell.holding);

    const remaining = await snapshot(player);
    const sellInUsdd = price(state.coins[coinId].pool) * remaining.holding / 4;
    const sellUsdd = await http('POST', player, '/trade', { coinId, side: 'sell', amountUsdd: sellInUsdd });
    assert.equal(sellUsdd.status, 200);
    assert.ok(Number.isFinite(sellUsdd.body.usddAmount as number));
  });

  await run('microscopic positive SELL can still succeed with zero USDD output', async () => {
    resetState();
    const player = playerId();
    const seeded = await http('POST', player, '/trade', { coinId, side: 'buy', amountUsdd: 10 });
    assert.equal(seeded.status, 200);
    const before = await snapshot(player);
    const tinySell = await http('POST', player, '/trade', { coinId, side: 'sell', amountCoin: 1e-100 });
    const after = await snapshot(player);
    assert.equal(tinySell.status, 200);
    assert.equal(tinySell.body.usddAmount, 0);
    assert.equal(tinySell.body.fee, 0);
    assert.equal(after.tradesCount, before.tradesCount + 1);
    assert.equal(after.balance, before.balance);
    assert.equal(after.holding, before.holding);
    assert.equal(after.totalVolume, before.totalVolume);
    assert.equal(after.totalFeesPaid, before.totalFeesPaid);
    assert.ok(Number.isFinite(after.realizedPnl));
    assert.ok(after.realizedPnl < before.realizedPnl);
    assert.ok(Math.abs(after.realizedPnl - before.realizedPnl) < 1e-90);
    const tradeLog = await db.query<{ usdd_amount: number; fee: number }>(
      'SELECT usdd_amount, fee FROM trade_log WHERE player_id = $1 ORDER BY id DESC LIMIT 1',
      [player],
    );
    assert.equal(tradeLog.rows[0].usdd_amount, 0);
    assert.equal(tradeLog.rows[0].fee, 0);
  });

  const failed = results.filter(result => result.error);
  console.log(`NUMERIC TESTS: ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exitCode = 1;
}

async function snapshotAfterEnsure(player: string) {
  await http('GET', player, '/portfolio');
  return snapshot(player);
}

try {
  await main();
} finally {
  if (server?.listening) await new Promise<void>(resolve => server!.close(() => resolve()));
  await db.close();
  if (originalPgDataDir === undefined) delete process.env.PGDATA_DIR;
  else process.env.PGDATA_DIR = originalPgDataDir;
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  await rm(temporaryDbDir, { recursive: true, force: true });
}