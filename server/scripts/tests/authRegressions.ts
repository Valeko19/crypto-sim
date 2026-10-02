import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { WebSocket } from 'ws';
import type { db as database } from '../../src/db/index.js';
import type { createWsServer } from '../../src/ws/server.js';

export async function runAuthRegressions({ db, wsServer, run, signInitData }: {
  db: typeof database;
  wsServer: ReturnType<typeof createWsServer>;
  run: (name: string, test: () => Promise<void>) => Promise<void>;
  signInitData: (authDate: number, hashOverride?: string) => string;
}) {
  // Import after the runner configures the isolated test environment.
  const { createAuthSession, resolveAuthSession, isAuthSessionValid } = await import('../../src/auth/sessions.js');
  const { validateInitData } = await import('../../src/auth/telegram.js');
  const digest = (token: string) => createHash('sha256').update(token).digest('hex');
  const hour = 60 * 60 * 1000;

  async function sessionTimes(token: string) {
    const result = await db.query<{ idle_expires_at: Date; absolute_expires_at: Date; last_activity_at: Date }>(
      'SELECT idle_expires_at, absolute_expires_at, last_activity_at FROM auth_sessions WHERE token_hash = $1', [digest(token)]
    );
    return Object.fromEntries(Object.entries(result.rows[0]).map(([key, value]) => [key, new Date(value).getTime()]));
  }

  // Run actual server listeners with deterministic ordering, and track every
  // interval (including ones whose references might otherwise be overwritten).
  // The main test suite separately covers a real network WebSocket connection.
  async function withSocket(test: (socket: WebSocket, frames: { type: string }[], message: (body: unknown) => Promise<void>, timers: Set<ReturnType<typeof setInterval>>) => Promise<void>) {
    const frames: { type: string }[] = [];
    const socket = Object.assign(new EventEmitter(), {
      readyState: WebSocket.OPEN as number,
      send(raw: string) { frames.push(JSON.parse(raw)); },
      close() { this.readyState = WebSocket.CLOSED; this.emit('close'); },
    }) as unknown as WebSocket;
    const timers = new Set<ReturnType<typeof setInterval>>();
    const originalSet = globalThis.setInterval;
    const originalClear = globalThis.clearInterval;
    globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
      const timer = originalSet(...args);
      timers.add(timer);
      return timer;
    }) as typeof setInterval;
    globalThis.clearInterval = ((timer: ReturnType<typeof setInterval>) => {
      timers.delete(timer);
      originalClear(timer);
    }) as typeof clearInterval;
    wsServer.wss.clients.add(socket);
    wsServer.wss.emit('connection', socket);
    const handler = socket.listeners('message')[0];
    try {
      await test(socket, frames, body => handler(Buffer.from(JSON.stringify(body))), timers);
    } finally {
      socket.close();
      wsServer.wss.clients.delete(socket);
      for (const timer of timers) originalClear(timer);
      globalThis.setInterval = originalSet;
      globalThis.clearInterval = originalClear;
    }
  }

  await run('forged well-formed HMAC and auth_date boundaries', async () => {
    const seconds = Math.floor(Date.now() / 1000);
    const now = seconds * 1000;
    const forged = new URLSearchParams(signInitData(seconds));
    const hash = forged.get('hash')!;
    forged.set('hash', (hash[0] === '0' ? '1' : '0') + hash.slice(1));
    assert.equal(validateInitData(forged.toString(), now), null);
    for (const offset of [-300, 60]) assert.ok(validateInitData(signInitData(seconds + offset), now));
    for (const offset of [-301, 61]) assert.equal(validateInitData(signInitData(seconds + offset), now), null);
  });

  await run('exact idle and absolute TTL boundaries, including continuous activity', async () => {
    const start = Date.now();
    const idle = await createAuthSession('tg_123456789', start);
    assert.equal(Date.parse(idle.idleExpiresAt), start + 12 * hour);
    assert.equal(Date.parse(idle.absoluteExpiresAt), start + 7 * 24 * hour);
    assert.equal(await isAuthSessionValid(idle.sessionToken, start + 12 * hour - 1), true);
    assert.equal(await isAuthSessionValid(idle.sessionToken, start + 12 * hour), false);
    assert.equal(await resolveAuthSession(idle.sessionToken, start + 12 * hour), null);
    assert.equal(await resolveAuthSession(idle.sessionToken, start + 12 * hour + 1), null);
    const active = await createAuthSession('tg_123456789', start);
    const end = start + 7 * 24 * hour;
    for (let at = start + 6 * hour; at < end; at += 6 * hour) {
      assert.ok(await resolveAuthSession(active.sessionToken, at));
      assert.equal((await sessionTimes(active.sessionToken)).absolute_expires_at, end);
    }
    assert.ok(await resolveAuthSession(active.sessionToken, end - 1));
    assert.equal((await sessionTimes(active.sessionToken)).idle_expires_at, end);
    assert.equal(await isAuthSessionValid(active.sessionToken, end), false);
    assert.equal(await resolveAuthSession(active.sessionToken, end), null);
    assert.equal(await resolveAuthSession(active.sessionToken, end + 1), null);
  });

  await run('production rejects dev auth without explicit override', async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production' };
    delete env.ALLOW_DEV_AUTH;
    const moduleUrl = new URL('../../src/auth/telegram.ts', import.meta.url).href;
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      const { DEV_AUTH_ALLOWED, resolveIdentity } = await import(${JSON.stringify(moduleUrl)});
      assert.equal(DEV_AUTH_ALLOWED, false);
      assert.equal(resolveIdentity(undefined, 'dev_auth_test'), null);
      assert.equal(resolveIdentity(undefined, 'tg_123456789'), null);
    `], { env, encoding: 'utf8', timeout: 15_000 });
    assert.equal(result.status, 0, result.stderr || String(result.error));
  });

  await run('concurrent auth messages authorize once and leave no timers on close', async () => {
    const { sessionToken } = await createAuthSession('tg_123456789');
    await withSocket(async (socket, frames, message, timers) => {
      const originalQuery = db.query;
      let validations = 0;
      db.query = (async (...args: Parameters<typeof db.query>) => {
        if (String(args[0]).includes('UPDATE auth_sessions')) validations++;
        return originalQuery.apply(db, args);
      }) as typeof db.query;
      try {
        await Promise.all(Array.from({ length: 10 }, () => message({ type: 'auth', sessionToken })));
        assert.equal(validations, 1);
        assert.equal(socket.playerId, 'tg_123456789');
        assert.equal(timers.size, 1);
        await message({ type: 'auth', sessionToken });
        assert.equal(validations, 1);
        socket.close();
        assert.equal(timers.size, 0);
        assert.equal(socket.sessionRecheck, undefined);
      } finally {
        db.query = originalQuery;
      }
    });
  });

  await run('close during async auth never installs authenticated state or a timer', async () => {
    const { sessionToken } = await createAuthSession('tg_123456789');
    await withSocket(async (socket, frames, message, timers) => {
      const pending = message({ type: 'auth', sessionToken });
      socket.close();
      await pending;
      assert.equal(socket.playerId, undefined);
      assert.equal(socket.sessionRecheck, undefined);
      assert.equal(timers.size, 0);
    });
  });

  await run('close during final player upsert cannot resurrect the socket', async () => {
    const { sessionToken } = await createAuthSession('tg_123456789');
    await withSocket(async (socket, frames, message, timers) => {
      const originalQuery = db.query;
      let intercepted = false;
      db.query = (async (...args: Parameters<typeof db.query>) => {
        const result = await originalQuery.apply(db, args);
        if (String(args[0]).includes('INSERT INTO players')) {
          intercepted = true;
          socket.close();
        }
        return result;
      }) as typeof db.query;
      try {
        await message({ type: 'auth', sessionToken });
        assert.equal(intercepted, true);
        assert.equal(socket.playerId, undefined);
        assert.equal(socket.sessionRecheck, undefined);
        assert.equal(timers.size, 0);
      } finally {
        db.query = originalQuery;
      }
    });
  });

  await run('personal delivery fails closed on DB failure or socket closure during validation', async () => {
    for (const scenario of ['db_failure', 'close']) {
      const { sessionToken } = await createAuthSession('tg_123456789');
      await withSocket(async (socket, frames, message, timers) => {
        await message({ type: 'auth', sessionToken });
        const originalQuery = db.query;
        db.query = (async (...args: Parameters<typeof db.query>) => {
          if (scenario === 'db_failure') throw new Error('Simulated database failure');
          const result = await originalQuery.apply(db, args);
          socket.close();
          return result;
        }) as typeof db.query;
        try {
          await wsServer.sendToPlayer('tg_123456789', 'private_probe', {});
          assert.equal(frames.some(frame => frame.type === 'private_probe'), false);
          assert.equal(socket.readyState, WebSocket.CLOSED);
          assert.equal(timers.size, 0);
        } finally {
          db.query = originalQuery;
        }
      });
    }
  });

  await run('personal delivery rejects idle-expired, absolute-expired and revoked sessions', async () => {
    for (const expiry of ['idle_expires_at', 'absolute_expires_at', 'revoked_at']) {
      const { sessionToken } = await createAuthSession('tg_123456789');
      await withSocket(async (socket, frames, message, timers) => {
        await message({ type: 'auth', sessionToken });
        const before = await sessionTimes(sessionToken);
        await wsServer.sendToPlayer('tg_123456789', 'valid_probe', {});
        assert.ok(frames.some(frame => frame.type === 'valid_probe'));
        assert.deepEqual(await sessionTimes(sessionToken), before, 'outbound traffic must not refresh activity');
        await db.query(`UPDATE auth_sessions SET ${expiry} = $2 WHERE token_hash = $1`, [digest(sessionToken), new Date(Date.now() - 1)]);
        await wsServer.sendToPlayer('tg_123456789', 'private_probe', {});
        assert.equal(frames.some(frame => frame.type === 'private_probe'), false);
        assert.equal(socket.readyState, WebSocket.CLOSED);
        assert.equal(timers.size, 0);
      });
    }
  });

  await run('WS activity slides idle expiry and preserves the absolute deadline', async () => {
    const { sessionToken } = await createAuthSession('tg_123456789');
    await withSocket(async (socket, frames, message) => {
      await message({ type: 'auth', sessionToken });
      const original = await sessionTimes(sessionToken);
      await db.query('UPDATE auth_sessions SET idle_expires_at = $2 WHERE token_hash = $1', [digest(sessionToken), new Date(Date.now() + 60_000)]);
      const beforeActivity = Date.now();
      await message({ type: 'activity' });
      const after = await sessionTimes(sessionToken);
      assert.ok(after.idle_expires_at >= beforeActivity + 12 * hour);
      assert.ok(after.idle_expires_at <= Date.now() + 12 * hour);
      assert.equal(after.absolute_expires_at, original.absolute_expires_at);
      const deadline = Date.now() + 60_000;
      await db.query('UPDATE auth_sessions SET absolute_expires_at = $2 WHERE token_hash = $1', [digest(sessionToken), new Date(deadline)]);
      await message({ type: 'activity' });
      const capped = await sessionTimes(sessionToken);
      assert.equal(capped.idle_expires_at, deadline);
      assert.equal(capped.absolute_expires_at, deadline);
    });
  });

  await run('public broadcasts skip session queries and dev WS still works', async () => {
    await withSocket(async (socket, frames, message) => {
      await message({ type: 'auth', devPlayerId: 'dev_ws_auth_test' });
      const originalQuery = db.query;
      db.query = (() => { throw new Error('Unexpected database access'); }) as typeof db.query;
      try {
        wsServer.broadcast('market_probe', {});
        await wsServer.sendToPlayer('dev_ws_auth_test', 'dev_probe', {});
        assert.ok(frames.some(frame => frame.type === 'market_probe'));
        assert.ok(frames.some(frame => frame.type === 'dev_probe'));
      } finally {
        db.query = originalQuery;
      }
    });
  });
}
