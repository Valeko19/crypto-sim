import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
process.env.NODE_ENV = 'production';
process.env.PGDATA_DIR = process.argv[3] ?? 'memory://';
const mode = process.argv[2] ?? 'main';
const { db, initDb } = await import('../../src/db/index.js');
const q = await import('../../src/db/queries.js');
const { createInitialState } = await import('../../src/engine/state.js');
const { runTradingBots } = await import('../../src/engine/tradingBot.js');
const { createRouter } = await import('../../src/api/routes.js');
const { createAuthSession } = await import('../../src/auth/sessions.js');
const { commitMarketMutation } = await import('../../src/engine/marketValuation.js');
const { COINS } = await import('../../src/config/coins.js');
const { remainingSupply } = await import('../../src/engine/supply.js');
const state = createInitialState(), raw = db.query.bind(db), rawTx = db.transaction.bind(db);
const app = express(); app.use(express.json()); app.use('/api', createRouter(state));
const server = createServer(app);
let id = '', token = '', seq = mode === 'resume' ? 1000 : 0, passed = 0;
async function api(route: string, body?: unknown, expected = 200) {
  const r = await fetch(`http://127.0.0.1:${(server.address() as any).port}/api/bot${route}`, { method: body ? 'POST' : 'GET', headers: { 'X-Session-Token': token, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
  const data = await r.json(); assert.equal(r.status, expected, JSON.stringify(data)); return data as any;
}
const config = (coinId = 'btcr', amount = 10, intervalMs = 1000, side = 'buy', expected = 200) => api('/config', { coinId, amount, intervalMs, side }, expected);
const toggle = (enabled: boolean) => api('/toggle', { enabled });
async function setup(name: string) { await db.query('UPDATE trading_bots SET enabled=FALSE'); id = name; await q.ensurePlayer(id, id); await db.query('UPDATE players SET usdd_balance=100 WHERE id=$1', [id]); token = (await createAuthSession(id)).sessionToken; await config(); }
async function due(timestamp = new Date(Date.parse('2020-01-01') + (++seq) * 1000).toISOString()) { await db.query('UPDATE trading_bots SET next_run_at=$2 WHERE player_id=$1', [id, timestamp]); return timestamp; }
async function fire() { await due(); await runTradingBots(state); }
async function snap() { return { bot: await q.getTradingBot(id), player: await q.getPlayer(id), holdings: (await db.query('SELECT * FROM player_holdings WHERE player_id=$1 ORDER BY coin_id', [id])).rows }; }
async function checkMoney() {
  assert.equal((await db.query('SELECT id FROM players WHERE usdd_balance<0')).rows.length, 0);
  assert.equal((await db.query('SELECT player_id FROM player_holdings WHERE amount<0')).rows.length, 0);
  for (const c of COINS) assert.ok(state.coins[c.id].pool.coinReserve <= remainingSupply(c.emission * (1-c.npcLockedPct), await q.getTotalHeldForCoin(c.id)));
}
async function test(name: string, fn: () => Promise<void>) { await fn(); await checkMoney(); passed++; console.log('PASS '+name); }
function pollBarrier(n = 1) {
  let arrived = 0, release!: () => void, signal!: () => void;
  const gate = new Promise<void>(r => release = r), reached = new Promise<void>(r => signal = r);
  db.query = (async (sql: string, ...args: any[]) => { const rows = await (raw as any)(sql, ...args); if (sql.includes('SELECT * FROM trading_bots WHERE enabled = TRUE') && arrived < n) { if (++arrived === n) signal(); await gate; } return rows; }) as typeof db.query;
  return { reached, release() { db.query = raw; release(); } };
}
function child(stage: string, dir: string) { const r = spawnSync(process.execPath, ['--import','tsx',process.argv[1],stage,dir], {encoding:'utf8',timeout:120000}); assert.equal(r.status,0,`${r.error ?? ''}\n${r.stdout}\n${r.stderr}`); console.log(r.stdout.trim()); }
try {
  await initDb();
  for (const p of await q.getAllPoolSnapshots()) state.coins[p.coin_id].pool = {coinReserve:p.coin_reserve,usddReserve:p.usdd_reserve,...(p.reference_price==null?{}:{referencePrice:p.reference_price})};
  for (const c of COINS) state.coins[c.id].playerOwnedCoins = await q.getTotalHeldForCoin(c.id);
  await commitMarketMutation(state,()=>{});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  if (mode !== 'main') {
    const file = path.join(process.argv[3], 'audit-bot.json');
    if (mode === 'legacy') {
      await setup('restart'); await toggle(true); await fire();
      const s = await snap(); delete (s.bot as any).run_id;
      writeFileSync(file, JSON.stringify(s)); await db.query('ALTER TABLE trading_bots DROP COLUMN run_id');
    } else {
      id='restart'; token=(await createAuthSession(id)).sessionToken;
      const saved=JSON.parse(readFileSync(file,'utf8')), current=JSON.parse(JSON.stringify(await snap()));
      if(mode==='migrate') { const identity=current.bot!.run_id; assert.ok(identity); delete (current.bot as any).run_id; assert.deepEqual(current,saved); await initDb(); assert.equal((await q.getTradingBot(id))!.run_id,identity); writeFileSync(file,JSON.stringify(await snap())); }
      else { assert.deepEqual(JSON.parse(JSON.stringify(await snap())),saved); await fire(); const s=await snap(); assert.equal(s.bot!.run_id,saved.bot.run_id); assert.equal(s.bot!.run_total_usdd,20); assert.equal(s.player.usdd_balance,80); assert.equal(s.player.trades_count,2); }
    }
    console.log('PASS process '+mode);
  } else {
    await test('A/B/C/D/E/G: immutable run, stop/edit/start, totals and API identity', async()=>{
      await setup('basic'); await toggle(true); await fire(); const one=await snap(); assert.equal(one.bot!.run_total_usdd,10);
      for(const change of [()=>config('embr',10,1000,'buy',409),()=>config('btcr',20,3000,'buy',409)]) { await change(); assert.deepEqual(await snap(),one); }
      await fire(); await fire(); await toggle(false); const stopped=await snap(); assert.equal(stopped.bot!.run_total_usdd,30); assert.equal(stopped.player.usdd_balance,70);
      await config('embr',20,3000); assert.equal((await q.getTradingBot(id))!.run_total_usdd,30); await toggle(true); const started=await snap(); assert.notEqual(started.bot!.run_id,stopped.bot!.run_id); assert.equal(started.bot!.run_total_usdd,0); assert.equal((await api('')).config.runId,started.bot!.run_id);
      await fire(); const s=await snap(); assert.equal(s.bot!.run_total_usdd,20); assert.equal(s.player.usdd_balance,50); assert.ok(s.holdings.some((h:any)=>h.coin_id==='embr'));
    });
    for(const n of [2,10,64]) await test(`${n} Starts/polls; stale poll after Stop and same-timestamp new run`,async()=>{
      await setup('concurrent-'+n); await Promise.all(Array.from({length:n},()=>toggle(true))); await fire(); const before=await snap();
      await Promise.all(Array.from({length:n},()=>toggle(true))); assert.deepEqual(await snap(),before);
      await due(); let b=pollBarrier(n); let jobs=Array.from({length:n},()=>runTradingBots(state)); await b.reached; b.release(); await Promise.all(jobs); assert.equal((await q.getPlayer(id)).trades_count,2); assert.equal((await q.getTradingBot(id))!.run_total_usdd,20);
      const timestamp=await due(); b=pollBarrier(n); jobs=Array.from({length:n},()=>runTradingBots(state)); await b.reached; await toggle(false); const stop=await snap(); b.release(); await Promise.all(jobs); assert.deepEqual(await snap(),stop);
      await toggle(true); await due(timestamp); b=pollBarrier(n); jobs=Array.from({length:n},()=>runTradingBots(state)); await b.reached; await toggle(false); await config('embr',20); await toggle(true); await due(timestamp); const fresh=await snap(); b.release(); await Promise.all(jobs); assert.deepEqual(await snap(),fresh); await runTradingBots(state); assert.equal((await q.getPlayer(id)).trades_count,3); assert.equal((await q.getTradingBot(id))!.run_total_usdd,20);
    });
    await test('Start vs config: atomic interval read, both orderings',async()=>{
      for(const configFirst of [true,false]) { await setup('order-'+configFirst); let release!:()=>void,signal!:()=>void; const gate=new Promise<void>(r=>release=r),reached=new Promise<void>(r=>signal=r); let held=false;
        db.query=(async(sql:string,...args:any[])=>{if(!held && (configFirst?sql.includes('UPDATE trading_bots SET enabled = TRUE'):sql.includes('INSERT INTO trading_bots'))){held=true;signal();await gate;}return (raw as any)(sql,...args);}) as typeof db.query;
        const pending=configFirst?toggle(true):config('embr',20,60000,'buy',409); await reached; if(configFirst)await config('embr',20,60000);else await toggle(true); release();await pending;db.query=raw;
        const bot=(await q.getTradingBot(id))!;assert.equal(bot.interval_ms,configFirst?60000:1000);const delay=new Date(bot.next_run_at!).getTime()-Date.now();assert.ok(delay>bot.interval_ms!-5000 && delay<=bot.interval_ms!); }
    });
    await test('Stop waits for locked firing; later polls cannot trade',async()=>{
      await setup('stop-lock');await toggle(true);await due();let release!:()=>void,signal!:()=>void;const gate=new Promise<void>(r=>release=r),reached=new Promise<void>(r=>signal=r);let held=false;
      db.transaction=((fn:any)=>rawTx(async tx=>{const query=tx.query.bind(tx);tx.query=(async(sql:string,...args:any[])=>{const value=await (query as any)(sql,...args);if(!held&&sql.includes('next_run_at <= now()')){held=true;signal();await gate;}return value;}) as typeof tx.query;return fn(tx);})) as typeof db.transaction;
      const firing=runTradingBots(state);await reached;let stopped=false;const stop=toggle(false).then(()=>{stopped=true;});await new Promise(r=>setImmediate(r));assert.equal(stopped,false);release();await Promise.all([firing,stop]);db.transaction=rawTx;const before=await snap();await runTradingBots(state);assert.deepEqual(await snap(),before);assert.equal(before.player.trades_count,1);
    });
    await test('rejected and capped BUY/SELL retain execution-based totals',async()=>{
      await setup('reject');await config('btcr',101);await toggle(true);await fire();assert.equal((await q.getTradingBot(id))!.run_total_usdd,0);await toggle(false);await config('embr',10,1000,'sell');await toggle(true);await fire();assert.equal((await q.getPlayer(id)).trades_count,0);
      await setup('cap');await db.query('UPDATE players SET usdd_balance=10000 WHERE id=$1',[id]);await commitMarketMutation(state,d=>{d.coins.btcr.pool={coinReserve:1000,usddReserve:1000};});await config('btcr',10000);await toggle(true);await fire();let b=(await q.getTradingBot(id))!;assert.equal(b.run_total_coins,300);assert.ok(Math.abs(b.run_total_usdd-432.900432900433)<1e-10);await toggle(false);await config('btcr',300,1000,'sell');await toggle(true);await fire();b=(await q.getTradingBot(id))!;assert.equal(b.run_total_coins,210);assert.ok(Math.abs(b.run_total_usdd-326.3736263736264)<1e-10);
    });
    await test('driver throws after COMMIT: one trade and totals increment',async()=>{
      await setup('uncertain');await toggle(true);await due();const driver=db as any,blob=driver._getWrittenBlob;let armed=false,fired=false;
      driver._getWrittenBlob=async function(...args:any[]){if(armed&&!db.isInTransaction()&&!fired){fired=true;throw Error('after COMMIT');}return blob.apply(this,args);};db.transaction=((fn:any)=>rawTx(async tx=>{const result=await fn(tx);armed=true;return result;})) as typeof db.transaction;
      try{await runTradingBots(state);}finally{driver._getWrittenBlob=blob;db.transaction=rawTx;}assert.ok(fired);await runTradingBots(state);assert.equal((await q.getPlayer(id)).trades_count,1);assert.equal((await q.getTradingBot(id))!.run_total_usdd,10);
    });
    await test('old schema migration/restart preserve identity, financial state and totals',async()=>{const dir=mkdtempSync(path.join(tmpdir(),'bot-lifecycle-'));try{child('legacy',dir);child('migrate',dir);child('resume',dir);}finally{rmSync(dir,{recursive:true,force:true});}});
    console.log(`BOT LIFECYCLE TESTS: ${passed} passed`);
  }
} finally { db.query=raw;db.transaction=rawTx;server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await db.close(); }
