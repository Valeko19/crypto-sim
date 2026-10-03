import assert from 'node:assert/strict';
process.env.PGDATA_DIR = process.argv[3];
process.env.NODE_ENV = 'test';
const {db,initDb} = await import('../../src/db/index.js');
const {ensurePlayer,getAllPoolSnapshots,getTotalHeldForCoin,getHolding} = await import('../../src/db/queries.js');
const {COINS} = await import('../../src/config/coins.js');
const {createInitialState} = await import('../../src/engine/state.js');
const {price,limitPoolSupply} = await import('../../src/engine/amm.js');
const {executeTrade} = await import('../../src/engine/trade.js');
const {tick} = await import('../../src/engine/tick.js');
const {persistPoolSnapshots} = await import('../../src/engine/poolPersistence.js');
try {
  if (process.argv[2] === 'seed') await db.exec("CREATE TABLE coin_pools(coin_id TEXT PRIMARY KEY, coin_reserve DOUBLE PRECISION NOT NULL, usdd_reserve DOUBLE PRECISION NOT NULL); INSERT INTO coin_pools VALUES ('wlmb',0,0)");
  await initDb(); await initDb();
  const state = createInitialState();
  if (process.argv[2] === 'seed') {
    assert.deepEqual((await getAllPoolSnapshots())[0], {coin_id:'wlmb',coin_reserve:0,usdd_reserve:0,reference_price:null});
    await ensurePlayer('restart','restart');
    for (const cfg of COINS) {
      const free = cfg.emission * (1-cfg.npcLockedPct);
      await db.query('INSERT INTO player_holdings(player_id,coin_id,amount,avg_buy_price) VALUES ($1,$2,$3,$4)',['restart',cfg.id,free,cfg.startPrice]);
      state.coins[cfg.id].pool = {coinReserve:0,usddReserve:0,referencePrice:cfg.startPrice*2};
    }
    await persistPoolSnapshots(state);
  } else {
    for (const row of await getAllPoolSnapshots()) {
      state.coins[row.coin_id].pool = {coinReserve:row.coin_reserve,usddReserve:row.usdd_reserve,referencePrice:row.reference_price!};
    }
    for (const cfg of COINS) {
      const cs=state.coins[cfg.id];
      cs.playerOwnedCoins=await getTotalHeldForCoin(cfg.id);
      limitPoolSupply(cs.pool,cfg.emission*(1-cfg.npcLockedPct),cs.playerOwnedCoins,cfg.startPrice);
      assert.equal(cs.pool.coinReserve,0); assert.equal(price(cs.pool),cfg.startPrice*2);
    }
    for(let i=0;i<3000;i++) {tick(state);for(const cs of Object.values(state.coins))assert.equal(cs.pool.coinReserve,0);}
    for(const cfg of COINS) {
      const free=cfg.emission*(1-cfg.npcLockedPct);
      await executeTrade(state,'restart',{coinId:cfg.id,side:'sell',amountCoin:free/1024});
      assert.ok(state.coins[cfg.id].pool.coinReserve>0);
      assert.ok((await getHolding('restart',cfg.id))!.amount+state.coins[cfg.id].pool.coinReserve<=free);
    }
  }
} finally {await db.close();}
