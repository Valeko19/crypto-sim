import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import express from 'express';
import { WebSocket } from 'ws';

const originalPgDataDir = process.env.PGDATA_DIR;
const originalNodeEnv = process.env.NODE_ENV;
const originalBotToken = process.env.TELEGRAM_BOT_TOKEN;
const originalBetaAllowlist = process.env.BETA_ALLOWLIST;
const dataDir = mkdtempSync(path.join(tmpdir(), 'crypto-sim-auth-tests-'));
process.env.PGDATA_DIR = dataDir;
process.env.NODE_ENV = 'test';
process.env.TELEGRAM_BOT_TOKEN = 'auth-session-test-token';
delete process.env.BETA_ALLOWLIST;

const { db, initDb } = await import('../../src/db/index.js');
const { validateInitData } = await import('../../src/auth/telegram.js');
const { createAuthSession, resolveAuthSession, revokeAuthSession } = await import('../../src/auth/sessions.js');
const { createAuthRouter } = await import('../../src/api/authRoutes.js');
const { createRouter } = await import('../../src/api/routes.js');
const { createInitialState } = await import('../../src/engine/state.js');
const { createWsServer } = await import('../../src/ws/server.js');

const botToken = process.env.TELEGRAM_BOT_TOKEN!;
const results: string[] = [];
let server: Server | null = null;
let wsServer: ReturnType<typeof createWsServer> | null = null;

function signInitData(authDate: number, hashOverride?: string): string {
  const params = new URLSearchParams({
    auth_date: String(authDate),
    user: JSON.stringify({ id: 123456789, username: 'auth_review' }),
  });
  const checkString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = createHmac('sha256', secretKey).update(checkString).digest('hex');
  params.set('hash', hashOverride ?? hash);
  return params.toString();
}

async function request(pathname: string, options: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) {
  const response = await fetch(`http://127.0.0.1:${server!.address()!.port}${pathname}`, {
    method: options.method ?? 'GET',
    headers: { ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...options.headers },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function run(name: string, test: () => Promise<void>): Promise<void> {
  await test();
  results.push(name);
  console.log(`PASS ${name}`);
}

async function connectWs(sessionToken: string): Promise<{ socket: WebSocket; probe: Promise<void> }> {
  const socket = new WebSocket(`ws://127.0.0.1:${server!.address()!.port}/ws`);
  const probe = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('WebSocket session probe timed out')), 5_000);
    socket.on('open', () => socket.send(JSON.stringify({ type: 'auth', sessionToken })));
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'auth_error') {
        clearTimeout(timeout);
        reject(new Error('WebSocket session rejected'));
      } else if (message.type === 'session_probe') {
        clearTimeout(timeout);
        resolve();
      }
    });
    socket.on('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
  });
  return { socket, probe };
}

async function main(): Promise<void> {
  await initDb();
  const app = express();
  app.use(express.json());
  app.use('/api/auth', createAuthRouter());
  app.use('/api', createRouter(createInitialState()));
  server = createServer(app);
  wsServer = createWsServer(server);
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));

  await run('fresh initData validates and bootstraps a session', async () => {
    const now = Date.now();
    const initData = signInitData(Math.floor(now / 1000));
    assert.equal(validateInitData(initData, now)?.playerId, 'tg_123456789');
    const bootstrap = await request('/api/auth/bootstrap', { method: 'POST', body: { initData } });
    assert.equal(bootstrap.status, 200);
    const sessionToken = bootstrap.body.sessionToken as string;
    assert.match(sessionToken, /^[A-Za-z0-9_-]{43}$/);
    const stored = await db.query<{ token_hash: string; player_id: string }>(
      'SELECT token_hash, player_id FROM auth_sessions WHERE player_id = $1', ['tg_123456789']
    );
    assert.equal(stored.rows.length, 1);
    assert.equal(stored.rows[0].player_id, 'tg_123456789');
    assert.notEqual(stored.rows[0].token_hash, sessionToken);
    const portfolio = await request('/api/portfolio', { headers: { 'X-Session-Token': sessionToken } });
    assert.equal(portfolio.status, 200);
    const rawInitDataRequest = await request('/api/portfolio', { headers: { 'X-Telegram-Init-Data': initData } });
    assert.equal(rawInitDataRequest.status, 401);
  });

  await run('old, future and malformed initData are rejected', async () => {
    const now = Date.now();
    const old = signInitData(Math.floor(now / 1000) - 301);
    const future = signInitData(Math.floor(now / 1000) + 61);
    const malformed = signInitData(Math.floor(now / 1000), 'not-a-valid-hash');
    assert.equal(validateInitData(old, now), null);
    assert.equal(validateInitData(future, now), null);
    assert.equal(validateInitData(malformed, now), null);
    for (const initData of [old, future, malformed]) {
      assert.equal((await request('/api/auth/bootstrap', { method: 'POST', body: { initData } })).status, 401);
    }
    assert.equal((await request('/api/auth/bootstrap', { method: 'POST', body: {} })).status, 400);
  });

  await run('session activity slides idle expiry but never absolute expiry', async () => {
    const playerId = 'tg_123456789';
    const createdAt = Date.now();
    const { sessionToken } = await createAuthSession(playerId, createdAt);
    const tokenHash = createHash('sha256').update(sessionToken).digest('hex');
    const before = await db.query<{ idle_expires_at: Date; absolute_expires_at: Date }>(
      'SELECT idle_expires_at, absolute_expires_at FROM auth_sessions WHERE player_id = $1 AND token_hash = $2',
      [playerId, tokenHash]
    );
    const originalAbsolute = new Date(before.rows[0].absolute_expires_at).getTime();
    const activityAt = createdAt + 30 * 60 * 1000;
    assert.ok(await resolveAuthSession(sessionToken, activityAt));
    const after = await db.query<{ idle_expires_at: Date; absolute_expires_at: Date }>(
      'SELECT idle_expires_at, absolute_expires_at FROM auth_sessions WHERE token_hash = $1',
      [tokenHash]
    );
    assert.equal(new Date(after.rows[0].idle_expires_at).getTime(), activityAt + 12 * 60 * 60 * 1000);
    assert.equal(new Date(after.rows[0].absolute_expires_at).getTime(), originalAbsolute);
  });

  await run('idle, absolute, revoked and unknown sessions are rejected', async () => {
    const playerId = 'tg_123456789';
    const now = Date.now();
    const idle = await createAuthSession(playerId, now - 13 * 60 * 60 * 1000);
    assert.equal(await resolveAuthSession(idle.sessionToken, now), null);

    const absolute = await createAuthSession(playerId, now);
    const { createHash } = await import('node:crypto');
    const absoluteHash = createHash('sha256').update(absolute.sessionToken).digest('hex');
    await db.query('UPDATE auth_sessions SET absolute_expires_at = $2 WHERE token_hash = $1', [absoluteHash, new Date(now - 1)]);
    assert.equal(await resolveAuthSession(absolute.sessionToken, now), null);

    const revoked = await createAuthSession(playerId, now);
    assert.equal(await revokeAuthSession(revoked.sessionToken, now), true);
    assert.equal(await resolveAuthSession(revoked.sessionToken, now), null);
    assert.equal(await resolveAuthSession('A'.repeat(43), now), null);
    assert.equal(await resolveAuthSession('malformed', now), null);
  });

  await run('dev identity flow remains available outside production', async () => {
    const portfolio = await request('/api/portfolio', { headers: { 'X-Dev-Player-Id': 'dev_auth_test' } });
    assert.equal(portfolio.status, 200);
  });

  await run('WebSocket authenticates using a session token', async () => {
    const { sessionToken } = await createAuthSession('tg_123456789');
    const { socket, probe } = await connectWs(sessionToken);
    const interval = setInterval(() => wsServer!.sendToPlayer('tg_123456789', 'session_probe', {}), 10);
    try {
      await probe;
    } finally {
      clearInterval(interval);
      socket.close();
    }
  });

  console.log(`AUTH SESSION TESTS: ${results.length} passed`);
}

try {
  await main();
} catch (error) {
  console.error('AUTH SESSION TEST FAILURE', error);
  process.exitCode = 1;
} finally {
  if (server?.listening) await new Promise<void>(resolve => server!.close(() => resolve()));
  await db.close();
  if (originalPgDataDir === undefined) delete process.env.PGDATA_DIR;
  else process.env.PGDATA_DIR = originalPgDataDir;
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  if (originalBotToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = originalBotToken;
  if (originalBetaAllowlist === undefined) delete process.env.BETA_ALLOWLIST;
  else process.env.BETA_ALLOWLIST = originalBetaAllowlist;
  rmSync(dataDir, { recursive: true, force: true });
}