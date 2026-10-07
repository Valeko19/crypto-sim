import assert from 'node:assert/strict';
process.env.PGDATA_DIR = 'memory://';
process.env.NODE_ENV = 'test';
const { db, initDb } = await import('../../src/db/index.js');
const { startDbMaintenance, CHECKPOINT_INTERVAL_MS } = await import('../../src/db/maintenance.js');
const { createInitialState } = await import('../../src/engine/state.js');
const { executeTrade } = await import('../../src/engine/trade.js');
const { commitMarketMutation } = await import('../../src/engine/marketValuation.js');
const { MarketUnavailableError } = await import('../../src/engine/marketRecovery.js');
const q = await import('../../src/db/queries.js');
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return {promise,resolve}; }
const exec = db.exec.bind(db), transaction = db.transaction.bind(db);
const interval = globalThis.setInterval, clear = globalThis.clearInterval;
const events: any[] = [];
let callback!: () => void, clears = 0, maintenance: ReturnType<typeof startDbMaintenance> | undefined;
async function finances() {
  const out: Record<string, unknown> = {};
  for (const t of ['players','player_holdings','coin_pools','market_valuation_prices','market_commit','player_rank_progress','trade_requests','trade_log','player_daily_volume']) {
    out[t] = (await db.query(`SELECT to_jsonb(t) AS r FROM ${t} t ORDER BY to_jsonb(t)::text`)).rows;
  }
  return out;
}
try {
  await initDb();
  globalThis.setInterval = ((fn: () => void, ms: number) => {
    assert.equal(ms, CHECKPOINT_INTERVAL_MS); callback = fn; return {unref(){}};
  }) as any;
  globalThis.clearInterval = (() => { clears++; }) as any;
  maintenance = startDbMaintenance(db, { log: e => events.push(e) });
  assert.strictEqual(startDbMaintenance(db), maintenance);
  globalThis.setInterval = interval;

  const entered = deferred(), release = deferred();
  const tx = db.transaction(async client => {
    await client.query("INSERT INTO players(id,username,usdd_balance) VALUES('maintenance','Maintenance',1000)");
    entered.resolve(); await release.promise;
    await client.query("UPDATE players SET usdd_balance=1001 WHERE id='maintenance'");
  });
  await entered.promise;
  let settled = false;
  const checkpoint = maintenance.runNow().then(e => { settled = true; return e; });
  for (let i=0;i<64;i++) callback();
  await new Promise(r=>setTimeout(r,20));
  assert.equal(settled,false); release.resolve(); await tx;
  assert.equal((await checkpoint)!.event,'checkpoint_success');
  assert.equal(events.length,1); assert.equal((await q.getPlayer('maintenance')).usdd_balance,1001);
  console.log('PASS checkpoint waits outside transaction; 64 overlapping intervals dropped; one controller per DB');

  const rollbackEntered=deferred(),rollbackRelease=deferred();
  const rollback=assert.rejects(()=>db.transaction(async client=>{
    await client.query("UPDATE players SET usdd_balance=0 WHERE id='maintenance'");
    rollbackEntered.resolve();await rollbackRelease.promise;throw Error('rollback probe');
  }),/rollback probe/);
  await rollbackEntered.promise;
  const afterRollback=maintenance.runNow();rollbackRelease.resolve();
  await rollback;assert.equal((await afterRollback)!.event,'checkpoint_success');
  assert.equal((await q.getPlayer('maintenance')).usdd_balance,1001);
  console.log('PASS checkpoint after rollback preserves pre-transaction balance');

  db.exec = (async () => { throw Error('injected checkpoint error'); }) as typeof db.exec;
  assert.equal((await maintenance.runNow())!.event,'checkpoint_failure'); db.exec = exec;
  assert.equal((await maintenance.runNow())!.event,'checkpoint_success');
  const snapshot = await finances(); await maintenance.runNow(); assert.deepEqual(await finances(),snapshot);
  console.log('PASS failure is logged, next interval recovers, checkpoint leaves economic state unchanged');

  const state = createInitialState(); await commitMarketMutation(state,()=>{});
  const buys = await Promise.all([
    maintenance.runNow(),
    ...Array.from({length:64},()=>executeTrade(state,'maintenance',{coinId:'btcr',side:'buy',amountUsdd:10,requestId:'one-buy'})),
  ]);
  assert.equal((await q.getPlayer('maintenance')).usdd_balance,991);
  assert.equal(buys.slice(1).filter((r:any)=>!r.replayed).length,1);
  await Promise.all([maintenance.runNow(),...Array.from({length:10},(_,i)=>executeTrade(state,'maintenance',{coinId:'btcr',side:'buy',amountUsdd:1,requestId:'distinct-'+i}))]);
  assert.equal((await q.getPlayer('maintenance')).usdd_balance,981);

  const driver = db as any, blob = driver._getWrittenBlob;
  let armed=false,fired=false;
  driver._getWrittenBlob = async function(...args:any[]) {
    if(armed&&!db.isInTransaction()&&!fired){fired=true;throw Error('injected COMMIT then throw');}
    return blob.apply(this,args);
  };
  db.transaction = ((fn:any)=>transaction(async tx=>{const r=await fn(tx);armed=true;return r;})) as typeof db.transaction;
  try {
    const work=assert.rejects(()=>executeTrade(state,'maintenance',{coinId:'btcr',side:'buy',amountUsdd:10,requestId:'uncertain'}),MarketUnavailableError);
    await Promise.all([work,maintenance.runNow()]);
  } finally {db.transaction=transaction;driver._getWrittenBlob=blob;}
  assert.ok(fired); const afterCommit=await finances();
  assert.equal((await executeTrade(state,'maintenance',{coinId:'btcr',side:'buy',amountUsdd:10,requestId:'uncertain'})).replayed,true);
  const afterReplay = await finances();
  // A recovered idempotent replay publishes a new market receipt, not a new trade.
  delete afterCommit.market_commit; delete afterReplay.market_commit;
  assert.deepEqual(afterReplay,afterCommit);
  console.log('PASS 64 same-ID and 10 distinct trades alongside checkpoint; COMMIT-then-throw recovers and replays once');

  const cpEntered=deferred(),cpRelease=deferred(); let calls=0;
  db.exec=(async(sql:string)=>{calls++;cpEntered.resolve();await cpRelease.promise;return exec(sql);}) as typeof db.exec;
  const slow=maintenance.runNow();await cpEntered.promise;
  let stopped=false;const stop=maintenance.stop().then(()=>{stopped=true;});
  assert.equal(await maintenance.runNow(),null);callback();await Promise.resolve();assert.equal(stopped,false);
  cpRelease.resolve();await Promise.all([slow,stop]);assert.equal(calls,1);assert.equal(clears,1);db.exec=exec;
  globalThis.clearInterval=clear;
  maintenance=startDbMaintenance(db,{log(){throw Error('broken logger');}});
  assert.equal((await maintenance.runNow())!.event,'checkpoint_success');await maintenance.stop();
  console.log('PASS shutdown drains pending checkpoint, prevents new work, permits restart; logger failure contained');
  console.log('DB MAINTENANCE TESTS PASSED');
} finally {
  db.exec=exec;db.transaction=transaction;globalThis.setInterval=interval;globalThis.clearInterval=clear;
  await maintenance?.stop();await db.close();
}
