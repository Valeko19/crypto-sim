import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import express from 'express';
import { createServer } from 'node:http';
import { WebSocket } from 'ws';

process.env.PGDATA_DIR = 'memory://';
process.env.NODE_ENV = 'production';
process.env.TELEGRAM_BOT_TOKEN = 'account-isolation-test-only';
delete process.env.ALLOW_DEV_AUTH;
const { db, initDb } = await import('../../src/db/index.js');
const { ensurePlayer, getPlayer, getHolding, getTradingBot } = await import('../../src/db/queries.js');
const { revokeAuthSession } = await import('../../src/auth/sessions.js');
const { createInitialState } = await import('../../src/engine/state.js');
const { createRouter } = await import('../../src/api/routes.js');
const { createAuthRouter } = await import('../../src/api/authRoutes.js');
const { createWsServer } = await import('../../src/ws/server.js');
const A = 910001, B = 910002;
const sessionKey = 'crypto_sim_session_v2';
const sourceRoot = fileURLToPath(new URL('../../../client/src/', import.meta.url));
const app = express(); app.use(express.json());
app.use('/api/auth', createAuthRouter()); app.use('/api', createRouter(createInitialState()));
const server = createServer(app), hub = createWsServer(server);
let base = '', passed = 0;
const nativeFetch = globalThis.fetch;
function signed(id: number, age = 0) {
  const p = new URLSearchParams({ auth_date: String(Math.floor(Date.now()/1000)-age), user: JSON.stringify({id,first_name:id===A?'A':'B'}) });
  const key = createHmac('sha256','WebAppData').update(process.env.TELEGRAM_BOT_TOKEN!).digest();
  p.set('hash',createHmac('sha256',key).update([...p].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n')).digest('hex'));
  return p.toString();
}
function deferred<T>() {
  let resolve!: (value:T)=>void;
  const promise = new Promise<T>(r=>{resolve=r;});
  return {promise,resolve};
}
async function until(test:()=>boolean) {
  for(let i=0;i<300;i++) {if(test())return;await new Promise(r=>setTimeout(r,10));}
  throw new Error('condition timed out');
}
type Intercept = (url:string, options:any, next:()=>Promise<Response>)=>Promise<Response>;
function browser(id:number|null=A, storage=new Map<string,string>(), dev=false, intercept?:Intercept, realWs=false) {
  const calls: {url:string;options:any}[]=[];
  const sockets: any[]=[];
  const timers=new Map<number,{fn:()=>void;delay:number;interval:boolean}>();let timerId=0;
  const events=new Map<string,()=>void>();
  class FakeSocket {
    static OPEN=1;
    readyState=0; onopen:any;onclose:any;onmessage:any;sent:any[]=[];
    constructor(public url:string){sockets.push(this);}
    open(){this.readyState=1;this.onopen?.();}
    close(){this.readyState=3;this.onclose?.();}
    send(data:string){this.sent.push(JSON.parse(data));}
    frame(type:string,payload:any){this.onmessage?.({data:JSON.stringify({type,payload})});}
  }
  const window:any={Telegram:{WebApp:{initData:id?signed(id):'',ready(){},expand(){}}},
    addEventListener:(name:string,fn:()=>void)=>events.set(name,fn),removeEventListener:(name:string)=>events.delete(name)};
  const sandbox:any={console,URLSearchParams,AbortController,crypto:{randomUUID},location:{protocol:'http:',host:'unused'},window,
    document:{addEventListener:(n:string,f:()=>void)=>events.set(n,f),removeEventListener:(n:string)=>events.delete(n),getElementById:()=>({})},
    sessionStorage:{getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>storage.set(k,v),removeItem:(k:string)=>storage.delete(k)},
    localStorage:{getItem:()=>null,setItem(){}},
    fetch:(url:string,options:any={})=>{calls.push({url,options});const next=()=>nativeFetch(url,options);return intercept?intercept(url,options,next):next();},
    setTimeout:(fn:()=>void,delay:number)=>{timers.set(++timerId,{fn,delay,interval:false});return timerId;},
    setInterval:(fn:()=>void,delay:number)=>{timers.set(++timerId,{fn,delay,interval:true});return timerId;},
    clearTimeout:(n:number)=>timers.delete(n),clearInterval:(n:number)=>timers.delete(n),
    WebSocket:realWs?WebSocket:FakeSocket,
  };
  const realm=vm.createContext(sandbox),modules=new Map<string,any>();let rendered:any;
  let accountRef: { current: unknown } | undefined;
  const load=(name:string):any=>{
    if(modules.has(name))return modules.get(name);
    const exports:any={};modules.set(name,exports);
    const source=readFileSync(path.join(sourceRoot,name),'utf8').replaceAll('import.meta.env',JSON.stringify({VITE_API_BASE:base,DEV:dev}));
    const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText;
    const require=(spec:string):any=>{
      if(spec==='./telegram'||spec==='./lib/telegram'||spec==='../lib/telegram')return load('lib/telegram.ts');
      if(spec==='./api')return load('lib/api.ts');
      if(spec==='react') {
        const react={createElement:(type:any,props:any,...children:any[])=>({type,props,children}),
          useSyncExternalStore:(_subscribe:any,getSnapshot:()=>any)=>getSnapshot(),
          useState:()=>[null,()=>{}],useEffect:()=>{},useRef:(initial:unknown)=>accountRef??(accountRef={current:initial})};
        return {...react,default:react};
      }
      if(spec==='react-dom/client')return {default:{createRoot:()=>({render:(element:any)=>{rendered=element;}})}};
      if(spec==='react-router-dom')return {BrowserRouter:'router'};
      if(spec==='./App')return {default:'App'};
      if(spec.endsWith('.css'))return {};
      throw new Error(`unexpected client import ${spec}`);
    };
    vm.runInContext(`(function(require,exports){${code}\n})`,realm,{filename:name})(require,exports);
    return exports;
  };
  const auth=load('lib/telegram.ts'),api=load('lib/api.ts').api;
  return {auth,api,load,window,calls,sockets,timers,storage,sandbox,
    switchTo:(next:number|null)=>{window.Telegram.WebApp.initData=next?signed(next):'';auth.captureAuthContext();},
    fire:(delay:number)=>{for(const [key,timer]of [...timers])if(timer.delay===delay){if(!timer.interval)timers.delete(key);timer.fn();}},
    boundary:()=>rendered.children[0].children[0].type(),
  };
}
async function run(name:string,test:()=>Promise<void>|void){await test();passed++;console.log('PASS '+name);}
function token(headers:any){return headers['X-Session-Token'];}
function bootCount(b:ReturnType<typeof browser>){return b.calls.filter(c=>c.url.endsWith('/bootstrap')).length;}

try {
  await initDb();await ensurePlayer(`tg_${A}`,'A');await ensurePlayer(`tg_${B}`,'B');
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${(server.address() as any).port}`;
  await run('A reload/reopen reuses its verified token even with old initData',async()=>{
    const a=browser();const first=await a.auth.getIdentityHeaders();
    const reload=browser(A,a.storage);reload.window.Telegram.WebApp.initData=signed(A,3600);
    assert.equal(token(await reload.auth.getIdentityHeaders()),token(first));assert.equal(bootCount(reload),0);
    assert.equal(reload.calls.filter(c=>c.url.endsWith('/session')).length,1);
    assert.equal((await reload.api.getPortfolio()).username,'A');
  });
  await run('A -> B -> A never uses another owner token for REST or WS',async()=>{
    const b=browser();const ta=token(await b.auth.getIdentityHeaders());b.switchTo(B);
    const tb=token(await b.auth.getIdentityHeaders());assert.notEqual(ta,tb);
    assert.equal((await b.auth.getIdentityForWs()).sessionToken,tb);assert.equal((await b.api.getPortfolio()).username,'B');
    b.switchTo(A);assert.notEqual(token(await b.auth.getIdentityHeaders()),tb);assert.equal((await b.api.getPortfolio()).username,'A');
    assert.equal(bootCount(b),3);
  });
  await run('legacy unowned tokens and forged owner metadata cannot authorize gameplay',async()=>{
    const a=browser();const ta=token(await a.auth.getIdentityHeaders());
    const legacy=browser(B,new Map([['crypto_sim_session_token',ta]]));
    assert.equal((await legacy.api.getPortfolio()).username,'B');assert.equal(bootCount(legacy),1);
    assert.ok(!legacy.calls.some(c=>c.options.headers?.['X-Session-Token']===ta));
    const forged=browser(B,new Map([[sessionKey,JSON.stringify({telegramUserId:String(B),token:ta})]]));
    assert.equal((await forged.api.getPortfolio()).username,'B');
    assert.ok(forged.calls.filter(c=>c.options.headers?.['X-Session-Token']===ta).every(c=>c.url.endsWith('/auth/session')));
  });
  await run('late bootstrap A cannot overwrite B or resolve a B request as A',async()=>{
    const started=deferred<void>(),finish=deferred<void>();
    const b=browser(A,new Map(),false,async(url,options,next)=>{
      const response=await next();
      if(url.endsWith('/bootstrap')&&new URLSearchParams(JSON.parse(options.body).initData).get('user')?.includes(String(A))){started.resolve();await finish.promise;}
      return response;
    });
    const old=b.auth.getIdentityHeaders();const rejected=assert.rejects(old);await started.promise;
    b.switchTo(B);const current=await b.auth.getIdentityHeaders();finish.resolve();await rejected;
    assert.equal(token(await b.auth.getIdentityHeaders()),token(current));assert.equal(JSON.parse(b.storage.get(sessionKey)!).telegramUserId,String(B));
  });
  await run('failed bootstrap B cannot fall back to cached A',async()=>{
    const b=browser(A,new Map(),false,async(url,options,next)=>{
      if(url.endsWith('/bootstrap')&&JSON.parse(options.body).initData.includes(String(B)))return new Response('{}',{status:403});
      return next();
    });
    const a=token(await b.auth.getIdentityHeaders());b.calls.length=0;b.switchTo(B);
    await assert.rejects(b.api.getPortfolio());await assert.rejects(b.auth.getIdentityForWs());
    assert.ok(!b.calls.some(c=>c.options.headers?.['X-Session-Token']===a));
    assert.ok(!b.calls.some(c=>c.url.endsWith('/portfolio')));
  });
  await run('late REST body A is discarded after switching to B',async()=>{
    const started=deferred<void>(),finish=deferred<void>();
    const b=browser(A,new Map(),false,async(url,_opts,next)=>{
      const response=await next();
      if(url.endsWith('/portfolio'))return {ok:true,status:200,json:async()=>{started.resolve();await finish.promise;return response.json();}} as Response;
      return response;
    });
    const old=b.api.getPortfolio();const rejected=assert.rejects(old);await started.promise;b.switchTo(B);finish.resolve();await rejected;
  });
  await run('401 on action A never retries that action with credentials B',async()=>{
    const started=deferred<void>(),finish=deferred<void>();
    const b=browser(A,new Map(),false,async(url,_opts,next)=>{
      if(url.endsWith('/trade')){started.resolve();await finish.promise;return new Response('{}',{status:401});}return next();
    });
    const old=b.api.trade({coinId:'btcr',side:'buy',amountUsdd:10});const rejected=assert.rejects(old);
    await started.promise;b.switchTo(B);finish.resolve();await rejected;
    assert.equal(b.calls.filter(c=>c.url.endsWith('/trade')).length,1);assert.equal(bootCount(b),1);
  });
  await run('same-owner 401 refresh is bounded and keeps the same identity',async()=>{
    const b=browser();const first=token(await b.auth.getIdentityHeaders());await revokeAuthSession(first);
    assert.equal((await b.api.getPortfolio()).username,'A');assert.equal(bootCount(b),2);
    assert.equal(b.calls.filter(c=>c.url.endsWith('/portfolio')).length,2);
  });
  await run('WS switch closes A, rejects stale frames, clears only personal cache and reconnects as B',async()=>{
    const b=browser();const ws=b.load('lib/wsStore.ts');ws.ensureWsStarted();await until(()=>b.sockets.length===1);
    const a=b.sockets[0];a.open();const ta=a.sent[0].sessionToken;
    a.frame('price_updates',{coins:[{id:'btcr',price:1,changePct:0}],marketStatus:{}});a.frame('portfolio_updates',{username:'A'});
    a.close();assert.ok([...b.timers.values()].some(t=>t.delay===1500));
    b.switchTo(B);assert.equal(ws.getSnapshot().portfolio,null);assert.equal(ws.getSnapshot().prices.btcr.price,1);
    a.frame('portfolio_updates',{username:'A'});assert.equal(ws.getSnapshot().portfolio,null);
    b.fire(1500);await until(()=>b.sockets.length===2);const next=b.sockets[1];next.open();
    assert.notEqual(next.sent[0].sessionToken,ta);next.frame('portfolio_updates',{username:'B'});assert.equal(ws.getSnapshot().portfolio.username,'B');
    a.frame('auth_error',{});assert.equal(JSON.parse(b.storage.get(sessionKey)!).token,next.sent[0].sessionToken);
    next.close();b.fire(1500);await until(()=>b.sockets.length===3);b.sockets[2].open();
    assert.equal(b.sockets[2].sent[0].sessionToken,next.sent[0].sessionToken);
    b.switchTo(A);assert.equal(b.sockets[2].readyState,3);a.frame('portfolio_updates',{username:'A-old'});assert.equal(ws.getSnapshot().portfolio,null);
  });
  await run('WS awaiting bootstrap A cannot connect after B becomes current',async()=>{
    const started=deferred<void>(),finish=deferred<void>();
    const b=browser(A,new Map(),false,async(url,options,next)=>{
      const response=await next();
      if(url.endsWith('/bootstrap')&&JSON.parse(options.body).initData.includes(String(A))){started.resolve();await finish.promise;}
      return response;
    });
    const ws=b.load('lib/wsStore.ts');ws.ensureWsStarted();await started.promise;
    b.switchTo(B);await until(()=>b.sockets.length===1);b.sockets[0].open();
    assert.equal(b.sockets[0].sent[0].sessionToken,token(await b.auth.getIdentityHeaders()));
    finish.resolve();await new Promise(r=>setTimeout(r,20));assert.equal(b.sockets.length,1);
  });
  await run('lifecycle monitoring detects identity changes without a manual auth reset',async()=>{
    const b=browser();const stop=b.auth.initTelegram();const ws=b.load('lib/wsStore.ts');ws.ensureWsStarted();
    await until(()=>b.sockets.length===1);b.sockets[0].open();b.sockets[0].frame('portfolio_updates',{username:'A'});
    b.window.Telegram.WebApp.initData=signed(B);b.fire(250);
    assert.equal(b.sockets[0].readyState,3);assert.equal(ws.getSnapshot().portfolio,null);
    assert.equal((await b.api.getPortfolio()).username,'B');stop();
  });
  await run('screen state remounts by identity generation, including lost identity',async()=>{
    const b=browser();b.load('main.tsx');await b.auth.getIdentityHeaders();const first=b.boundary();assert.equal(first.type,'App');
    b.switchTo(B);assert.notEqual(b.boundary().type,'App');await b.auth.getIdentityHeaders();assert.notEqual(b.boundary().props.key,first.props.key);
    b.switchTo(null);assert.notEqual(b.boundary().type,'App');
  });
  await run('synchronous A -> B and B -> A guards reject all old personal state without polling',async()=>{
    for(const [from,to] of [[A,B],[B,A]]) for(const firstRead of ['auth','portfolio','render','screen','rest']) {
      const b=browser(from);b.load('main.tsx');const oldToken=token(await b.auth.getIdentityHeaders());
      const guard=b.load('hooks/useAccountGuard.ts').useAccountGuard;
      assert.equal(guard(),true);const oldKey=b.boundary().props.key;
      const ws=b.load('lib/wsStore.ts');ws.ensureWsStarted();await until(()=>b.sockets.length===1);
      const oldSocket=b.sockets[0];oldSocket.open();oldSocket.frame('portfolio_updates',{username:String(from),usddBalance:777});
      oldSocket.frame('price_updates',{coins:[{id:'btcr',price:42}],marketStatus:{}});
      const callStart=b.calls.length;
      // No captureAuthContext(), events or timer between host change and reads.
      b.window.Telegram.WebApp.initData=signed(to);
      let request:Promise<any>|undefined;
      if(firstRead==='auth')assert.equal(b.auth.getAuthSnapshot().identity.id,String(to));
      if(firstRead==='portfolio')assert.equal(ws.getSnapshot().portfolio,null);
      if(firstRead==='render')assert.notEqual(b.boundary().type,'App');
      if(firstRead==='screen')assert.equal(guard(),false);
      if(firstRead==='rest')request=b.api.getPortfolio();
      assert.equal(b.auth.getAuthSnapshot().identity.id,String(to));
      assert.equal(b.auth.getAuthSnapshot().authenticated,false);
      assert.equal(ws.getSnapshot().portfolio,null);assert.equal(ws.getSnapshot().prices.btcr.price,42);
      assert.notEqual(b.boundary().type,'App');assert.equal(guard(),false);assert.equal(oldSocket.readyState,3);
      oldSocket.frame('portfolio_updates',{username:String(from),usddBalance:777});assert.equal(ws.getSnapshot().portfolio,null);
      const portfolio=await (request??b.api.getPortfolio());assert.equal(portfolio.username,to===A?'A':'B');
      assert.ok(b.calls.slice(callStart).every(c=>c.options.headers?.['X-Session-Token']!==oldToken));
      assert.equal(b.boundary().type,'App');assert.notEqual(b.boundary().props.key,oldKey);
      assert.equal(guard(),false); // An old mounted screen cannot use its local A state even after B authenticates.
      await until(()=>b.sockets.length===2);b.sockets[1].open();
      b.sockets[1].frame('portfolio_updates',{username:String(to),usddBalance:888});
      assert.equal(ws.getSnapshot().portfolio.username,String(to));
      assert.equal(ws.getSnapshot().portfolio.usddBalance,888);
      assert.strictEqual(b.auth.getAuthSnapshot(),b.auth.getAuthSnapshot());
    }
  });
  await run('missing/malformed identity never sends a cached Telegram token; dev remains separate',async()=>{
    const a=browser();await a.auth.getIdentityHeaders();const b=browser(null,a.storage);await assert.rejects(b.auth.getIdentityHeaders());assert.equal(b.calls.length,0);
    b.window.Telegram.WebApp.initData='user=invalid';await assert.rejects(b.auth.getIdentityHeaders());assert.equal(b.calls.length,0);
    const dev=browser(null,a.storage,true);assert.ok((await dev.auth.getIdentityHeaders())['X-Dev-Player-Id'].startsWith('dev_'));assert.equal(dev.calls.length,0);
  });
  await run('blocked sessionStorage supports memory-only login and safe switching',async()=>{
    const b=browser();for(const key of ['getItem','setItem','removeItem'])b.sandbox.sessionStorage[key]=()=>{throw new Error('blocked');};
    const a=token(await b.auth.getIdentityHeaders());assert.equal(token(await b.auth.getIdentityHeaders()),a);
    b.switchTo(B);assert.notEqual(token(await b.auth.getIdentityHeaders()),a);assert.equal((await b.api.getPortfolio()).username,'B');
  });
  await run('B BUY/SELL, reward, staking and bot actions only mutate B, with real HTTP and WS ownership',async()=>{
    await db.query('UPDATE players SET usdd_balance=1000 WHERE id IN ($1,$2)',[`tg_${A}`,`tg_${B}`]);
    const b=browser();await b.auth.getIdentityHeaders();b.switchTo(B);
    const beforeA=JSON.stringify(await getPlayer(`tg_${A}`));
    await b.api.trade({coinId:'btcr',side:'buy',amountUsdd:100});assert.equal((await getPlayer(`tg_${B}`)).usdd_balance,900);
    const holding=(await getHolding(`tg_${B}`,'btcr'))!.amount;
    await b.api.trade({coinId:'btcr',side:'sell',amountCoin:holding/4});
    const balance=(await getPlayer(`tg_${B}`)).usdd_balance;const claim=await b.api.claimQuest('daily_bonus');
    assert.equal((await getPlayer(`tg_${B}`)).usdd_balance,balance+claim.amount);
    const stake=await b.api.stake('btcr',holding/4);assert.equal(stake.position.player_id,`tg_${B}`);
    await b.api.configureBot('btcr','buy',60000,10);await b.api.toggleBot(true);
    assert.equal((await getTradingBot(`tg_${B}`))!.enabled,true);assert.equal(await getTradingBot(`tg_${A}`),null);
    assert.equal(JSON.stringify(await getPlayer(`tg_${A}`)),beforeA);assert.equal(await getHolding(`tg_${A}`,'btcr'),null);
    const socket=new WebSocket(base.replace('http','ws')+'/ws');const messages:any[]=[];socket.on('message',m=>messages.push(JSON.parse(String(m))));
    try {
      await new Promise<void>(r=>socket.once('open',r));socket.send(JSON.stringify({type:'auth',...await b.auth.getIdentityForWs()}));
      await until(()=>hub.getConnectedPlayerIds().has(`tg_${B}`));assert.ok(!hub.getConnectedPlayerIds().has(`tg_${A}`));
      await hub.sendToPlayer(`tg_${A}`,'portfolio_updates',{username:'A'});await hub.sendToPlayer(`tg_${B}`,'portfolio_updates',{username:'B'});
      await until(()=>messages.some(m=>m.type==='portfolio_updates'));assert.ok(messages.filter(m=>m.type==='portfolio_updates').every(m=>m.payload.username==='B'));
    } finally {socket.terminate();}
  });
  console.log(`ACCOUNT ISOLATION TESTS: ${passed} passed`);
} finally {for(const ws of hub.wss.clients)ws.terminate();await new Promise<void>(r=>hub.wss.close(()=>r()));await new Promise<void>(r=>server.close(()=>r()));await db.close();}
