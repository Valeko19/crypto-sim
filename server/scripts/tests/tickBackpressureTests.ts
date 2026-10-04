import assert from 'node:assert/strict';
process.env.PGDATA_DIR = 'memory://';
process.env.NODE_ENV = 'test';
const { db, initDb } = await import('../../src/db/index.js');
const q = await import('../../src/db/queries.js');
const { COINS } = await import('../../src/config/coins.js');
const { createInitialState } = await import('../../src/engine/state.js');
const { startEngineLoop } = await import('../../src/engine/tick.js');
const { executeTrade } = await import('../../src/engine/trade.js');
const { runTradingBots } = await import('../../src/engine/tradingBot.js');
const { commitMarketMutation } = await import('../../src/engine/marketValuation.js');
const { withMarketState } = await import('../../src/engine/marketRecovery.js');
const state = createInitialState();
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const rawTransaction = db.transaction.bind(db), interval = globalThis.setInterval;
let timer: ReturnType<typeof setInterval> | undefined;
try {
  await initDb();
  for (let i = 0; i < 100; i++) {
    await q.ensurePlayer(`load-${i}`, 'load');
    await db.query('UPDATE players SET usdd_balance=100000 WHERE id=$1', [`load-${i}`]);
    for (const cfg of COINS) await db.query('INSERT INTO player_holdings(player_id,coin_id,amount,avg_buy_price) VALUES ($1,$2,$3,$4)', [`load-${i}`,cfg.id,.000001,cfg.startPrice]);
  }
  for (const cfg of COINS) state.coins[cfg.id].playerOwnedCoins = await q.getTotalHeldForCoin(cfg.id);
  await commitMarketMutation(state, () => {});
  for (const latency of [1800, 3500]) {
    let fires = 0, started = 0, finished = 0, active = 0, maximum = 0, notified = 0, manual = 0;
    // Retain the real one-second scheduler. Count every interval, including
    // coalesced intervals; hold real DB transactions open for the slow tick.
    globalThis.setInterval = ((callback: () => void, ms: number) => {
      assert.equal(ms, 1000);
      return interval(() => { fires++; callback(); }, ms);
    }) as typeof setInterval;
    db.transaction = ((callback: any) => rawTransaction(async tx => {
      let first = true, isTick = false;
      const query = tx.query.bind(tx);
      tx.query = (async (sql: string, ...args: any[]) => {
        if (first) {
          first = false;
          if (sql.includes('INSERT INTO market_valuation_prices')) {
            isTick = true; started++; active++; maximum = Math.max(maximum, active);
            await sleep(latency);
          }
        }
        return (query as any)(sql, ...args);
      }) as typeof tx.query;
      try { return await callback(tx); }
      finally { if (isTick) { finished++; active--; } }
    })) as typeof db.transaction;
    timer = startEngineLoop(state, () => { notified++; });
    const background: Promise<unknown>[] = [];
    const start = Date.now();
    // Ongoing manual traffic both before and after tick admission: FIFO must
    // give both classes progress, including when a tick waits behind trades.
    const producer = (async () => {
      while (Date.now() - start < 8500) {
        const requestId = `load-${latency}-${manual++}`;
        background.push(executeTrade(state, `load-${manual % 100}`, {coinId:'btcr',side:'buy',amountUsdd:1,requestId}));
        await sleep(100);
      }
    })();
    await sleep(6200);
    const ticksBefore = notified, buyStart = Date.now();
    await executeTrade(state,'load-0',{coinId:'btcr',side:'buy',amountUsdd:10,requestId:`probe-${latency}`});
    const waited = Date.now() - buyStart;
    assert.ok(notified - ticksBefore <= 1, 'BUY waited for historical queued ticks');
    assert.ok(waited < latency + 2000, `BUY waited ${waited}ms beyond current slow tick`);
    await q.configureTradingBot('load-0','btcr','buy',60000,10);
    await q.setTradingBotEnabled('load-0',true);
    await db.query("UPDATE trading_bots SET next_run_at=$1 WHERE player_id='load-0'", [new Date(1577836800000 + latency).toISOString()]);
    await runTradingBots(state);
    assert.ok((await q.getTradingBot('load-0'))!.run_total_coins > 0);
    await producer;
    clearInterval(timer); timer = undefined;
    await Promise.all(background); await withMarketState(state, () => {});
    assert.equal(maximum,1); assert.equal(started,finished); assert.equal(started,notified);
    assert.ok(fires > started, 'slow intervals must be coalesced'); assert.ok(notified >= 2);
    assert.ok(manual >= 50);
    console.log(`PASS ${latency}ms DB latency: interval fires=${fires}, ticks=${started}, max active=${maximum}, BUY wait=${waited}ms, manual=${manual}, bot completed`);
    db.transaction = rawTransaction; globalThis.setInterval = interval;
  }
  console.log('TICK BACKPRESSURE TESTS PASSED (100 players x 11 coins, real 1s scheduler)');
} finally {
  if (timer) clearInterval(timer);
  globalThis.setInterval = interval; db.transaction = rawTransaction;
  await withMarketState(state, () => {}); await db.close();
}
