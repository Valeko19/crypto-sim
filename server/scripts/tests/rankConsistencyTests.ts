import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import express from 'express';

const replay = process.argv.includes('--replay');
process.env.PGDATA_DIR = replay ? process.env.PGDATA_DIR : mkdtempSync(path.join(tmpdir(), 'rank-consistency-'));
process.env.NODE_ENV = 'test';
const { db, initDb } = await import('../../src/db/index.js');
const q = await import('../../src/db/queries.js');
const { computePortfolio, computeAllPortfolios } = await import('../../src/api/helpers.js');
const { createRouter } = await import('../../src/api/routes.js');
const { executeTrade } = await import('../../src/engine/trade.js');
const { claimQuest } = await import('../../src/engine/quests.js');
const { createInitialState } = await import('../../src/engine/state.js');
const { commitMarketMutation, creditBalance } = await import('../../src/engine/marketValuation.js');
const { checkRankUpRewards } = await import('../../src/engine/rankRewards.js');
const { repriceTo, price, maxTradeableReserve } = await import('../../src/engine/amm.js');
const { tick } = await import('../../src/engine/tick.js');
const state = createInitialState();
let sequence = 0;
const rawTransaction = db.transaction.bind(db);
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { resolve, promise }; }
const pause = () => new Promise(r => setTimeout(r, 10));
// Gate inside the actual transaction after a read, without releasing its DB
// snapshot. A competing operation must wait, not leak into a second SELECT.
function gateQuery(match: (sql: string) => boolean) {
  const entered = deferred(), release = deferred(); let armed = true;
  db.transaction = ((fn: any) => rawTransaction(async tx => {
    const query = tx.query.bind(tx);
    tx.query = (async (sql: string, ...args: any[]) => {
      const result = await (query as any)(sql, ...args);
      if (armed && match(sql)) { armed = false; entered.resolve(); await release.promise; }
      return result;
    }) as typeof tx.query;
    return fn(tx);
  })) as typeof db.transaction;
  return { entered, release, restore: () => { db.transaction = rawTransaction; } };
}
async function fixture(balance = 6000) {
  const id = `dev_rank_${++sequence}`; await q.ensurePlayer(id, id);
  await db.query('UPDATE players SET usdd_balance=$1 WHERE id=$2', [balance, id]); return id;
}

try {
  await initDb();
  if (replay) {
    assert.equal(await q.getHighestLeagueIndex('dev_persistent_peak'), 1);
    await assert.rejects(claimQuest('dev_persistent_peak', 'rank_reward:1'), /already claimed/);
    assert.equal((await q.getEarnedTotals('dev_persistent_peak')).rank, 1000);
    console.log('PASS restart preserves genuine peak and claim history');
  } else {
    for (const bulk of [false, true]) for (const side of ['buy', 'sell'] as const) for (const n of [1, 2, 10, 64]) {
      const id = await fixture();
      if (side === 'sell') await executeTrade(state, id, { coinId: 'btcr', side: 'buy', amountUsdd: 5900 });
      const before = await computePortfolio(state, id);
      const gate = gateQuery(sql => bulk ? sql === 'SELECT * FROM players' : sql === 'SELECT * FROM players WHERE id = $1');
      const reads = Array.from({ length: n }, () => bulk ? computeAllPortfolios(state).then(m => m.get(id)!) : computePortfolio(state, id));
      await gate.entered.promise;
      let settled = false;
      const trade = executeTrade(state, id, side === 'buy' ? { coinId: 'btcr', side, amountUsdd: 5900 } : { coinId: 'btcr', side, useMax: true }).then(() => { settled = true; });
      await pause(); assert.equal(settled, false); gate.release.resolve();
      const views = await Promise.all(reads); await trade; gate.restore();
      assert.ok(views.every(v => v.netWorth === before.netWorth));
      const after = await computePortfolio(state, id); assert.ok(after.netWorth > 5800 && after.netWorth < 6000);
      await checkRankUpRewards(new Map([[id, views[0]]]));
      assert.equal(await q.getHighestLeagueIndex(id), 0);
      await assert.rejects(claimQuest(id, 'rank_reward:1'), /not yet achieved/);
      console.log(`PASS ${bulk ? 'bulk' : 'single'} ${side}, ${n} readers, no mixed NW/false reward`);
    }

    const id = await fixture(); await executeTrade(state, id, { coinId: 'btcr', side: 'buy', amountUsdd: 5900 });
    const before = await computePortfolio(state, id);
    const gate = gateQuery(sql => sql === 'SELECT * FROM player_holdings WHERE player_id = $1');
    const reading = computePortfolio(state, id); await gate.entered.promise;
    const selling = executeTrade(state, id, { coinId: 'btcr', side: 'sell', useMax: true });
    gate.release.resolve(); assert.equal((await reading).netWorth, before.netWorth); await selling; gate.restore();
    await commitMarketMutation(state, draft => {
      const cs = draft.coins.btcr; repriceTo(cs.pool, price(cs.pool) * 2, maxTradeableReserve(12000000, cs.playerOwnedCoins));
    });
    assert.equal(await q.getHighestLeagueIndex(id), 0);
    console.log('PASS sold holdings never valued at subsequent doubled price');

    const peakId = 'dev_persistent_peak'; await q.ensurePlayer(peakId, peakId);
    await db.query('UPDATE players SET usdd_balance=6000 WHERE id=$1', [peakId]);
    await executeTrade(state, peakId, { coinId: 'btcr', side: 'buy', amountUsdd: 5900 });
    const base = price(state.coins.btcr.pool);
    const reprice = (p: number) => commitMarketMutation(state, draft => {
      const cs = draft.coins.btcr; repriceTo(cs.pool, p, maxTradeableReserve(12000000, cs.playerOwnedCoins));
    });
    await reprice(base * 2); assert.equal((await computePortfolio(state, peakId)).leagueIndex, 1);
    await reprice(base); assert.equal((await computePortfolio(state, peakId)).leagueIndex, 0);
    assert.equal(await q.getHighestLeagueIndex(peakId), 1);
    await claimQuest(peakId, 'rank_reward:1');
    console.log('PASS price-only crossing persists before any background poll; current rank falls');

    for (const n of [2, 10, 64]) {
      const candidate = await fixture(100);
      await Promise.all(Array.from({ length: n }, (_, i) => q.setHighestLeagueIndex(candidate, i === 0 ? 2 : 1)));
      assert.equal(await q.getHighestLeagueIndex(candidate), 2);
      const before = (await q.getPlayer(candidate)).usdd_balance;
      const claims = await Promise.allSettled(Array.from({ length: n }, () => claimQuest(candidate, 'rank_reward:1')));
      assert.equal(claims.filter(r => r.status === 'fulfilled').length, 1);
      assert.equal((await q.getPlayer(candidate)).usdd_balance, before + 1000);
      console.log(`PASS ${n} overlapping highest updates and exactly-once claims`);
    }

    const rewardId = await fixture(9600); await claimQuest(rewardId, 'daily_bonus');
    assert.equal(await q.getHighestLeagueIndex(rewardId), 1);
    const cashId = await fixture(9900); await creditBalance(cashId, 200);
    assert.equal(await q.getHighestLeagueIndex(cashId), 1);
    console.log('PASS quest and shared cash-credit crossings recorded in payout transaction');

    // A trade changes the valuation of OTHER owners too, not only its sender.
    const owner = await fixture(0), buyer = await fixture(50000);
    const marketPrice = price(state.coins.btcr.pool);
    await db.query('INSERT INTO player_holdings (player_id,coin_id,amount,avg_buy_price) VALUES ($1,$2,$3,$4)',
      [owner, 'btcr', 9960 / marketPrice, marketPrice]);
    await commitMarketMutation(state, draft => { draft.coins.btcr.pool = { coinReserve: 100, usddReserve: 100 * marketPrice }; });
    assert.equal(await q.getHighestLeagueIndex(owner), 0);
    await executeTrade(state, buyer, { coinId: 'btcr', side: 'buy', amountUsdd: 50000 });
    assert.equal(await q.getHighestLeagueIndex(owner), 1);
    await executeTrade(state, buyer, { coinId: 'btcr', side: 'sell', useMax: true });
    assert.equal((await computePortfolio(state, owner)).leagueIndex, 0);
    assert.equal(await q.getHighestLeagueIndex(owner), 1);
    console.log('PASS BUY/SELL price crossing for a different owner is durable without polling');

    const statusId = await fixture(100); await q.setHighestLeagueIndex(statusId, 1);
    const app = express(); app.use(express.json()); app.use('/api', createRouter(state));
    const server = createServer(app); await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    try {
      const gate = gateQuery(sql => sql === 'SELECT * FROM quest_progress WHERE player_id = $1');
      const status = fetch(`http://127.0.0.1:${(server.address() as any).port}/api/quests`, { headers: { 'X-Dev-Player-Id': statusId } }).then(r => r.json());
      await gate.entered.promise; const claim = claimQuest(statusId, 'rank_reward:1');
      gate.release.resolve(); const body = await status; await claim; gate.restore();
      assert.equal(body.rankRewards.ladder[0].claimed, false); assert.equal(body.rankEarnedTotal, 0);
      console.log('PASS status and claim use distinct complete snapshots');
    } finally { await new Promise<void>(r => server.close(() => r())); }

    const oldPrice = price(state.coins.btcr.pool), oldHigh = await q.getHighestLeagueIndex(peakId);
    let failCommit = true;
    db.transaction = ((fn: any) => rawTransaction(async tx => { const result = await fn(tx); if (failCommit) { failCommit = false; throw new Error('injected rank commit failure'); } return result; })) as typeof db.transaction;
    await assert.rejects(reprice(base * 100), /injected/); db.transaction = rawTransaction;
    assert.equal(price(state.coins.btcr.pool), oldPrice); assert.equal(await q.getHighestLeagueIndex(peakId), oldHigh);
    console.log('PASS failed market commit rolls back prices/peaks and does not publish live state');

    for (const count of [50, 100]) {
      for (let i = 0; i < count; i++) {
        await q.ensurePlayer(`dev_load_${i}`, 'load');
        await db.query(`INSERT INTO player_holdings (player_id,coin_id,amount,avg_buy_price)
          SELECT $1,coin_id,0.000001,price FROM market_valuation_prices
          ON CONFLICT (player_id,coin_id) DO NOTHING`, [`dev_load_${i}`]);
      }
      const start = performance.now();
      for (let i = 0; i < 10; i++) { await commitMarketMutation(state, tick); await computeAllPortfolios(state); }
      console.log(`PERF ${count} load players plus fixtures: mean tick + bulk portfolio ${(performance.now() - start) / 10} ms`);
    }
    // Upgrade a pre-valuation schema without deleting its existing data.
    await db.exec('DROP TABLE market_valuation_prices');
    await initDb();
    const restoredPrices = await db.query<{ coin_id: string; price: number }>('SELECT * FROM market_valuation_prices');
    assert.equal(restoredPrices.rows.length, 11);
    for (const row of restoredPrices.rows) assert.equal(row.price, price(state.coins[row.coin_id].pool));
    assert.equal(await q.getHighestLeagueIndex(peakId), 1);
    console.log('PASS old-schema upgrade seeds valuation from durable pools and preserves ranks/claims');
    await db.close();
    const child = spawnSync(process.execPath, ['--import', 'tsx', process.argv[1], '--replay'], { env: process.env, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr); console.log(child.stdout.trim());
    console.log('RANK CONSISTENCY TESTS PASSED');
  }
} finally { db.transaction = rawTransaction; if (!db.closed) await db.close(); }
