import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';

const mode = process.argv[2] ?? 'main';
process.env.PGDATA_DIR = process.argv[3] ?? 'memory://';
process.env.NODE_ENV = 'test';
const { db, initDb } = await import('../../src/db/index.js');
const q = await import('../../src/db/queries.js');
const { COINS } = await import('../../src/config/coins.js');
const { createInitialState } = await import('../../src/engine/state.js');
const { executeTrade } = await import('../../src/engine/trade.js');
const { commitMarketMutation } = await import('../../src/engine/marketValuation.js');
const { ensureMarketReady, MarketUnavailableError } = await import('../../src/engine/marketRecovery.js');
const { dailyVolumeProgress, recordTradeVolume, utcDay } = await import('../../src/engine/dailyVolume.js');
const { claimQuest } = await import('../../src/engine/quests.js');
const { limitPoolSupply } = await import('../../src/engine/amm.js');
const { createAuthSession } = await import('../../src/auth/sessions.js');
const { createRouter } = await import('../../src/api/routes.js');
const state = createInitialState();
const raw = db.transaction.bind(db), driver = db as any, blob = driver._getWrittenBlob;
const realNow = Date.now;
let clock = Number(process.env.DAILY_VOLUME_TEST_CLOCK ?? realNow()), sequence = 0, passed = 0;
Date.now = () => clock;
const today = utcDay(), tomorrow = utcDay(clock + 86400000);
const app = express(); app.use(express.json());
app.use((req, res, next) => {
  if (mode === 'crash-response' && req.path === '/api/trade') res.json = (() => {
    console.log('crash after settlement before HTTP response'); process.exit(0);
  }) as typeof res.json;
  next();
});
app.use('/api', createRouter(state));
const server = createServer(app);
async function run(name: string, test: () => Promise<void>) { await test(); passed++; console.log(`PASS ${name}`); }
async function player(id: string, balance = 10000) {
  await q.ensurePlayer(id,id); await db.query('UPDATE players SET usdd_balance=$1 WHERE id=$2',[balance,id]);
}
function buy(id: string, amount = 10, requestId = `daily-${++sequence}`, useMax = false) {
  return executeTrade(state,id,{coinId:'btcr',side:'buy',...(useMax?{useMax:true}:{amountUsdd:amount}),requestId});
}
async function progress(id: string, day = utcDay()) { return dailyVolumeProgress(id,db,day); }
async function exactVolume(id: string, expected: string, day = utcDay()) {
  const result = await db.query<{ correct: boolean }>(`SELECT COALESCE((SELECT volume FROM player_daily_volume
    WHERE player_id=$1 AND utc_day=$2::date),0) = $3::numeric AS correct`,[id,day,expected]);
  assert.equal(result.rows[0].correct,true,`${id}: expected exact ${expected}`);
}
async function status(id: string) {
  const {sessionToken} = await createAuthSession(id);
  const response = await fetch(`http://127.0.0.1:${(server.address() as any).port}/api/quests`,{headers:{'X-Session-Token':sessionToken}});
  assert.equal(response.status,200); return (await response.json() as any).dailyVolume;
}
function fault(rollback = false, afterCommit?: () => void, block = false) {
  let armed = false, fired = false, blocked = block;
  driver._getWrittenBlob = async function(...args: any[]) {
    if (armed && !db.isInTransaction() && !fired) { fired = true; afterCommit?.(); throw new Error('after COMMIT'); }
    return blob.apply(this,args);
  };
  db.transaction = ((fn: any) => raw(async tx => {
    const query = tx.query.bind(tx);
    tx.query = (async (sql: string,...args: any[]) => {
      if (blocked && sql.includes('v.price AS valuation')) throw new Error('recovery unavailable');
      return (query as any)(sql,...args);
    }) as typeof tx.query;
    const value = await fn(tx);
    if (!armed && !fired) { armed = true; if (rollback) { fired = true; throw new Error('before COMMIT'); } }
    return value;
  })) as typeof db.transaction;
  return { unblock() { blocked = false; }, restore() { driver._getWrittenBlob = blob; db.transaction = raw; assert.ok(fired); } };
}
async function boot() {
  await initDb();
  for (const p of await q.getAllPoolSnapshots()) state.coins[p.coin_id].pool = {
    coinReserve:p.coin_reserve,usddReserve:p.usdd_reserve,...(p.reference_price==null?{}:{referencePrice:p.reference_price}),
  };
  for (const c of COINS) {
    const owned = await q.getTotalHeldForCoin(c.id); state.coins[c.id].playerOwnedCoins = owned;
    limitPoolSupply(state.coins[c.id].pool,c.emission*(1-c.npcLockedPct),owned,c.startPrice);
  }
  await commitMarketMutation(state,()=>{});
}
function child(stage: string, dir: string) {
  const result = spawnSync(process.execPath,['--import','tsx',process.argv[1],stage,dir],{
    encoding:'utf8',timeout:120000,env:{...process.env,DAILY_VOLUME_TEST_CLOCK:String(clock)},
  });
  assert.equal(result.status,0,result.stdout+result.stderr);
  if (result.stdout.trim()) console.log(result.stdout.trim());
}
async function processPair(seed: string, resume: string) {
  const dir = mkdtempSync(path.join(tmpdir(),'daily-volume-regression-'));
  try { child(seed,dir); child(resume,dir); }
  finally { rmSync(dir,{recursive:true,force:true}); }
}
try {
  await boot(); await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  if (mode === 'seed') {
    for (const [id,amount] of [['partial',123.45],['threshold',1000],['claimed',1000]] as const) {
      await player(id); await buy(id,amount,`restart-${id}`);
      assert.equal((await status(id)).met,amount>=1000);
      if(id==='claimed') await claimQuest(id,'daily_volume');
    }
  } else if (mode === 'resume') {
    for (const [id,amount] of [['partial',123.45],['threshold',1000],['claimed',1000]] as const) {
      await exactVolume(id,String(amount));const s=await status(id);assert.equal(s.current,amount);assert.equal(s.met,amount>=1000);
      const before=await q.getPlayer(id); assert.equal((await buy(id,amount,`restart-${id}`)).replayed,true);assert.deepEqual(await q.getPlayer(id),before);await exactVolume(id,String(amount));
      if(id==='threshold'){assert.equal(await claimQuest(id,'daily_volume'),500);assert.equal((await q.getPlayer(id)).usdd_balance,9500);}
      else if(id==='claimed'){assert.equal(s.claimed,true);await assert.rejects(()=>claimQuest(id,'daily_volume'),/already claimed/);assert.equal(before.usdd_balance,9500);}
    }
    console.log('PASS separate-process restart: partial, threshold +500, prior claim, same requestId');
  } else if (mode.startsWith('crash-')) {
    await player('crash'); let armed=false;
    db.transaction=((fn:any)=>raw(async tx=>{const value=await fn(tx);if(mode==='crash-before')process.exit(0);armed=true;return value;})) as typeof db.transaction;
    if(mode==='crash-after') driver._getWrittenBlob=async function(...args:any[]){if(armed&&!db.isInTransaction())process.exit(0);return blob.apply(this,args);};
    if(mode==='crash-response'){
      const {sessionToken}=await createAuthSession('crash');
      await fetch(`http://127.0.0.1:${(server.address() as any).port}/api/trade`,{method:'POST',headers:{'Content-Type':'application/json','X-Session-Token':sessionToken},body:JSON.stringify({coinId:'btcr',side:'buy',amountUsdd:1000,requestId:'crash-request'})});
      assert.fail('HTTP response must be lost');
    } else {await buy('crash',1000,'crash-request');assert.fail('must crash');}
  } else if (mode.startsWith('verify-')) {
    const committed=mode!=='verify-before'; await exactVolume('crash',committed?'1000':'0');
    assert.equal((await q.getPlayer('crash')).usdd_balance,committed?9000:10000);
    assert.equal((await buy('crash',1000,'crash-request')).replayed,committed);await exactVolume('crash','1000');
    console.log(`PASS ${mode}: committed daily volume and retry survive hard process exit`);
  } else if (mode==='midnight-seed'||mode==='midnight-resume') {
    clock=Date.parse(mode==='midnight-seed'?'2026-10-04T23:59:59Z':'2026-10-05T00:00:00Z');
    if(mode==='midnight-seed')await player('midnight-restart');
    assert.equal((await progress('midnight-restart')).current,0);
    await buy('midnight-restart',mode==='midnight-seed'?10:20,mode);
    if(mode==='midnight-resume'){await exactVolume('midnight-restart','10','2026-10-04');await exactVolume('midnight-restart','20','2026-10-05');}
  } else if (mode==='legacy-seed') {
    await player('legacy');await buy('legacy',1000,'legacy-request');await claimQuest('legacy','daily_volume');
    await db.exec('DROP TABLE player_daily_volume');
  } else if (mode==='legacy-resume') {
    await initDb();await initDb();await exactVolume('legacy','0');assert.equal((await q.getPlayer('legacy')).usdd_balance,9500);
    await assert.rejects(()=>claimQuest('legacy','daily_volume'),/already claimed/);
    assert.equal((await buy('legacy',1000,'legacy-request')).replayed,true);await exactVolume('legacy','0');
    await buy('legacy',123.45);await initDb();await exactVolume('legacy','123.45');
    console.log('PASS old DB migration is repeatable, preserves claims, does not invent legacy volume');
  } else {
    await run('2/10/64 concurrent trades accumulate exact executed volume',async()=>{
      for(const n of [2,10,64]){const id=`concurrent-${n}`;await player(id);await Promise.all(Array.from({length:n},()=>buy(id,10.01)));await exactVolume(id,String(n*1001/100));}
    });
    await run('decimal threshold is exact in DB, status and claim',async()=>{
      await player('decimal');for(let i=0;i<9;i++)await buy('decimal',100.03);await buy('decimal',99.73);
      await exactVolume('decimal','1000');assert.equal((await status('decimal')).met,true);assert.equal(await claimQuest('decimal','daily_volume'),500);
      await player('below');await buy('below',999.9999999999999);assert.equal((await status('below')).met,false);await assert.rejects(()=>claimQuest('below','daily_volume'),/insufficient volume/);
    });
    await run('normal replay, uncertain commit/recovery/replay, rollback/retry',async()=>{
      await player('retry');await buy('retry',10,'same');await Promise.all(Array.from({length:64},()=>buy('retry',10,'same')));await exactVolume('retry','10');
      const f=fault();try{await assert.rejects(()=>buy('retry',20,'uncertain'),MarketUnavailableError);}finally{f.restore();}
      await exactVolume('retry','30');assert.equal((await buy('retry',20,'uncertain')).replayed,true);await exactVolume('retry','30');
      const before=await q.getPlayer('retry'),pool={...state.coins.btcr.pool};const f2=fault(true);
      try{await assert.rejects(()=>buy('retry',40,'rollback'),/before COMMIT/);}finally{f2.restore();}
      await exactVolume('retry','30');assert.deepEqual(await q.getPlayer('retry'),before);assert.deepEqual(state.coins.btcr.pool,pool);
      await buy('retry',40,'rollback');await exactVolume('retry','70');
    });
    await run('failure of the daily increment rolls back settlement and permits retry',async()=>{
      await player('increment-fault');const before=await q.getPlayer('increment-fault');let failed=false;
      db.transaction=((fn:any)=>raw(async tx=>{const query=tx.query.bind(tx);tx.query=(async(sql:string,...args:any[])=>{if(!failed&&sql.includes('INSERT INTO player_daily_volume')){failed=true;throw Error('daily increment failure');}return (query as any)(sql,...args);}) as typeof tx.query;return fn(tx);})) as typeof db.transaction;
      try{await assert.rejects(()=>buy('increment-fault',10,'increment'),/daily increment failure/);}finally{db.transaction=raw;}
      assert.ok(failed);assert.deepEqual(await q.getPlayer('increment-fault'),before);await exactVolume('increment-fault','0');await buy('increment-fault',10,'increment');await exactVolume('increment-fault','10');
    });
    await run('BUY/SELL/MAX/cap preserve exact executed amount semantics',async()=>{
      for(const kind of ['buy-cap','max-cap','sell-cap','max-normal']){
        await player(kind,kind==='max-normal'?123.45678901234567:10000);
        await commitMarketMutation(state,d=>{d.coins.btcr.pool=kind==='max-normal'?{coinReserve:100000,usddReserve:10000000}:{coinReserve:1000,usddReserve:1000};});
        if(kind==='sell-cap'){await db.query('INSERT INTO player_holdings(player_id,coin_id,amount,avg_buy_price) VALUES ($1,$2,1000,1)',[kind,'btcr']);state.coins.btcr.playerOwnedCoins=await q.getTotalHeldForCoin('btcr');await commitMarketMutation(state,()=>{});}
        const result=kind==='sell-cap'?await executeTrade(state,kind,{coinId:'btcr',side:'sell',amountCoin:1000,requestId:'sell-cap'}):await buy(kind,10000,kind,kind!=='buy-cap');
        const expected=kind==='sell-cap'?result.usddAmount:result.totalCharged!;await exactVolume(kind,String(expected));
        if(kind!=='max-normal')assert.equal(result.coinAmount,300);
      }
    });
    await run('decimal storage keeps tiny and large finite amounts without cents rounding',async()=>{
      for(const [id,amount] of [['tiny',Number.MIN_VALUE],['large',Number.MAX_VALUE],['fraction',1.2345678901234567]] as const){await player(id);await db.transaction(tx=>recordTradeVolume(tx,id,utcDay(),amount));await exactVolume(id,String(amount));}
      // Exact eligibility must not be recomputed from rounded UI Number.
      await player('display-rounding');await db.query('INSERT INTO player_daily_volume VALUES ($1,$2::date,$3::numeric)',['display-rounding',utcDay(),'999.999999999999999999999']);
      assert.equal((await progress('display-rounding')).current,1000);assert.equal((await status('display-rounding')).met,false);await assert.rejects(()=>claimQuest('display-rounding','daily_volume'),/insufficient volume/);
    });
    await run('UTC midnight, delayed recovery and concurrent boundary operations',async()=>{
      await player('midnight');clock=Date.parse(`${today}T23:59:59Z`);await buy('midnight',10);clock=Date.parse(`${tomorrow}T00:00:00Z`);await exactVolume('midnight','0');await buy('midnight',20);await exactVolume('midnight','10',today);await exactVolume('midnight','20',tomorrow);
      await player('delayed');clock=Date.parse(`${today}T23:59:59Z`);const f=fault(false,()=>{clock=Date.parse(`${tomorrow}T00:00:01Z`);},true);
      try{await assert.rejects(()=>buy('delayed',1000,'delayed'),MarketUnavailableError);await exactVolume('delayed','1000',today);await exactVolume('delayed','0',tomorrow);f.unblock();await ensureMarketReady(state);assert.equal((await buy('delayed',1000,'delayed')).replayed,true);await exactVolume('delayed','1000',today);await exactVolume('delayed','0',tomorrow);}finally{f.restore();}
      await player('boundary');clock=Date.parse(`${today}T23:59:59Z`);
      let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>entered=r);let first=true;
      db.transaction=((fn:any)=>raw(async tx=>{const query=tx.query.bind(tx);tx.query=(async(sql:string,...args:any[])=>{const result=await (query as any)(sql,...args);if(first&&sql.includes('INSERT INTO player_daily_volume')){first=false;entered();await gate;}return result;}) as typeof tx.query;return fn(tx);})) as typeof db.transaction;
      try{const a=buy('boundary',10);await ready;const b=buy('boundary',20);clock=Date.parse(`${tomorrow}T00:00:00Z`);release();await Promise.all([a,b]);}finally{db.transaction=raw;}
      await exactVolume('boundary','10',today);await exactVolume('boundary','20',tomorrow);clock=realNow();
    });
    await run('separate process restart partial/threshold/claimed',()=>processPair('seed','resume'));
    for(const phase of ['before','after','response'])await run(`hard crash ${phase} COMMIT/response`,()=>processPair(`crash-${phase}`,`verify-${phase}`));
    await run('restart across UTC midnight',()=>processPair('midnight-seed','midnight-resume'));
    await run('legacy migration without historical fabrication',()=>processPair('legacy-seed','legacy-resume'));
    console.log(`DAILY VOLUME TESTS: ${passed} passed`);
  }
} finally {
  Date.now=realNow;db.transaction=raw;driver._getWrittenBlob=blob;
  await new Promise<void>(r=>server.close(()=>r()));if(!db.closed)await db.close();
}
