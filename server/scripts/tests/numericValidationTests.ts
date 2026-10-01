import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { createServer, Server } from 'node:http';
import { MIN_TRADE_USDD } from '../../src/config/coins.js';

const originalPgDataDir = process.env.PGDATA_DIR;
const originalNodeEnv = process.env.NODE_ENV;
const temporaryDbDir = await mkdtemp(path.join(tmpdir(), 'crypto-sim-numeric-tests-'));
process.env.PGDATA_DIR = temporaryDbDir;
process.env.NODE_ENV = 'test';

const { initDb, db } = await import('../../src/db/index.js');
const { createInitialState } = await import('../../src/engine/state.js');
const { createRouter } = await import('../../src/api/routes.js');
const { executeTrade, TradeError } = await import('../../src/engine/trade.js');
const { buyWithUsdd, sellCoin, quoteBuy, quoteSell, quoteSellExecution, price } = await import('../../src/engine/amm.js');

const omitted = Symbol('omitted');
const invalidHttpValues: unknown[] = ['abc', '', null, omitted, {}, [], ['1'], '100'];
const invalidNumbers = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -1];
const coinId = 'btcr';
const results: { name: string; error?: unknown }[] = [];
let server: Server | null = null;
let state = createInitialState();
let requestNumber = 0;
let tradeRequestNumber = 0;

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
  const requestBody = endpoint === '/trade' && body && typeof body === 'object' && !Array.isArray(body)
    ? { ...body, requestId: `numeric-${++tradeRequestNumber}` }
    : body;
  const response = await fetch(`http://127.0.0.1:${server!.address()!.port}/api${endpoint}`, {
    method,
    headers: { 'content-type': 'application/json', 'X-Dev-Player-Id': player },
    body: requestBody === undefined ? undefined : JSON.stringify(requestBody),
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
  const tradeLog = await db.query<{ count: number }>(
    'SELECT COUNT(*)::int AS count FROM trade_log WHERE player_id = $1',
    [player],
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
    tradeLogCount: tradeLog.rows[0].count,
  };
}

function assertFiniteSnapshot(value: Awaited<ReturnType<typeof snapshot>>): void {
  for (const number of Object.values(value)) assert.ok(Number.isFinite(number), `non-finite state: ${JSON.stringify(value)}`);
}

function assertClose(actual: number, expected: number, tolerance = 1e-10): void {
  assert.ok(Math.abs(actual - expected) <= Math.max(tolerance, Math.abs(expected) * tolerance), `${actual} != ${expected}`);
}

function withAmount(side: 'buy' | 'sell', field: 'amountUsdd' | 'amountCoin', value: unknown) {
  const body: Record<string, unknown> = { coinId, side };
  if (value !== omitted) body[field] = value;
  return body;
}

function amountForGrossOutput(
  pool: { coinReserve: number; usddReserve: number },
  maxCoinAmount: number,
  target: number
): number {
  assert.ok(quoteSellExecution(pool, maxCoinAmount).usddAmount >= target);
  let low = 0;
  let high = maxCoinAmount;
  for (let i = 0; i < 80; i++) {
    const mid = (low + high) / 2;
    if (quoteSellExecution(pool, mid).usddAmount < target) low = mid;
    else high = mid;
  }
  return high;
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
      const pool = { coinReserve: 100, usddReserve: 200 };
      assert.throws(() => quoteSellExecution(pool, value));
      assert.deepEqual(pool, { coinReserve: 100, usddReserve: 200 });
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

  await run('BUY rejects below MIN_TRADE_USDD and allows the boundary', async () => {
    for (const amount of [0.01, 0.99, MIN_TRADE_USDD - Number.EPSILON]) {
      resetState();
      const player = playerId();
      await http('GET', player, '/portfolio');
      const before = await snapshot(player);
      const quote = await http('POST', player, '/trade/quote', { coinId, side: 'buy', amountUsdd: amount });
      assert.equal(quote.status, 400);
      assert.match(String(quote.body.error), /minimum trade size/i);
      assert.deepEqual(await snapshot(player), before);
      const trade = await http('POST', player, '/trade', { coinId, side: 'buy', amountUsdd: amount });
      assert.equal(trade.status, 400);
      assert.deepEqual(await snapshot(player), before);
      await assert.rejects(
        executeTrade(state, player, { coinId, side: 'buy', amountUsdd: amount }),
        TradeError,
      );
      assert.deepEqual(await snapshot(player), before);
    }

    for (const amount of [MIN_TRADE_USDD, 1.01, 100]) {
      resetState();
      const player = playerId();
      const quote = await http('POST', player, '/trade/quote', { coinId, side: 'buy', amountUsdd: amount });
      assert.equal(quote.status, 200);
      const trade = await http('POST', player, '/trade', { coinId, side: 'buy', amountUsdd: amount });
      assert.equal(trade.status, 200);
      assert.equal((await snapshot(player)).tradesCount, 1);
    }
  });

  await run('SELL requires at least MIN_TRADE_USDD gross AMM output', async () => {
    resetState();
    const player = playerId();
    const seeded = await http('POST', player, '/trade', { coinId, side: 'buy', amountUsdd: 10 });
    assert.equal(seeded.status, 200);

    for (const coinAmount of [1e-100, amountForGrossOutput(state.coins[coinId].pool, (await snapshot(player)).holding, MIN_TRADE_USDD - 0.01)]) {
      const before = await snapshot(player);
      assert.ok(quoteSellExecution(state.coins[coinId].pool, coinAmount).usddAmount < MIN_TRADE_USDD);

      const quote = await http('POST', player, '/trade/quote', { coinId, side: 'sell', amountCoin: coinAmount });
      assert.equal(quote.status, 400);
      assert.deepEqual(await snapshot(player), before);

      await assert.rejects(
        executeTrade(state, player, { coinId, side: 'sell', amountCoin: coinAmount }),
        TradeError,
      );
      assert.deepEqual(await snapshot(player), before);

      const trade = await http('POST', player, '/trade', { coinId, side: 'sell', amountCoin: coinAmount });
      assert.equal(trade.status, 400);
      assert.match(String(trade.body.error), /minimum trade size/i);
      assert.deepEqual(await snapshot(player), before);
    }

    const belowCoinAmount = amountForGrossOutput(
      state.coins[coinId].pool,
      (await snapshot(player)).holding,
      MIN_TRADE_USDD - 0.01,
    );
    const belowUsddAmount = belowCoinAmount * price(state.coins[coinId].pool);
    const belowUsddCoinInput = belowUsddAmount / price(state.coins[coinId].pool);
    assert.ok(quoteSellExecution(state.coins[coinId].pool, belowUsddCoinInput).usddAmount < MIN_TRADE_USDD);
    const beforeBelowUsdd = await snapshot(player);
    const quoteBelowUsdd = await http('POST', player, '/trade/quote', { coinId, side: 'sell', amountUsdd: belowUsddAmount });
    assert.equal(quoteBelowUsdd.status, 400);
    const tradeBelowUsdd = await http('POST', player, '/trade', { coinId, side: 'sell', amountUsdd: belowUsddAmount });
    assert.equal(tradeBelowUsdd.status, 400);
    assert.deepEqual(await snapshot(player), beforeBelowUsdd);

    const pool = state.coins[coinId].pool;
    const holding = (await snapshot(player)).holding;
    const atMinimum = amountForGrossOutput(pool, holding, MIN_TRADE_USDD);
    assert.ok(quoteSellExecution(pool, atMinimum).usddAmount >= MIN_TRADE_USDD);
    const beforeAtMinimum = await snapshot(player);
    const quoteAtMinimum = await http('POST', player, '/trade/quote', { coinId, side: 'sell', amountCoin: atMinimum });
    assert.equal(quoteAtMinimum.status, 200);
    assert.deepEqual(await snapshot(player), beforeAtMinimum);
    const tradeAtMinimum = await executeTrade(state, player, { coinId, side: 'sell', amountCoin: atMinimum });
    assert.ok(tradeAtMinimum.usddAmount + tradeAtMinimum.fee >= MIN_TRADE_USDD);
    const afterAtMinimum = await snapshot(player);
    assert.equal(afterAtMinimum.tradesCount, beforeAtMinimum.tradesCount + 1);
    assert.equal(afterAtMinimum.tradeLogCount, beforeAtMinimum.tradeLogCount + 1);

    const currentPool = state.coins[coinId].pool;
    const remainingHolding = (await snapshot(player)).holding;
    const aboveMinimumCoin = amountForGrossOutput(currentPool, remainingHolding, MIN_TRADE_USDD + 0.01);
    const aboveMinimumUsdd = aboveMinimumCoin * price(currentPool);
    const beforeUsddSell = await snapshot(player);
    const quoteAboveUsdd = await http('POST', player, '/trade/quote', { coinId, side: 'sell', amountUsdd: aboveMinimumUsdd });
    assert.equal(quoteAboveUsdd.status, 200);
    const tradeAboveUsdd = await http('POST', player, '/trade', { coinId, side: 'sell', amountUsdd: aboveMinimumUsdd });
    assert.equal(tradeAboveUsdd.status, 200);
    assert.ok((await snapshot(player)).tradesCount === beforeUsddSell.tradesCount + 1);
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
    const quoteSellUsddResult = await http('POST', player, '/trade/quote', { coinId, side: 'sell', amountUsdd: 2 });
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

  await run('BUY quote matches execution below and above liquidity cap', async () => {
    for (const capped of [false, true]) {
      resetState();
      const player = playerId();
      await snapshotAfterEnsure(player);
      const requested = capped ? state.coins[coinId].pool.usddReserve : 100;
      await db.query('UPDATE players SET usdd_balance = $1 WHERE id = $2', [requested * 1.1, player]);

      const quote = await http('POST', player, '/trade/quote', { coinId, side: 'buy', amountUsdd: requested });
      assert.equal(quote.status, 200);
      assert.equal(quote.body.liquidityCapApplied, capped);
      assert.equal(quote.body.requestedAmount, requested);
      assert.equal(quote.body.requestedUnit, 'usdd');
      assert.equal(quote.body.executedUnit, 'usdd');
      if (capped) assert.ok((quote.body.executedAmount as number) < requested);
      else assertClose(quote.body.executedAmount as number, requested);

      const before = await snapshot(player);
      const trade = await http('POST', player, '/trade', { coinId, side: 'buy', amountUsdd: requested });
      assert.equal(trade.status, 200);
      assertClose(quote.body.expectedCoinOut as number, trade.body.coinAmount as number);
      assertClose(quote.body.executedAmount as number, (trade.body.usddAmount as number) + (trade.body.fee as number));
      const after = await snapshot(player);
      assertClose(before.balance - after.balance, quote.body.executedAmount as number);
      if (capped) assert.ok(after.balance > before.balance - requested);
      else assertClose(after.balance, before.balance - requested);
    }
  });

  await run('SELL quote matches execution below and above liquidity cap', async () => {
    resetState();
    const ordinaryPlayer = playerId();
    const seeded = await http('POST', ordinaryPlayer, '/trade', { coinId, side: 'buy', amountUsdd: 100 });
    assert.equal(seeded.status, 200);
    const ordinaryAmount = (await snapshot(ordinaryPlayer)).holding / 2;
    const ordinaryQuote = await http('POST', ordinaryPlayer, '/trade/quote', { coinId, side: 'sell', amountCoin: ordinaryAmount });
    assert.equal(ordinaryQuote.status, 200);
    assert.equal(ordinaryQuote.body.liquidityCapApplied, false);
    assert.equal(ordinaryQuote.body.requestedAmount, ordinaryAmount);
    assert.equal(ordinaryQuote.body.requestedUnit, 'coin');
    assert.equal(ordinaryQuote.body.executedUnit, 'coin');
    const ordinaryTrade = await http('POST', ordinaryPlayer, '/trade', { coinId, side: 'sell', amountCoin: ordinaryAmount });
    assert.equal(ordinaryTrade.status, 200);
    assertClose(ordinaryQuote.body.executedAmount as number, ordinaryTrade.body.coinAmount as number);
    assertClose(ordinaryQuote.body.expectedUsddOut as number, ordinaryTrade.body.usddAmount as number);

    const cappedPlayer = playerId();
    await http('GET', cappedPlayer, '/portfolio');
    const requested = state.coins[coinId].pool.coinReserve * 0.8;
    await db.query(
      'INSERT INTO player_holdings (player_id, coin_id, amount, avg_buy_price) VALUES ($1, $2, $3, $4)',
      [cappedPlayer, coinId, requested, 10]
    );
    const before = await snapshot(cappedPlayer);
    const quote = await http('POST', cappedPlayer, '/trade/quote', { coinId, side: 'sell', amountCoin: requested });
    assert.equal(quote.status, 200);
    assert.equal(quote.body.liquidityCapApplied, true);
    assert.equal(quote.body.requestedAmount, requested);
    assert.equal(quote.body.requestedUnit, 'coin');
    assert.equal(quote.body.executedUnit, 'coin');
    assert.ok((quote.body.executedAmount as number) < requested);

    const trade = await http('POST', cappedPlayer, '/trade', { coinId, side: 'sell', amountCoin: requested });
    assert.equal(trade.status, 200);
    assertClose(quote.body.executedAmount as number, trade.body.coinAmount as number);
    assertClose(quote.body.expectedUsddOut as number, trade.body.usddAmount as number);
    const after = await snapshot(cappedPlayer);
    assertClose(before.holding - after.holding, quote.body.executedAmount as number);
    assert.ok(after.holding > 0);
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