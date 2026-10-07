import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, statSync, writeFileSync, readFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// No user-supplied PGDATA is accepted. Child paths are allocated by this parent.
const mode = process.argv[2] ?? 'stress';
const child = mode === 'verify' || mode === 'crash';
const dir = child ? process.env.WAL_TEST_DIRECTORY! : mkdtempSync(path.join(tmpdir(), 'wal-maintenance-'));
assert.ok(path.resolve(dir).startsWith(path.join(tmpdir(), 'wal-maintenance-')));
process.env.PGDATA_DIR = dir;
process.env.NODE_ENV = 'production';
delete process.env.RUN_PLAYER_RESET;
const { db, initDb } = await import('../../src/db/index.js');
const { createInitialState } = await import('../../src/engine/state.js');
const { startEngineLoop } = await import('../../src/engine/tick.js');
const { commitMarketMutation } = await import('../../src/engine/marketValuation.js');
const { persistPoolSnapshots } = await import('../../src/engine/poolPersistence.js');
const { withMarketState } = await import('../../src/engine/marketRecovery.js');
const { executeTrade } = await import('../../src/engine/trade.js');
const { startDbMaintenance, CHECKPOINT_INTERVAL_MS } = await import('../../src/db/maintenance.js');
const q = await import('../../src/db/queries.js');
async function snapshot() {
  const result: Record<string, unknown> = {};
  for (const table of ['players','player_holdings','coin_pools','market_valuation_prices','market_commit','player_rank_progress','trade_requests','trade_log','player_daily_volume']) {
    result[table] = (await db.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
  }
  return result;
}
function bytes(p: string): number {
  return readdirSync(p, {withFileTypes:true}).reduce((sum,e)=>sum+(e.isDirectory()?bytes(path.join(p,e.name)):statSync(path.join(p,e.name)).size),0);
}
const expectedFile = path.join(dir, 'expected.json');
if (child) {
  await initDb();
  assert.deepEqual(await snapshot(), JSON.parse(readFileSync(expectedFile,'utf8')));
  if (mode === 'crash') {
    const phase = process.env.WAL_TEST_PHASE;
    if (phase === 'before') { process.send!('kill'); await new Promise(()=>{}); }
    if (phase === 'during') process.send!('kill');
    await db.exec('CHECKPOINT');
    if (phase === 'after') process.send!('kill');
    await new Promise(()=>{});
  } else {
    const state = createInitialState();
    for (const row of await q.getAllPoolSnapshots()) state.coins[row.coin_id].pool = {
      coinReserve:row.coin_reserve,usddReserve:row.usdd_reserve,
      ...(row.reference_price == null ? {} : {referencePrice:row.reference_price}),
    };
    const before = await snapshot();
    const replay = await executeTrade(state,'wal-player',{coinId:'btcr',side:'buy',amountUsdd:10,requestId:'restart-replay'});
    assert.equal(replay.replayed,true);
    const after = await snapshot(); delete before.market_commit; delete after.market_commit;
    assert.deepEqual(after,before);
    await db.close(); console.log('PASS restart: exact durable state and idempotent retry');
  }
} else {
  const ticks = Number(process.env.WAL_TEST_TICKS ?? 20000);
  const seconds = Number(process.env.WAL_TEST_INTERVAL ?? CHECKPOINT_INTERVAL_MS/1000);
  assert.ok(Number.isSafeInteger(ticks) && ticks > 0);
  assert.ok(Number.isSafeInteger(seconds) && seconds >= 0);
  await initDb(); const state = createInitialState(); await commitMarketMutation(state,()=>{});
  await db.query("INSERT INTO players(id,username,usdd_balance) VALUES('wal-player','WAL',1000000)");
  await executeTrade(state,'wal-player',{coinId:'btcr',side:'buy',amountUsdd:10,requestId:'restart-replay'});
  const events: {durationMs:number;event:string}[] = [];
  const maintenance = startDbMaintenance(db,{intervalMs:2_000_000_000,log:e=>events.push(e)});
  let fire!:()=>void;
  const interval=globalThis.setInterval;
  globalThis.setInterval=((fn:()=>void,ms:number)=>{assert.equal(ms,1000);fire=fn;return {unref(){}};}) as any;
  startEngineLoop(state,()=>{}); globalThis.setInterval=interval;
  const samples: {tick:number;total:number;wal:number;base:number}[]=[];
  const sample=(tick:number)=>{
    const s={tick,total:bytes(dir),wal:bytes(path.join(dir,'pg_wal')),base:bytes(path.join(dir,'base'))};
    samples.push(s);console.log(JSON.stringify(s));
  };
  sample(0);const started=performance.now();
  try {
    for(let i=1;i<=ticks;i++) {
      const cp=seconds && i%seconds===0 ? maintenance.runNow() : Promise.resolve(null);
      fire();
      if(i%300===0) {
        await Promise.all(Array.from({length:10},(_,j)=>executeTrade(state,'wal-player',{
          coinId:'btcr',side:'buy',amountUsdd:1,requestId:`parallel-${i}-${j}`,
        })));
        await executeTrade(state,'wal-player',{coinId:'btcr',side:'sell',useMax:true,requestId:`sell-${i}`});
      }
      await withMarketState(state,()=>{}); await cp;
      await new Promise<void>(resolve=>setImmediate(resolve));
      assert.equal(state.tickCount,i,'every simulated second must execute one durable tick');
      if(i%10===0) await persistPoolSnapshots(state);
      if(i%1000===0) sample(i);
    }
    assert.ok(events.every(e=>e.event==='checkpoint_success'));
    if(seconds && ticks>=20000) {
      const late=samples.filter(s=>s.tick>=ticks/2);
      assert.ok(Math.max(...late.map(s=>s.wal))-Math.min(...late.map(s=>s.wal))<=2*1024*1024,'WAL must plateau');
    }
    console.log(JSON.stringify({dir,ticks,seconds,elapsedMs:performance.now()-started,checkpointMs:events.map(e=>e.durationMs),samples}));
    writeFileSync(expectedFile,JSON.stringify(await snapshot()));
  } finally {await maintenance.stop();await db.close();}
  async function runChild(directory:string, action:string, phase?:string) {
    await new Promise<void>((resolve,reject)=>{
      const proc=fork(fileURLToPath(import.meta.url),[action],{
        execArgv:['--import','tsx'],stdio:['ignore','inherit','inherit','ipc'],
        env:{...process.env,WAL_TEST_DIRECTORY:directory,WAL_TEST_PHASE:phase},
      });
      let killed=false;
      proc.on('message',msg=>{if(msg==='kill'){killed=true;proc.kill('SIGKILL');}});
      proc.on('error',reject);
      proc.on('exit',(code)=>{if(code===0||killed)resolve();else reject(Error(`child exit ${code}`));});
    });
  }
  // Separate copies: abrupt checkpoint termination must preserve the exact
  // pre-checkpoint finances. 'during' races the SQL call, not a claimed fsync offset.
  for(const phase of ['before','during','after']) {
    const copy=mkdtempSync(path.join(tmpdir(),'wal-maintenance-'));
    cpSync(dir,copy,{recursive:true});
    await runChild(copy,'crash',phase);await runChild(copy,'verify');
    console.log(`PASS kill/restart ${phase} checkpoint`);
  }
  await runChild(dir,'verify');
  console.log('WAL MAINTENANCE STRESS PASSED');
}
