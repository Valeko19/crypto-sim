import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import express from 'express';
import ts from 'typescript';

process.env.PGDATA_DIR = 'memory://';
process.env.NODE_ENV = 'production';
delete process.env.ALLOW_DEV_AUTH;
const { db, initDb } = await import('../../src/db/index.js');
const { ensurePlayer, getPlayer, getHolding } = await import('../../src/db/queries.js');
const { createAuthSession } = await import('../../src/auth/sessions.js');
const { createRouter } = await import('../../src/api/routes.js');
const { createInitialState } = await import('../../src/engine/state.js');
const { persistPoolSnapshots } = await import('../../src/engine/poolPersistence.js');
const { COINS, tradeFeePct, MIN_TRADE_USDD } = await import('../../src/config/coins.js');
const state = createInitialState();
const app = express();
app.use(express.json());
app.use('/api', createRouter(state));
const server = createServer(app);
let port: number;
let sequence = 0;
let requests = 0;
let passed = 0;

async function run(name: string, test: () => Promise<void>) {
  await test(); passed++; console.log(`PASS ${name}`);
}

async function fixture(balance: number, coinId = 'btcr', capped = false) {
  await db.query('DELETE FROM player_holdings');
  Object.assign(state, createInitialState());
  if (capped) state.coins[coinId].pool = { coinReserve: 1000, usddReserve: 1 };
  const id = `tg_max_buy_${++sequence}`;
  await ensurePlayer(id, id);
  await db.query('UPDATE players SET usdd_balance = $1 WHERE id = $2', [balance, id]);
  const { sessionToken: token } = await createAuthSession(id);
  await persistPoolSnapshots(state);
  return { id, token, coinId };
}

async function post(f: Awaited<ReturnType<typeof fixture>>, endpoint: string, extra: Record<string, unknown> = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/api${endpoint}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Session-Token': f.token },
    body: JSON.stringify({ coinId: f.coinId, side: 'buy', requestId: `max-buy-${++requests}`, ...extra }),
    signal: AbortSignal.timeout(15_000),
  });
  return { status: response.status, body: await response.json() as Record<string, any> };
}

function near(actual: number, expected: number) {
  assert.ok(Math.abs(actual - expected) <= Math.max(1, Math.abs(expected)) * 1e-12, `${actual} != ${expected}`);
}

async function main() {
  const coinIds = ['btcr', COINS.find(coin => coin.feePctOverride === 0.05)!.id];
  for (const coinId of coinIds) {
    for (const capped of [false, true]) {
      for (const balance of [100, 100.01, 100.006, 100.004, 1.55, 999.99, 1000, 123.45678901234567]) {
        await run(`MAX BUY ${coinId}, balance ${balance}, cap ${capped}`, async () => {
          const f = await fixture(balance, coinId, capped);
          const initialPool = { ...state.coins[coinId].pool };
          const quote = await post(f, '/trade/quote', { useMax: true });
          assert.equal(quote.status, 200);
          assert.equal(quote.body.requestedAmount, balance);
          assert.equal((await getPlayer(f.id)).usdd_balance, balance, 'quote must not spend');
          assert.deepEqual(state.coins[coinId].pool, initialPool);
          const trade = await post(f, '/trade', { useMax: true });
          assert.equal(trade.status, 200, JSON.stringify(trade.body));
          const after = await getPlayer(f.id);
          assert.ok(after.usdd_balance >= 0);
          assert.equal(trade.body.totalCharged, quote.body.executedAmount);
          assert.equal(trade.body.coinAmount, quote.body.expectedOutput);
          assert.equal(trade.body.fee, quote.body.feeAmount);
          assert.equal(after.usdd_balance, balance - trade.body.totalCharged);
          assert.equal(after.total_volume, trade.body.totalCharged);
          assert.equal(after.total_fees_paid, trade.body.fee);
          assert.equal((await getHolding(f.id, coinId))?.amount, trade.body.coinAmount);
          assert.equal(quote.body.liquidityCapApplied, capped);
          const rate = tradeFeePct(coinId);
          if (!capped) {
            assert.equal(trade.body.totalCharged, balance);
            assert.equal(after.usdd_balance, 0);
            assert.equal(trade.body.fee, balance * rate);
            assert.equal(trade.body.usddAmount, balance - balance * rate);
          } else {
            assert.ok(after.usdd_balance > 0);
            assert.equal(trade.body.coinAmount, initialPool.coinReserve * 0.3);
            const net = initialPool.coinReserve * initialPool.usddReserve / (initialPool.coinReserve * 0.7) - initialPool.usddReserve;
            near(trade.body.usddAmount, net);
            near(trade.body.totalCharged, net / (1 - rate));
            near(trade.body.fee, net * rate / (1 - rate));
          }
          const pool = state.coins[coinId].pool;
          near(pool.coinReserve * pool.usddReserve, initialPool.coinReserve * initialPool.usddReserve);
        });
      }
    }
  }

  await run('MAX resolves the current balance after the quote, ignoring an old numeric hint', async () => {
    for (const current of [50.006, 200.004]) {
      const f = await fixture(100);
      assert.equal((await post(f, '/trade/quote', { useMax: true })).body.requestedAmount, 100);
      await db.query('UPDATE players SET usdd_balance = $1 WHERE id = $2', [current, f.id]);
      const trade = await post(f, '/trade', { useMax: true, amountUsdd: 100 });
      assert.equal(trade.status, 200);
      assert.equal(trade.body.totalCharged, current);
      assert.equal((await getPlayer(f.id)).usdd_balance, 0);
    }
  });

  await run('manual BUY spends only its requested amount, including the 5% rounding edge', async () => {
    for (const coinId of coinIds) {
      const f = await fixture(100, coinId);
      const quote = await post(f, '/trade/quote', { amountUsdd: 1.55 });
      const trade = await post(f, '/trade', { amountUsdd: 1.55, useMax: false });
      assert.equal(trade.status, 200);
      assert.equal(trade.body.totalCharged, 1.55);
      assert.equal(trade.body.totalCharged, quote.body.executedAmount);
      assert.equal((await getPlayer(f.id)).usdd_balance, 100 - 1.55);
      assert.equal((await post(f, '/trade', { amountUsdd: 100.01 })).status, 400);
      assert.equal((await post(f, '/trade')).status, 400, 'missing amount is not implicit MAX');
    }
  });

  await run('MAX respects MIN_TRADE_USDD and does not commit rejected trades', async () => {
    for (const balance of [0, 0.5, MIN_TRADE_USDD - 0.000001]) {
      const f = await fixture(balance);
      const pool = { ...state.coins[f.coinId].pool };
      assert.equal((await post(f, '/trade/quote', { useMax: true })).status, 400);
      assert.equal((await post(f, '/trade', { useMax: true })).status, 400);
      assert.equal((await getPlayer(f.id)).usdd_balance, balance);
      assert.equal(await getHolding(f.id, f.coinId), null);
      assert.deepEqual(state.coins[f.coinId].pool, pool);
      const saved = await db.query('SELECT * FROM trade_requests WHERE player_id = $1', [f.id]);
      assert.equal(saved.rows.length, 0);
    }
    const f = await fixture(MIN_TRADE_USDD);
    assert.equal((await post(f, '/trade', { useMax: true })).status, 200);
    assert.equal((await getPlayer(f.id)).usdd_balance, 0);
  });

  await run('concurrent distinct MAX requests cannot overspend the balance', async () => {
    const f = await fixture(100.006);
    const results = await Promise.all(Array.from({ length: 20 }, () => post(f, '/trade', { useMax: true })));
    assert.equal(results.filter(r => r.status === 200).length, 1);
    assert.equal(results.filter(r => r.status === 400).length, 19);
    const player = await getPlayer(f.id);
    assert.equal(player.usdd_balance, 0);
    assert.equal(player.total_volume, 100.006);
    assert.equal(player.trades_count, 1);
  });

  await run('a MAX request replay returns the original settlement even after the balance changes', async () => {
    const f = await fixture(1.55, coinIds[1]);
    const requestId = 'replayed-max-buy';
    const first = await post(f, '/trade', { useMax: true, requestId });
    assert.equal(first.status, 200);
    await db.query('UPDATE players SET usdd_balance = 100 WHERE id = $1', [f.id]);
    const results = await Promise.all(Array.from({ length: 20 }, () => post(f, '/trade', { useMax: true, requestId })));
    for (const result of results) assert.deepEqual(result, first);
    assert.equal((await getPlayer(f.id)).usdd_balance, 100);
    assert.equal((await getPlayer(f.id)).trades_count, 1);
    assert.equal((await post(f, '/trade', { amountUsdd: 1.55, requestId })).status, 409);
  });

  await run('MAX balance is read through the transaction after the player row lock', async () => {
    const f = await fixture(100);
    const originalTransaction = db.transaction;
    let locked = false;
    db.transaction = (async (fn: Parameters<typeof db.transaction>[0]) => originalTransaction.call(db, async tx => {
      const query = tx.query.bind(tx);
      tx.query = (async (...args: Parameters<typeof tx.query>) => {
        const result = await query(...args);
        if (String(args[0]).includes('FOR UPDATE')) {
          locked = true;
          await query('UPDATE players SET usdd_balance = 100.006 WHERE id = $1', [f.id]);
        }
        return result;
      }) as typeof tx.query;
      return fn(tx);
    })) as typeof db.transaction;
    try {
      const result = await post(f, '/trade', { useMax: true });
      assert.equal(result.status, 200);
      assert.equal(result.body.totalCharged, 100.006);
      assert.equal(locked, true);
    } finally { db.transaction = originalTransaction; }
    assert.equal((await getPlayer(f.id)).usdd_balance, 0);
  });

  await run('client sends explicit MAX without rounded amounts for quote and execution', async () => {
    // Run the actual screen functions with UI/network dependencies replaced.
    const source = readFileSync(new URL('../../../client/src/screens/CoinDetailScreen.tsx', import.meta.url), 'utf8');
    const functions = ['fetchQuote', 'submit'].map(name => source.match(new RegExp(`  async function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`))![0]).join('\n');
    const js = ts.transpileModule(functions, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    for (const isMaxAmount of [true, false]) {
      const sent: Record<string, unknown>[] = [];
      const noop = () => {};
      const api = {
        quoteTrade: async (body: Record<string, unknown>) => { sent.push(body); return {}; },
        trade: async (body: Record<string, unknown>) => { sent.push(body); return { coinAmount: 1, avgPrice: 1 }; },
      };
      const execute = new Function('amount', 'coinId', 'side', 'mode', 'isMaxAmount', 'api', 'setQuote', 'setBusy', 'setMessage', 'refreshPortfolio', 'coin', 'formatPrice', 'formatUsdd', js + '\nreturn (async () => { await fetchQuote(Number(amount)); await submit(); })();');
      await execute('100.01', 'btcr', 'buy', 'usdd', isMaxAmount, api, noop, noop, noop, noop, {}, String, String);
      assert.ok(sent.length >= 2);
      for (const body of sent) assert.deepEqual(body, isMaxAmount
        ? { coinId: 'btcr', side: 'buy', useMax: true }
        : { coinId: 'btcr', side: 'buy', amountUsdd: 100.01 });
    }
  });
}

try {
  await initDb();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
  await main();
  console.log(`MAX BUY TESTS: ${passed} passed`);
} catch (error) {
  console.error('MAX BUY TEST FAILURE', error);
  process.exitCode = 1;
} finally {
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  await db.close();
}
