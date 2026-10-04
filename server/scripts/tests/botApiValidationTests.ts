import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import express from 'express';

process.env.NODE_ENV = 'production';
process.env.PGDATA_DIR = process.argv[3] ?? 'memory://';
const mode = process.argv[2] ?? 'main';
const { db, initDb } = await import('../../src/db/index.js');
const q = await import('../../src/db/queries.js');
const { createAuthSession } = await import('../../src/auth/sessions.js');
const { createRouter } = await import('../../src/api/routes.js');
const { createInitialState } = await import('../../src/engine/state.js');
const { runTradingBots } = await import('../../src/engine/tradingBot.js');
const { COINS } = await import('../../src/config/coins.js');
const { BOT_CONFIG_INTERVALS_MS } = await import('../../src/config/tradingBot.js');
const state = createInitialState();
const app = express(); app.use(express.json()); app.use('/api', createRouter(state));
// No unhandledRejection/uncaughtException suppression, including child processes.
const server = createServer(app);
const valid = { coinId: 'btcr', side: 'buy', intervalMs: 1000, amount: 10 };
let token: string, checked = 0;
async function request(route: string, body: unknown, auth = true, raw = false) {
  const response = await fetch(`http://127.0.0.1:${(server.address() as any).port}/api/bot${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { 'X-Session-Token': token } : {}) },
    body: raw ? body as string : JSON.stringify(body), signal: AbortSignal.timeout(10000),
  });
  await response.text(); return response.status;
}
async function reject(route: string, body: unknown, raw = false) {
  const before = await q.getTradingBot('A');
  assert.equal(await request(route, body, true, raw), 400, JSON.stringify(body));
  assert.deepEqual(await q.getTradingBot('A'), before); checked++;
}
function child(stage: string, dir?: string) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', process.argv[1], stage, ...(dir ? [dir] : [])], { encoding: 'utf8', timeout: 120000 });
  assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
  console.log(result.stdout.trim());
}
try {
  await initDb();
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  await q.ensurePlayer('A', 'A'); await q.ensurePlayer('B', 'B');
  token = (await createAuthSession('A')).sessionToken;
  if (mode === 'resume') {
    const saved = await q.getTradingBot('A');
    assert.equal(saved?.coin_id, 'btcr'); assert.equal(saved?.interval_ms, 3000); assert.equal(saved?.amount, 12.5); assert.equal(saved?.enabled, true);
    const before = await db.query('SELECT * FROM players ORDER BY id');
    const botsBefore = await db.query('SELECT * FROM trading_bots ORDER BY player_id');
    for (let i = 0; i < 10; i++) await runTradingBots(state);
    assert.deepEqual(await db.query('SELECT * FROM players ORDER BY id'), before);
    assert.deepEqual(await db.query('SELECT * FROM trading_bots ORDER BY player_id'), botsBefore);
    for (const row of botsBefore.rows as any[]) {
      if (!row.player_id.startsWith('legacy')) continue;
      token = (await createAuthSession(row.player_id)).sessionToken;
      assert.equal(await request('/toggle', { enabled: false }), 200);
      assert.equal(await request('/config', valid), 200);
      const fixed = await q.getTradingBot(row.player_id);
      assert.equal(fixed?.amount, 10); assert.equal(fixed?.coin_id, 'btcr');
    }
    console.log('PASS durable restart, corrupted rows skipped without mutations and replaceable by HTTP');
  } else {
    await q.configureTradingBot('A', 'btcr', 'buy', 60000, 10);
    if (mode === 'crash') {
      for (const intervalMs of ['not-a-number', 'NaN', 'Infinity', '1e309', {}, 1000.5, 1e20, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1]) await reject('/config', { ...valid, intervalMs });
      for (const coinId of [['btcr'], { toString: null }]) await reject('/config', { ...valid, coinId });
      console.log(`PASS child crash regressions: ${checked} requests, server alive`);
    } else if (mode === 'seed') {
      assert.equal(await request('/config', { ...valid, intervalMs: 3000, amount: 12.5 }), 200);
      assert.equal(await request('/toggle', { enabled: true }), 200);
      await db.query("UPDATE trading_bots SET next_run_at=now()+interval '1 day' WHERE player_id='A'");
      for (const [i, amount, coin, interval] of [[0, NaN, 'btcr', 1000], [1, Infinity, 'btcr', 1000], [2, 10, '__proto__', 1000], [3, 10, 'constructor', 1000], [4, 10, 'unknown', 1000], [5, 10, 'btcr', 0], [6, 10, 'btcr', Number.MAX_SAFE_INTEGER]] as const) {
        const id = `legacy-${i}`; await q.ensurePlayer(id, id); await q.configureTradingBot(id, 'btcr', 'buy', 1000, 10);
        await db.query("UPDATE trading_bots SET amount=$2,coin_id=$3,interval_ms=$4,enabled=TRUE,next_run_at=now()-interval '1 day' WHERE player_id=$1", [id, amount, coin, interval]);
      }
      console.log('PASS restart fixture saved');
    } else {
      const bad = [undefined, null, true, false, '', ' ', '1000', 'NaN', 'Infinity', '1e309', [], [1000], {}, { toString: null }, -1, 0];
      for (const field of ['coinId', 'side', 'amount', 'intervalMs']) for (const value of bad) await reject('/config', { ...valid, [field]: value });
      for (const coinId of ['unknown', '__proto__', 'constructor', ['btcr']]) await reject('/config', { ...valid, coinId });
      for (const intervalMs of [999, 1000.5, 2000, 1001, 60001, 2147483648, 1e20, Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1]) await reject('/config', { ...valid, intervalMs });
      for (const field of ['amount', 'intervalMs']) for (const literal of ['1e309', '-1e309']) await reject('/config', `{"coinId":"btcr","side":"buy","intervalMs":1000,"amount":10,"${field}":${literal}}`, true);
      for (const body of [null, [], true, 'config', 1]) await reject('/config', body);
      for (const value of [...bad.filter(v => typeof v !== 'boolean'), 'false', 'true', 1]) await reject('/toggle', { enabled: value });
      for (const body of [null, [], true, 'toggle', 1]) await reject('/toggle', body);
      // Keep API whitelist synchronized with actual UI presets.
      const ui = readFileSync(new URL('../../../client/src/screens/CoinDetailScreen.tsx', import.meta.url), 'utf8');
      const presets = ui.match(/BOT_INTERVAL_PRESETS_SEC = \[([^\]]+)\]/)![1].split(',').map(s => Number(s.trim()) * 1000);
      assert.deepEqual(BOT_CONFIG_INTERVALS_MS, presets);
      for (const intervalMs of BOT_CONFIG_INTERVALS_MS) for (const coin of COINS) for (const side of ['buy', 'sell']) assert.equal(await request('/config', { ...valid, coinId: coin.id, side, intervalMs, amount: 0.5 }), 200);
      for (const enabled of [true, false, true]) { assert.equal(await request('/toggle', { enabled }), 200); assert.equal((await q.getTradingBot('A'))?.enabled, enabled); }
      await reject('/toggle', { enabled: 'false' });
      assert.equal(await request('/toggle', { enabled: false }), 200);
      await q.configureTradingBot('B', 'btcr', 'sell', 3000, 20); const other = await q.getTradingBot('B');
      assert.equal(await request('/config', { ...valid, playerId: 'B', player_id: 'B' }), 200);
      assert.equal(await request('/toggle', { enabled: false, playerId: 'B', player_id: 'B' }), 200);
      assert.deepEqual(await q.getTradingBot('B'), other);
      assert.equal(await request('/config', valid, false), 401); assert.equal(await request('/toggle', { enabled: true }, false), 401);
      const rawQuery = db.query.bind(db); const before = await q.getTradingBot('A');
      try {
        db.query = (async (sql: string, ...args: any[]) => { if (sql.includes('trading_bots')) throw Error('injected internal DB failure'); return (rawQuery as any)(sql, ...args); }) as typeof db.query;
        assert.equal(await request('/config', valid), 500); assert.equal(await request('/toggle', { enabled: true }), 500);
        const r = await fetch(`http://127.0.0.1:${(server.address() as any).port}/api/bot`, { headers: { 'X-Session-Token': token } }); assert.equal(r.status, 500); await r.text();
      } finally { db.query = rawQuery; }
      assert.deepEqual(await q.getTradingBot('A'), before); assert.equal(await request('/config', valid), 200);
      console.log(`PASS ${checked} rejected requests preserve complete bot row; whitelist/all coins/sides, ownership, controlled 500 and recovery`);
      child('crash');
      const dir = mkdtempSync(path.join(tmpdir(), 'bot-api-validation-'));
      try { child('seed', dir); child('resume', dir); } finally { rmSync(dir, { recursive: true, force: true }); }
      console.log('BOT API VALIDATION TESTS PASSED');
    }
  }
} finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await db.close(); }
