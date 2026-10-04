import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';

process.env.PGDATA_DIR = 'memory://';
process.env.NODE_ENV = 'test';
const { db, initDb } = await import('../../src/db/index.js');
const q = await import('../../src/db/queries.js');
const { COINS } = await import('../../src/config/coins.js');
const { createInitialState } = await import('../../src/engine/state.js');
const { executeTrade } = await import('../../src/engine/trade.js');
const { commitMarketMutation } = await import('../../src/engine/marketValuation.js');
const { ensureMarketReady, MarketUnavailableError } = await import('../../src/engine/marketRecovery.js');
const { persistPoolSnapshots } = await import('../../src/engine/poolPersistence.js');
const { runTradingBots } = await import('../../src/engine/tradingBot.js');
const { price, repriceTo, maxTradeableReserve } = await import('../../src/engine/amm.js');
const { todaysVolume } = await import('../../src/engine/dailyVolume.js');
const { createRouter } = await import('../../src/api/routes.js');
const { createAuthSession } = await import('../../src/auth/sessions.js');
const { claimQuest } = await import('../../src/engine/quests.js');
const { computePortfolio } = await import('../../src/api/helpers.js');
const state = createInitialState();
const rawTransaction = db.transaction.bind(db);
const driver = db as any;
const rawBlob = driver._getWrittenBlob;
let sequence = 0;
const buy = (requestId = `recovery-${++sequence}`) => executeTrade(state, 'recovery', { coinId: 'btcr', side: 'buy', amountUsdd: 10, requestId });
async function snapshot() {
  return { player: await q.getPlayer('recovery'), holdings: (await db.query('SELECT * FROM player_holdings ORDER BY player_id,coin_id')).rows,
    pools: await q.getAllPoolSnapshots(), logs: (await db.query('SELECT * FROM trade_log ORDER BY id')).rows, volume: todaysVolume('recovery') };
}
async function exact() {
  for (const cfg of COINS) {
    const row = (await q.getAllPoolSnapshots()).find(p => p.coin_id === cfg.id)!;
    const pool = state.coins[cfg.id].pool;
    assert.equal(pool.coinReserve, row.coin_reserve); assert.equal(pool.usddReserve, row.usdd_reserve);
    assert.equal(pool.referencePrice ?? null, row.reference_price);
    assert.equal(state.coins[cfg.id].playerOwnedCoins, await q.getTotalHeldForCoin(cfg.id));
    assert.ok(pool.coinReserve <= maxTradeableReserve(cfg.emission * (1 - cfg.npcLockedPct), await q.getTotalHeldForCoin(cfg.id)));
    const valuation = await db.query<{price:number}>('SELECT price FROM market_valuation_prices WHERE coin_id=$1', [cfg.id]);
    assert.equal(price(pool), valuation.rows[0].price);
  }
}
// Throw inside the PGlite driver after COMMIT has left transaction mode, not
// merely after an already resolved transaction() Promise.
function inject(mode: 'commit' | 'rollback', blockRecovery = false, onPrepared?: () => void) {
  let armed = false, fired = false, blocked = blockRecovery;
  driver._getWrittenBlob = async function (...args: any[]) {
    if (armed && !db.isInTransaction() && !fired) { fired = true; throw new Error('injected AFTER COMMIT'); }
    return rawBlob.apply(this, args);
  };
  db.transaction = ((callback: any) => rawTransaction(async tx => {
    const query = tx.query.bind(tx);
    tx.query = (async (sql: string, ...args: any[]) => {
      if (blocked && sql.includes('v.price AS valuation')) throw new Error('recovery unavailable');
      return (query as any)(sql, ...args);
    }) as typeof tx.query;
    const value = await callback(tx);
    if (!armed && !fired) {
      armed = true;
      onPrepared?.();
      if (mode === 'rollback') { fired = true; throw new Error('injected BEFORE COMMIT'); }
    }
    return value;
  })) as typeof db.transaction;
  return { unblock: () => { blocked = false; }, restore: () => {
    driver._getWrittenBlob = rawBlob; db.transaction = rawTransaction; assert.ok(fired, 'fault was reached');
  } };
}
async function fault(mode: 'commit' | 'rollback', work: () => Promise<unknown>) {
  const hook = inject(mode);
  try { await assert.rejects(work, mode === 'commit' ? MarketUnavailableError : /BEFORE COMMIT/); }
  finally { hook.restore(); }
  await exact();
}
try {
  await initDb(); await q.ensurePlayer('recovery', 'recovery');
  await db.query("UPDATE players SET usdd_balance=100 WHERE id='recovery'");
  await commitMarketMutation(state, () => {});
  const before = await snapshot();
  await fault('commit', () => buy('commit-once'));
  assert.equal((await q.getPlayer('recovery')).usdd_balance, 90);
  const settled = await snapshot();
  assert.equal(settled.logs.length, before.logs.length + 1);
  assert.equal(settled.volume, before.volume + 10);
  assert.equal((await buy('commit-once')).replayed, true); assert.deepEqual(await snapshot(), settled);
  await buy(); await exact(); assert.equal((await q.getPlayer('recovery')).usdd_balance, 80);
  console.log('PASS driver COMMIT-then-throw: settlement/volume once, exact pools, replay and next trade');

  const rollbackBefore = await snapshot();
  await fault('rollback', () => buy('rollback-retry'));
  assert.deepEqual(await snapshot(), rollbackBefore);
  assert.equal((await buy('rollback-retry')).replayed, false); await exact();
  console.log('PASS trade rollback and retry');

  await q.ensurePlayer('rank-holder', 'rank-holder');
  const base = price(state.coins.btcr.pool);
  await db.query('INSERT INTO player_holdings(player_id,coin_id,amount,avg_buy_price) VALUES ($1,$2,$3,$4)', ['rank-holder','btcr',6000/base,base]);
  state.coins.btcr.playerOwnedCoins = await q.getTotalHeldForCoin('btcr');
  await commitMarketMutation(state, () => {});
  const change = (factor: number) => commitMarketMutation(state, draft => {
    const cs = draft.coins.btcr;
    repriceTo(cs.pool, price(cs.pool) * factor, maxTradeableReserve(cs.config.emission * (1-cs.config.npcLockedPct), cs.playerOwnedCoins));
    draft.tickCount++;
  });
  const oldTicks = state.tickCount;
  await fault('commit', () => change(2));
  assert.equal(state.tickCount, oldTicks + 1); assert.ok(price(state.coins.btcr.pool) > base * 1.99);
  assert.equal(await q.getHighestLeagueIndex('rank-holder'), 1);
  await buy(); await exact(); assert.ok(price(state.coins.btcr.pool) > base * 1.99);
  const tickBefore = structuredClone(state); const dbBefore = await snapshot();
  await fault('rollback', () => change(10));
  assert.deepEqual(state, tickBefore); assert.deepEqual(await snapshot(), dbBefore);
  assert.equal(await q.getHighestLeagueIndex('rank-holder'), 1);
  console.log('PASS tick COMMIT-then-throw preserves peak/candidate; tick rollback publishes nothing');
  await change(.25);
  assert.ok((await computePortfolio(state,'rank-holder')).netWorth < 10000);
  assert.equal(await q.getHighestLeagueIndex('rank-holder'),1);
  const claims = await Promise.allSettled(Array.from({length:64}, () => claimQuest('rank-holder','rank_reward:1')));
  assert.equal(claims.filter(result => result.status === 'fulfilled').length,1);
  assert.equal((await q.getEarnedTotals('rank-holder')).rank,1000);
  console.log('PASS recovered genuine peak survives price fall and pays one rank reward among 64 claims');

  await q.configureTradingBot('recovery', 'btcr', 'buy', 60000, 10);
  await q.setTradingBotEnabled('recovery', true);
  await db.query("UPDATE trading_bots SET next_run_at='2020-01-01' WHERE player_id='recovery'");
  const botBefore = await q.getTradingBot('recovery');
  const queuedResponses: Promise<number>[] = [];
  const router = createRouter(state);
  const hook = inject('commit', true, () => {
    // These handlers already passed HTTP admission before the failure. They
    // queue behind the in-flight transaction and must also produce 503, not
    // an unhandled Express 4 rejection or a stale portfolio/quote.
    for (const path of ['/portfolio','/quests','/leaderboard','/trade/quote']) {
      const handler = (router as any).stack.find((layer: any) => layer.route?.path === path).route.stack[0].handle;
      queuedResponses.push(new Promise<number>((resolve, reject) => {
        let status = 200;
        const response = { status(code: number) { status = code; return this; }, json() { resolve(status); return this; } };
        handler({playerId:'recovery',query:{},body:{coinId:'btcr',side:'buy',useMax:true}}, response, reject);
      }));
    }
  });
  try {
    await assert.rejects(() => buy('blocked-commit'), MarketUnavailableError);
    assert.deepEqual(await Promise.all(queuedResponses), [503,503,503,503]);
    const durable = await snapshot();
    await assert.rejects(() => buy(), MarketUnavailableError);
    await assert.rejects(() => executeTrade(state,'recovery',{coinId:'btcr',side:'sell',useMax:true}), MarketUnavailableError);
    let mutated = false;
    await assert.rejects(() => commitMarketMutation(state, () => { mutated = true; }), MarketUnavailableError);
    assert.equal(mutated, false);
    await assert.rejects(() => persistPoolSnapshots(state), MarketUnavailableError);
    await assert.rejects(() => computePortfolio(state,'recovery'), MarketUnavailableError);
    await runTradingBots(state); assert.deepEqual(await q.getTradingBot('recovery'), botBefore);
    assert.deepEqual(await snapshot(), durable);
    const app = express(); app.use(express.json()); app.use('/api', createRouter(state));
    const server = createServer(app); await new Promise<void>(r => server.listen(0,'127.0.0.1',r));
    try {
      const { sessionToken } = await createAuthSession('recovery');
      const response = await fetch(`http://127.0.0.1:${(server.address() as any).port}/api/trade`, {method:'POST',headers:{'Content-Type':'application/json','X-Session-Token':sessionToken},body:JSON.stringify({coinId:'btcr',side:'buy',amountUsdd:10,requestId:'http-blocked'})});
      assert.equal(response.status, 503);
      for (const endpoint of ['/portfolio','/quests','/leaderboard']) {
        const read = await fetch(`http://127.0.0.1:${(server.address() as any).port}/api${endpoint}`, {headers:{'X-Session-Token':sessionToken}});
        assert.equal(read.status,503);
      }
    } finally { await new Promise<void>(r => server.close(() => r())); }
    hook.unblock(); await ensureMarketReady(state); await exact();
    assert.equal((await buy('blocked-commit')).replayed, true);
    await buy(); await runTradingBots(state); await exact();
    assert.notDeepEqual(await q.getTradingBot('recovery'), botBefore);
  } finally { hook.restore(); }
  console.log('PASS recovery failure gates BUY/SELL/bot/tick/persistence/HTTP; read-only retry reopens market');

  await db.query('DELETE FROM player_holdings');
  for (const cfg of COINS) {
    const free = cfg.emission * (1-cfg.npcLockedPct);
    await db.query('INSERT INTO player_holdings(player_id,coin_id,amount,avg_buy_price) VALUES ($1,$2,$3,$4)', ['recovery',cfg.id,free,cfg.startPrice]);
    state.coins[cfg.id].playerOwnedCoins = free;
    state.coins[cfg.id].pool = {coinReserve:0,usddReserve:0,referencePrice:cfg.startPrice};
  }
  await commitMarketMutation(state, () => {});
  for (const cfg of COINS) {
    await fault('commit', () => commitMarketMutation(state, draft => {
      draft.coins[cfg.id].pool.referencePrice! *= 1.01;
    }));
    const free = cfg.emission * (1-cfg.npcLockedPct), requestId = `empty-${cfg.id}`;
    await fault('commit', () => executeTrade(state,'recovery',{coinId:cfg.id,side:'sell',amountCoin:free/1024,requestId}));
    const once = await snapshot();
    assert.equal((await executeTrade(state,'recovery',{coinId:cfg.id,side:'sell',amountCoin:free/1024,requestId})).replayed,true);
    assert.deepEqual(await snapshot(), once);
    await commitMarketMutation(state, draft => {
      const cs = draft.coins[cfg.id]; repriceTo(cs.pool,price(cs.pool)*.9,maxTradeableReserve(free,cs.playerOwnedCoins));
    });
    await executeTrade(state,'recovery',{coinId:cfg.id,side:'buy',useMax:true}); await exact();
  }
  console.log('PASS all 11 coins: exact exhausted reference recovery, SELL once, tick, MAX BUY and near-full supply');
  console.log('MARKET RECOVERY TESTS PASSED');
} finally { driver._getWrittenBlob = rawBlob; db.transaction = rawTransaction; await db.close(); }
