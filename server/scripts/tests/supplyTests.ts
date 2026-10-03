import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.PGDATA_DIR = 'memory://';
process.env.NODE_ENV = 'test';
const { db, initDb } = await import('../../src/db/index.js');
const { ensurePlayer, getPlayer, getHolding, getAllPoolSnapshots, getTotalHeldForCoin } = await import('../../src/db/queries.js');
const { COINS, tradeFeePct } = await import('../../src/config/coins.js');
const { createInitialState } = await import('../../src/engine/state.js');
const { tick } = await import('../../src/engine/tick.js');
const { executeTrade } = await import('../../src/engine/trade.js');
const { price, k, repriceTo, maxTradeableReserve, limitPoolSupply, quoteBuyExecution, quoteSellExecution } = await import('../../src/engine/amm.js');
const { persistPoolSnapshots } = await import('../../src/engine/poolPersistence.js');
const { withMarketLock } = await import('../../src/engine/marketLock.js');
const { holdingsUpperBound, remainingSupply } = await import('../../src/engine/supply.js');

let seed = 1234567;
const random = Math.random;
Math.random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
const id = 'supply-regression';
let state = createInitialState();
const held = new Map<string, number>();
let passed = 0;
async function run(name: string, test: () => Promise<void> | void) {
  await test(); passed++; console.log(`PASS ${name}`);
}
const free = (coin: typeof COINS[number]) => coin.emission * (1 - coin.npcLockedPct);
function check() {
  for (const cfg of COINS) {
    const cs = state.coins[cfg.id];
    assert.ok((held.get(cfg.id) ?? 0) + cs.pool.coinReserve <= free(cfg), `${cfg.id}: supply increased`);
    assert.ok(Number.isFinite(cs.pool.coinReserve) && cs.pool.coinReserve >= 0);
    assert.ok(Number.isFinite(cs.pool.usddReserve) && cs.pool.usddReserve >= 0);
    assert.ok(Number.isFinite(price(cs.pool)) && price(cs.pool) > 0);
    assert.ok(Number.isFinite(cs.lastTick.totalPct));
  }
}
async function checkDb() {
  const rows = await db.query<{coin_id: string; total: number}>(
    'SELECT coin_id, SUM(amount)::float AS total FROM player_holdings GROUP BY coin_id');
  held.clear();
  for (const row of rows.rows) held.set(row.coin_id, row.total);
  check();
}
async function fixture(share: number) {
  state = createInitialState(); held.clear();
  await db.query('DELETE FROM player_holdings');
  await ensurePlayer(id, id);
  await db.query('UPDATE players SET usdd_balance = 1e22 WHERE id = $1', [id]);
  for (const cfg of COINS) {
    const amount = free(cfg) * share;
    const remaining = maxTradeableReserve(free(cfg), amount);
    const cs = state.coins[cfg.id];
    cs.playerOwnedCoins = amount;
    cs.pool = { coinReserve: remaining, usddReserve: remaining * cfg.startPrice * 1e7 };
    limitPoolSupply(cs.pool, free(cfg), amount, cfg.startPrice);
    held.set(cfg.id, amount);
    await db.query('INSERT INTO player_holdings(player_id, coin_id, amount, avg_buy_price) VALUES ($1,$2,$3,$4)', [id, cfg.id, amount, cfg.startPrice]);
  }
}
function ticks(count: number) { for (let i = 0; i < count; i++) { tick(state); check(); } }

try {
  await initDb();
  await run('all coins: near-full ownership survives 4000 ticks without new supply', async () => {
    await fixture(0.9997);
    ticks(4000);
  });
  await run('all coins: eight BUY / 2000-tick cycles cannot re-issue owned coins', async () => {
    for (let round = 0; round < 8; round++) {
      for (const cfg of COINS) {
        const before = state.coins[cfg.id].pool.coinReserve;
        const result = await executeTrade(state, id, { coinId: cfg.id, side: 'buy', useMax: true });
        assert.ok(result.coinAmount <= before * 0.3);
        held.set(cfg.id, (await getHolding(id, cfg.id))!.amount);
        check();
      }
      ticks(2000);
    }
  });
  await run('all coins: SELL returns existing coins to the pool and BUY can consume them', async () => {
    for (const cfg of COINS) {
      const pool = state.coins[cfg.id].pool;
      const before = { ...pool };
      const holdingBefore = held.get(cfg.id)!;
      const result = await executeTrade(state, id, { coinId: cfg.id, side: 'sell', amountCoin: before.coinReserve * 0.2 });
      const holdingAfter = (await getHolding(id, cfg.id))!.amount;
      assert.equal(holdingAfter, holdingBefore - result.coinAmount);
      assert.ok(Math.abs(pool.coinReserve - before.coinReserve - result.coinAmount) <= free(cfg) * Number.EPSILON);
      held.set(cfg.id, holdingAfter); check();
      const bought = await executeTrade(state, id, { coinId: cfg.id, side: 'buy', useMax: true });
      assert.ok(bought.coinAmount > 0);
      held.set(cfg.id, (await getHolding(id, cfg.id))!.amount); check();
    }
  });
  await run('all coins: the last representable supply is not rounded into extra holdings', async () => {
    await fixture(1 - Number.EPSILON);
    ticks(1000);
    for (const cfg of COINS) {
      const before = await getPlayer(id);
      try {
        await executeTrade(state, id, { coinId: cfg.id, side: 'buy', useMax: true });
      } catch {
        assert.deepEqual(await getPlayer(id), before);
      }
      held.set(cfg.id, (await getHolding(id, cfg.id))!.amount); check();
    }
  });
  await run('all coins: exhausted pools retain finite prices through 5000 ticks and reject BUY', async () => {
    await fixture(1);
    ticks(5000);
    for (const cfg of COINS) {
      const pool = state.coins[cfg.id].pool;
      assert.equal(pool.coinReserve, 0); assert.equal(pool.usddReserve, 0);
      assert.throws(() => quoteBuyExecution(pool, 100));
      assert.equal(quoteSellExecution(pool, 1).coinAmount, 1);
      const before = await getPlayer(id);
      await assert.rejects(() => executeTrade(state, id, { coinId: cfg.id, side: 'buy', useMax: true }));
      assert.deepEqual(await getPlayer(id), before);
    }
  });
  await run('exhausted price references survive persisted snapshot reload and boot reconciliation', async () => {
    await persistPoolSnapshots(state);
    const snapshots = await getAllPoolSnapshots();
    for (const cfg of COINS) {
      const row = snapshots.find(s => s.coin_id === cfg.id)!;
      const pool = { coinReserve: row.coin_reserve, usddReserve: row.usdd_reserve, referencePrice: row.reference_price! };
      limitPoolSupply(pool, free(cfg), free(cfg), cfg.startPrice);
      assert.equal(price(pool), price(state.coins[cfg.id].pool));
      assert.equal(pool.coinReserve, 0);
      const legacy = { coinReserve: 0, usddReserve: 0 };
      limitPoolSupply(legacy, free(cfg), free(cfg), cfg.startPrice);
      assert.equal(price(legacy), cfg.startPrice);
    }
  });
  await run('ordinary repricing retains its original formula and reserve cap on every coin', async () => {
    for (const cfg of COINS) for (const factor of [0.8, 1, 1.2]) {
      const pool = { coinReserve: free(cfg) * 0.5, usddReserve: free(cfg) * 0.5 * cfg.startPrice };
      const target = cfg.startPrice * factor;
      const invariant = k(pool);
      repriceTo(pool, target, free(cfg));
      assert.equal(pool.coinReserve, Math.sqrt(invariant / target));
      assert.equal(pool.usddReserve, Math.sqrt(invariant * target));
    }
    await fixture(0); ticks(10000);
  });
  await run('subnormal liquidity cannot produce NaN or fabricated reserves', () => {
    const pool = { coinReserve: 1e-200, usddReserve: 1e-200 };
    repriceTo(pool, 1, 1e-200);
    assert.equal(pool.coinReserve, 1e-200); assert.equal(pool.usddReserve, 1e-200);
  });
  await run('all coins: exhausted SELL pays the reference quote and returns real coins for a subsequent BUY', async () => {
    await fixture(1);
    for (const cfg of COINS) {
      await db.query('UPDATE players SET usdd_balance = 1000 WHERE id = $1', [id]);
      const cs = state.coins[cfg.id];
      const amount = free(cfg) / 1024;
      const quote = quoteSellExecution(cs.pool, amount);
      const sold = await executeTrade(state, id, {coinId:cfg.id, side:'sell', amountCoin:amount});
      assert.equal(sold.coinAmount, amount);
      assert.equal(sold.usddAmount, quote.usddAmount - quote.usddAmount * tradeFeePct(cfg.id));
      assert.equal((await getPlayer(id)).usdd_balance, 1000 + sold.usddAmount);
      assert.equal((await getHolding(id,cfg.id))!.amount, free(cfg) - amount);
      // A rounded holdings subtraction can return slightly fewer coins than
      // requested. Only the persistent, conservatively available amount may
      // enter the pool; never permit even a sub-ULP supply excess.
      assert.equal(cs.pool.coinReserve, Math.min(amount, maxTradeableReserve(free(cfg), await getTotalHeldForCoin(cfg.id))));
      assert.ok(Math.abs(cs.pool.usddReserve / quote.usddAmount - 1) < 1e-14);
      await checkDb();
      const bought = await executeTrade(state, id, {coinId:cfg.id, side:'buy', useMax:true});
      assert.ok(bought.coinAmount > 0 && bought.coinAmount <= amount * .3);
      await checkDb();
    }
  });
  await run('exhausted SELL rolls back payout, holdings, supply cache and pool if snapshot persistence fails', async () => {
    await fixture(1);
    const cs = state.coins.wlmb;
    const before = {player:await getPlayer(id), holding:await getHolding(id,'wlmb'), pool:{...cs.pool}, owned:cs.playerOwnedCoins};
    const transaction = db.transaction.bind(db);
    let injected = false;
    (db as any).transaction = (callback: any) => transaction(tx => callback(new Proxy(tx, {
      get(target, key) {
        if (key === 'query') return (sql: string, ...args: any[]) => {
          if (sql.includes('INSERT INTO coin_pools')) { injected = true; throw new Error('supply rollback probe'); }
          return (target.query as any)(sql,...args);
        };
        const value = Reflect.get(target,key,target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    })));
    try {await assert.rejects(executeTrade(state,id,{coinId:'wlmb',side:'sell',amountCoin:free(cs.config)/1024,requestId:'supply-fault'}),/rollback probe/);}
    finally {(db as any).transaction = transaction;}
    assert.equal(injected,true);
    assert.deepEqual({player:await getPlayer(id),holding:await getHolding(id,'wlmb'),pool:{...cs.pool},owned:cs.playerOwnedCoins},before);
    await executeTrade(state,id,{coinId:'wlmb',side:'sell',amountCoin:free(cs.config)/1024,requestId:'supply-fault'});
    await checkDb();
  });
  await run('2/10/64 players trading alongside ticks preserve persistent supply', async () => {
    for (const count of [2,10,64]) {
      await fixture(.9997);
      const tasks: Promise<unknown>[] = [];
      for (let i = 0; i < count; i++) {
        const player = `supply-concurrent-${i}`;
        await ensurePlayer(player,player);
        await db.query('UPDATE players SET usdd_balance=1e9 WHERE id=$1',[player]);
      }
      for (let i = 0; i < count; i++) {
        tasks.push(executeTrade(state,`supply-concurrent-${i}`,{coinId:'wlmb',side:'buy',useMax:true}));
        tasks.push(withMarketLock(async () => {tick(state);await checkDb();}));
      }
      await Promise.all(tasks); await checkDb();
    }
  });
  await run('all 11 coins: 1000 alternating MAX BUY/reprice attempts use persistent holdings, including the +0.027587890625 regression', async () => {
    await fixture(0);
    const ids = ['supply-a', 'supply-b'];
    for (const player of ids) {
      await ensurePlayer(player, player);
      await db.query('UPDATE players SET usdd_balance = 1e100 WHERE id = $1', [player]);
    }
    for (const cfg of COINS) {
      for (let i = 0; i < 2; i++) await db.query(
        'INSERT INTO player_holdings(player_id,coin_id,amount,avg_buy_price) VALUES ($1,$2,$3,$4)',
        [ids[i], cfg.id, free(cfg) * (i === 0 ? .4 : .5997), cfg.startPrice]);
      const cs = state.coins[cfg.id];
      cs.playerOwnedCoins = await getTotalHeldForCoin(cfg.id);
      const x = maxTradeableReserve(free(cfg), cs.playerOwnedCoins);
      cs.pool = {coinReserve:x, usddReserve:x * cfg.startPrice};
      for (let i = 0; i < 1000; i++) {
        const player = ids[i % 2];
        const before = await getHolding(player, cfg.id);
        try { await executeTrade(state, player, {coinId:cfg.id, side:'buy', useMax:true}); }
        catch (error) {
          assert.match(String(error), /supply|precision|finite positive/);
          assert.deepEqual(await getHolding(player, cfg.id), before);
        }
        await checkDb();
        repriceTo(cs.pool, price(cs.pool) * .49, maxTradeableReserve(free(cfg), cs.playerOwnedCoins));
        await checkDb();
      }
      console.log(`  ${cfg.id}: 1000 attempts checked against DB SUM`);
    }
  });
  await run('old on-disk schema migrates and exhausted pools survive a new process before SELL on every coin', async () => {
    await db.close();
    const dir = mkdtempSync(path.join(tmpdir(),'crypto-supply-restart-'));
    const worker = fileURLToPath(new URL('./supplyRestartWorker.ts',import.meta.url));
    try {
      for (const phase of ['seed','sell']) {
        const result = spawnSync(process.execPath,['--import','tsx',worker,phase,dir],{encoding:'utf8',timeout:120000});
        assert.equal(result.status,0,result.stdout + result.stderr);
      }
    } finally {rmSync(dir,{recursive:true,force:true});}
  });
  await run('supply rounding is conservative and independent of holdings row order', () => {
    assert.equal(holdingsUpperBound([2**53,1]),2**53+2);
    assert.equal(holdingsUpperBound([1,2**53]),2**53+2);
    assert.equal(remainingSupply(2**53+2,holdingsUpperBound([2**53,1])),0);
    assert.equal(holdingsUpperBound([Number.MIN_VALUE,Number.MIN_VALUE]),Number.MIN_VALUE*2);
    assert.equal(remainingSupply(1,Number.MIN_VALUE),1-Number.EPSILON/2);
  });
  console.log(`SUPPLY TESTS: ${passed} passed (all ${COINS.length} coins)`);
} finally { Math.random = random; if (!db.closed) await db.close(); }
