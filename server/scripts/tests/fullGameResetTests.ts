import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
process.env.PGDATA_DIR=process.argv[3]??'memory://';
process.env.NODE_ENV='production';process.env.TELEGRAM_BOT_TOKEN='reset-test-only';delete process.env.RUN_PLAYER_RESET;
const mode=process.argv[2]??'main';
const {db,initDb}=await import('../../src/db/index.js');
const q=await import('../../src/db/queries.js');
const {applyFullReset,inspectReset,verifyFullReset,CLEARED_TABLES}=await import('../../src/admin/fullGameReset.js');
const {createInitialState}=await import('../../src/engine/state.js');
const {commitMarketMutation}=await import('../../src/engine/marketValuation.js');
const {executeTrade}=await import('../../src/engine/trade.js');
const {createAuthSession,resolveAuthSession}=await import('../../src/auth/sessions.js');
const {createRouter}=await import('../../src/api/routes.js');
const {createAuthRouter}=await import('../../src/api/authRoutes.js');
const {getGameEpoch}=await import('../../src/db/gameEpoch.js');
const {COINS}=await import('../../src/config/coins.js');
const state=createInitialState(),raw=db.transaction.bind(db);
async function snapshot(){const data:any={};for(const t of ['players',...CLEARED_TABLES,'coin_pools','market_valuation_prices','market_commit','game_epoch','admin_reset_log'])data[t]=(await db.query(`SELECT to_jsonb(t) AS row FROM ${t} t ORDER BY to_jsonb(t)::text`)).rows;return data;}
async function seed(){
  await q.ensurePlayer('tg_101','A');await q.ensurePlayer('dev_reset','Developer');
  await db.query('UPDATE players SET usdd_balance=5000');await commitMarketMutation(state,()=>{});
  await executeTrade(state,'tg_101',{coinId:'btcr',side:'buy',amountUsdd:1000,requestId:'old-intent'});
  await db.query("INSERT INTO quest_progress VALUES('tg_101','daily_bonus','none',0,now())");
  await db.query("INSERT INTO player_earned_totals VALUES('tg_101',500,200,1000)");
  await db.query("INSERT INTO player_rank_progress VALUES('tg_101',5) ON CONFLICT DO NOTHING");
  await db.query("INSERT INTO staking_positions(id,player_id,coin_id,amount,mode,stake_price,pending_rewards) VALUES('stake','tg_101','btcr',0.001,'flexible',40000,9)");
  await q.configureTradingBot('tg_101','btcr','buy',1000,10);await q.setTradingBotEnabled('tg_101',true);
  await db.query("UPDATE trading_bots SET run_total_usdd=123,run_total_coins=5");
  await db.query("INSERT INTO admin_reset_log(id) VALUES('preserve-me')");
  return (await createAuthSession('tg_101')).sessionToken;
}
function child(stage:string,dir:string){const r=spawnSync(process.execPath,['--import','tsx',process.argv[1],stage,dir],{encoding:'utf8',timeout:120000});assert.equal(r.status,0,`${r.error??''}\n${r.stdout}\n${r.stderr}`);console.log(r.stdout.trim());}
function cli(args:string[],expected=0){const r=spawnSync(process.execPath,['--import','tsx','scripts/reset-game.ts',...args],{encoding:'utf8',timeout:120000,env:{...process.env,RUN_PLAYER_RESET:''}});assert.equal(r.status,expected,`${r.error??''}\n${r.stdout}\n${r.stderr}`);return r.stdout;}
async function functional(oldToken:string){
  // Fresh startup reconciles only the new durable pools, before accepting HTTP.
  for(const p of await q.getAllPoolSnapshots())state.coins[p.coin_id].pool={coinReserve:p.coin_reserve,usddReserve:p.usdd_reserve,referencePrice:p.reference_price??undefined};
  for(const c of COINS)state.coins[c.id].playerOwnedCoins=await q.getTotalHeldForCoin(c.id);
  await commitMarketMutation(state,()=>{});
  const app=express();app.use(express.json());app.use('/api/auth',createAuthRouter());app.use('/api',createRouter(state));const server=createServer(app);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${(server.address() as any).port}/api`;
  const request=async(route:string,body?:unknown,token?:string,epoch?:string)=>{const r=await fetch(base+route,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(token?{'X-Session-Token':token}:{}),...(epoch?{'X-Game-Epoch':epoch}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json() as any};};
  try{
    const params=new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)),user:JSON.stringify({id:101,first_name:'A'})});const check=[...params.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n');const key=createHmac('sha256','WebAppData').update(process.env.TELEGRAM_BOT_TOKEN!).digest();params.set('hash',createHmac('sha256',key).update(check).digest('hex'));
    const oldBody={coinId:'btcr',side:'buy',amountUsdd:10,requestId:'old-intent'};
    assert.equal((await request('/trade',oldBody,oldToken,'0')).status,401);
    const auth=await request('/auth/bootstrap',{initData:params.toString()});assert.equal(auth.status,200);const token=auth.body.sessionToken,epoch=auth.body.gameEpoch;assert.notEqual(epoch,'0');
    const before=await snapshot();
    for(const route of ['/trade','/quests/claim','/staking/stake','/staking/request-unstake','/staking/withdraw','/staking/break-lock','/staking/claim','/shop/purchase','/bot/config','/bot/toggle']){
      assert.equal((await request(route,oldBody,token,'0')).status,409);assert.equal((await request(route,oldBody,token)).status,409);
    }
    // Auth session activity timestamps legitimately change; financial rows do not.
    const after=await snapshot();delete before.auth_sessions;delete after.auth_sessions;assert.deepEqual(after,before);
    assert.equal((await request('/bot',undefined,token)).body.config,null);
    const portfolio=(await request('/portfolio',undefined,token)).body;assert.equal(portfolio.usddBalance,100);assert.equal(portfolio.netWorth,100);assert.equal(portfolio.leagueIndex,0);
    assert.equal((await request('/quests',undefined,token)).body.dailyVolume.current,0);
    const buy=await request('/trade',{...oldBody,requestId:'new-intent'},token,epoch);assert.equal(buy.status,200);
    assert.equal((await request('/trade',{coinId:'btcr',side:'sell',useMax:true,requestId:'new-sell'},token,epoch)).status,200);
    const claims=await Promise.all(Array.from({length:10},()=>request('/quests/claim',{questId:'daily_bonus'},token,epoch)));assert.equal(claims.filter(r=>r.status===200).length,1);
    assert.equal((await request('/bot/config',{coinId:'btcr',side:'buy',amount:10,intervalMs:1000},token,epoch)).status,200);
    assert.equal((await request('/bot/toggle',{enabled:true},token,epoch)).status,200);const bot=(await request('/bot',undefined,token)).body.config;assert.ok(bot.runId);assert.equal(bot.runTotalUsdd,0);
    for(const c of COINS){const held=await q.getTotalHeldForCoin(c.id);assert.ok(held+state.coins[c.id].pool.coinReserve<=c.emission*(1-c.npcLockedPct));}
    console.log('PASS fresh bootstrap, old token/epoch/missing epoch rejection, all mutations, BUY/SELL, single reward and clean bot');
  }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
}
try{
  await initDb();
  if(mode==='seed'){
    const token=await seed();writeFileSync(path.join(process.argv[3],'old-token.json'),JSON.stringify({token,snapshot:await snapshot()}));
  }else if(mode==='dry-verify'){
    assert.deepEqual(await snapshot(),JSON.parse(readFileSync(path.join(process.argv[3],'old-token.json'),'utf8')).snapshot);console.log('PASS CLI dry-run unchanged');
  }else if(mode==='resume'){
    const receipt=JSON.parse(readFileSync(path.join(process.argv[3],'receipt.json'),'utf8'));await verifyFullReset(db,receipt);
    await functional(JSON.parse(readFileSync(path.join(process.argv[3],'old-token.json'),'utf8')).token);
  }else if(mode==='receipt'){
    const row=(await db.query<{details:unknown}>("SELECT to_jsonb(r)->'details' AS details FROM admin_reset_log r WHERE id='full_game_reset:disk-reset'")).rows[0];assert.ok(row);writeFileSync(path.join(process.argv[3],'receipt.json'),JSON.stringify(row.details));
  }else{
    const token=await seed(),before=await snapshot();assert.ok(await resolveAuthSession(token));const baseline=await snapshot();
    const stages=['UPDATE players SET','DELETE FROM player_holdings','DELETE FROM player_earned_totals','DELETE FROM trading_bots','DELETE FROM auth_sessions','INSERT INTO coin_pools','INSERT INTO market_valuation_prices','INSERT INTO game_epoch','before-COMMIT'];
    for(const stage of stages){let hit=false;db.transaction=((fn:any)=>raw(async tx=>{const query=tx.query.bind(tx);tx.query=(async(sql:string,...args:any[])=>{const result=await (query as any)(sql,...args);if(!hit&&sql.startsWith(stage)){hit=true;throw Error('injected '+stage);}return result;}) as typeof tx.query;const result=await fn(tx);if(stage==='before-COMMIT'){hit=true;throw Error('injected before COMMIT');}return result;})) as typeof db.transaction;
      try{await assert.rejects(()=>applyFullReset(db,'fault-'+stages.indexOf(stage)),/injected/);}finally{db.transaction=raw;}assert.ok(hit);assert.deepEqual(await snapshot(),baseline);console.log('PASS rollback '+stage);
    }
    // Upgrade a pre-epoch database without running initDb migrations first.
    await db.query('DROP TABLE game_epoch');
    assert.equal((await inspectReset(db)).epoch,'0');
    const driver=db as any,blob=driver._getWrittenBlob;let armed=false,fired=false;
    driver._getWrittenBlob=async function(...args:any[]){if(armed&&!db.isInTransaction()&&!fired){fired=true;throw Error('after COMMIT');}return blob.apply(this,args);};db.transaction=((fn:any)=>raw(async tx=>{const v=await fn(tx);armed=true;return v;})) as typeof db.transaction;
    let outcome;
    try{outcome=await applyFullReset(db,'uncertain');}finally{db.transaction=raw;driver._getWrittenBlob=blob;}
    assert.ok(fired);assert.ok(outcome.alreadyCommitted);await verifyFullReset(db,outcome.receipt);const clean=await snapshot();assert.ok((await applyFullReset(db,'uncertain')).alreadyCommitted);assert.deepEqual(await snapshot(),clean);assert.equal(await resolveAuthSession(token),null);assert.equal((await inspectReset(db)).devPlayers,1);assert.equal((await db.query("SELECT id FROM admin_reset_log WHERE id='preserve-me'")).rows.length,1);
    console.log('PASS uncertain COMMIT marker, idempotent retry, identities/dev players and old admin log preserved');
    const dir=mkdtempSync(path.join(tmpdir(),'full-reset-only-test-'));
    try{
      child('seed',dir);cli(['--pgdata',dir],1);cli(['--pgdata',dir,'--maintenance','--yes'],1);
      const dry=cli(['--pgdata',dir,'--maintenance']);assert.ok(dry.includes('DRY RUN'));child('dry-verify',dir);
      const output=cli(['--pgdata',dir,'--maintenance','--yes','--operation-id','disk-reset']);assert.ok(output.includes('VERIFIED FULL RESET'));child('receipt',dir);child('resume',dir);
    }finally{rmSync(dir,{recursive:true,force:true});}
    console.log('FULL GAME RESET TESTS PASSED');
  }
}finally{db.transaction=raw;await db.close();}
