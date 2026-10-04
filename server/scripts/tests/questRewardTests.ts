import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const replayMode = process.argv[2] === '--replay';
const dataDir = replayMode ? process.argv[3] : mkdtempSync(path.join(tmpdir(), 'crypto-sim-quest-tests-'));
process.env.PGDATA_DIR = path.join(dataDir, 'db');
process.env.NODE_ENV = 'production';
delete process.env.ALLOW_DEV_AUTH;
delete process.env.BETA_ALLOWLIST;

const { db, initDb } = await import('../../src/db/index.js');
const { ensurePlayer, getPlayer, getEarnedTotals, getQuestProgress, setHighestLeagueIndex } = await import('../../src/db/queries.js');
const { createAuthSession } = await import('../../src/auth/sessions.js');
const { claimQuest } = await import('../../src/engine/quests.js');
const { createRouter } = await import('../../src/api/routes.js');
const { createInitialState } = await import('../../src/engine/state.js');
const { recordTradeVolume, utcDay } = await import('../../src/engine/dailyVolume.js');
const { COINS } = await import('../../src/config/coins.js');
const { DAILY_BONUS_AMOUNT, DAILY_VOLUME_REWARD, DAILY_VOLUME_THRESHOLD, EMISSION_THRESHOLDS } = await import('../../src/config/quests.js');
const { RANK_UP_REWARDS } = await import('../../src/config/ranks.js');

type Fixture = { id: string; token: string; questId: string; reward: number; category: 'daily' | 'emission' | 'rank' };
const kinds = ['daily_bonus', 'daily_volume', 'emission', 'rank'] as const;
type Kind = typeof kinds[number];
const manifest: Fixture[] = [];
let sequence = 0;
let passed = 0;
const app = express();
app.use(express.json());
app.use('/api', createRouter(createInitialState()));
const server = createServer(app);
let port: number;

async function run(name: string, test: () => Promise<void>) {
  await test();
  passed++;
  console.log(`PASS ${name}`);
}

async function fixture(kind: Kind): Promise<Fixture> {
  const id = `tg_quest_test_${++sequence}`;
  await ensurePlayer(id, id);
  if (kind === 'daily_volume') await db.transaction(tx => recordTradeVolume(tx, id, utcDay(), DAILY_VOLUME_THRESHOLD));
  if (kind === 'rank') await setHighestLeagueIndex(id, 1);
  if (kind === 'emission') {
    for (const coin of COINS.slice(0, 2)) {
      await db.query('INSERT INTO player_holdings (player_id, coin_id, amount, avg_buy_price) VALUES ($1, $2, $3, 1)',
        [id, coin.id, coin.emission * 0.02]);
    }
  }
  const { sessionToken: token } = await createAuthSession(id);
  return {
    id, token,
    questId: kind === 'emission' ? `emission_capture:${COINS[0].id}:1` : kind === 'rank' ? 'rank_reward:1' : kind,
    reward: kind === 'daily_bonus' ? DAILY_BONUS_AMOUNT : kind === 'daily_volume' ? DAILY_VOLUME_REWARD : kind === 'emission' ? EMISSION_THRESHOLDS[0].reward : RANK_UP_REWARDS[1],
    category: kind === 'emission' ? 'emission' : kind === 'rank' ? 'rank' : 'daily',
  };
}

async function request(f: Fixture, questId = f.questId) {
  const response = await fetch(`http://127.0.0.1:${port}/api/quests/claim`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Session-Token': f.token },
    body: JSON.stringify({ questId }), signal: AbortSignal.timeout(15_000),
  });
  return { status: response.status, body: await response.json() };
}

async function snapshot(id: string) {
  return {
    balance: (await getPlayer(id)).usdd_balance,
    earned: await getEarnedTotals(id),
    progress: await getQuestProgress(id),
  };
}

async function assertPaidOnce(f: Fixture, before: Awaited<ReturnType<typeof snapshot>>) {
  const after = await snapshot(f.id);
  assert.equal(after.balance - before.balance, f.reward);
  const earned = { ...before.earned };
  earned[f.category] += f.reward;
  assert.deepEqual(after.earned, earned);
  assert.equal(after.progress.length, 1);
  assert.equal(after.progress[0].coin_id, 'none');
  assert.ok(after.progress[0].claimed_at);
  assert.equal((await request(f)).status, 400);
  assert.deepEqual(await snapshot(f.id), after, 'sequential retry must not mutate any reward state');
  manifest.push(f);
}

function pipeline(f: Fixture, quests: string[]): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let output = '';
    socket.setTimeout(15_000, () => socket.destroy(new Error('Quest HTTP pipeline timed out')));
    socket.on('error', reject);
    socket.on('data', chunk => { output += chunk.toString(); });
    socket.on('end', () => resolve([...output.matchAll(/HTTP\/1\.1 (\d{3})/g)].map(match => Number(match[1]))));
    socket.on('connect', () => {
      socket.write(quests.map((questId, i) => {
        const body = JSON.stringify({ questId });
        return `POST /api/quests/claim HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nX-Session-Token: ${f.token}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: ${i === quests.length - 1 ? 'close' : 'keep-alive'}\r\n\r\n${body}`;
      }).join(''));
    });
  });
}

async function race(f: Fixture, quests: string[], winners = 1) {
  // Build an actual database backlog: a plain Promise.all(fetch) can serialize
  // accidentally on PGlite and passed even with the old vulnerable handler.
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const busy = db.transaction(async () => { started(); await gate; });
  await ready;
  const timer = setTimeout(release, 250);
  try {
    const statuses = await pipeline(f, quests);
    assert.equal(statuses.length, quests.length);
    assert.equal(statuses.filter(status => status === 200).length, winners);
    assert.equal(statuses.filter(status => status === 400).length, quests.length - winners);
  } finally {
    release(); clearTimeout(timer); await busy;
  }
}

async function main() {
  for (const kind of kinds) {
    for (const n of [2, 10, 64]) {
      await run(`${kind}: ${n} concurrent HTTP claims pay once; sequential replay is rejected`, async () => {
        const f = await fixture(kind);
        const before = await snapshot(f.id);
        await race(f, Array(n).fill(f.questId));
        await assertPaidOnce(f, before);
      });
    }
  }
  for (const kind of ['daily_bonus', 'daily_volume'] as const) {
    for (const n of [2, 10, 64]) {
      await run(`${kind}: expired cooldown permits one new payout among ${n} claims`, async () => {
        const f = await fixture(kind);
        assert.equal((await request(f)).status, 200);
        await db.query("UPDATE quest_progress SET claimed_at = now() - interval '25 hours' WHERE player_id = $1", [f.id]);
        const before = await snapshot(f.id);
        await race(f, Array(n).fill(f.questId));
        await assertPaidOnce(f, before);
      });
    }
  }
  for (const n of [2, 10, 64]) {
    await run(`emission: ${n} claims across two coins share one threshold`, async () => {
      const f = await fixture('emission');
      const before = await snapshot(f.id);
      await race(f, Array.from({ length: n }, (_, i) => `emission_capture:${COINS[i % 2].id}:1`));
      await assertPaidOnce(f, before);
      assert.equal((await request(f, `emission_capture:${COINS[1].id}:1`)).status, 400);
    });
  }
  await run('64 mixed claims pay each of four distinct rewards exactly once', async () => {
    const f = await fixture('emission');
    await db.transaction(tx => recordTradeVolume(tx, f.id, utcDay(), DAILY_VOLUME_THRESHOLD));
    await setHighestLeagueIndex(f.id, 1);
    const quests = ['daily_bonus', 'daily_volume', f.questId, 'rank_reward:1'];
    const before = await snapshot(f.id);
    await race(f, Array.from({ length: 64 }, (_, i) => quests[i % quests.length]), quests.length);
    const after = await snapshot(f.id);
    const daily = DAILY_BONUS_AMOUNT + DAILY_VOLUME_REWARD;
    assert.equal(after.balance - before.balance, daily + f.reward + RANK_UP_REWARDS[1]);
    assert.deepEqual(after.earned, { daily, emission: f.reward, rank: RANK_UP_REWARDS[1] });
    assert.equal(after.progress.length, 4);
    for (const questId of quests) {
      assert.equal((await request(f, questId)).status, 400);
      manifest.push({ ...f, questId });
    }
    assert.deepEqual(await snapshot(f.id), after);
  });
  await run('legacy emission marker blocks the same threshold on any coin', async () => {
    const f = await fixture('emission');
    await db.query("INSERT INTO quest_progress (player_id, quest_type, coin_id, threshold, claimed_at) VALUES ($1, 'emission_capture', $2, 1, now())", [f.id, COINS[0].id]);
    const before = await snapshot(f.id);
    assert.equal((await request(f, `emission_capture:${COINS[1].id}:1`)).status, 400);
    assert.deepEqual(await snapshot(f.id), before);
  });

  for (const kind of kinds) {
    for (const fault of ['after_marker', 'after_payout', 'before_totals', 'after_totals']) {
      await run(`${kind}: ${fault} rolls back all effects and permits a retry`, async () => {
        const f = await fixture(kind);
        const before = await snapshot(f.id);
        const originalTransaction = db.transaction;
        let injected = false;
        db.transaction = (async (fn: Parameters<typeof db.transaction>[0]) => originalTransaction.call(db, async tx => {
          const query = tx.query.bind(tx);
          tx.query = (async (...args: Parameters<typeof tx.query>) => {
            const sql = String(args[0]);
            if (fault === 'before_totals' && sql.includes('INSERT INTO player_earned_totals')) {
              injected = true; throw new Error('Injected quest failure');
            }
            const result = await query(...args);
            if ((fault === 'after_marker' && sql.includes('INSERT INTO quest_progress')) ||
                (fault === 'after_payout' && sql.includes('UPDATE players SET usdd_balance')) ||
                (fault === 'after_totals' && sql.includes('INSERT INTO player_earned_totals'))) {
              injected = true; throw new Error('Injected quest failure');
            }
            return result;
          }) as typeof tx.query;
          return fn(tx);
        })) as typeof db.transaction;
        try {
          assert.equal((await request(f)).status, 500);
          assert.equal(injected, true);
        } finally {
          db.transaction = originalTransaction;
        }
        assert.deepEqual(await snapshot(f.id), before);
        assert.equal((await request(f)).status, 200);
        await assertPaidOnce(f, before);
      });
    }
  }

  await run('all claim queries use the transaction client and lock before reading eligibility', async () => {
    for (const kind of kinds) {
      const f = await fixture(kind);
      const before = await snapshot(f.id);
      const originalQuery = db.query;
      const originalTransaction = db.transaction;
      const statements: string[] = [];
      db.query = (() => { throw new Error('Claim escaped its transaction client'); }) as typeof db.query;
      db.transaction = (async (fn: Parameters<typeof db.transaction>[0]) => originalTransaction.call(db, async tx => {
        const query = tx.query.bind(tx);
        tx.query = (async (...args: Parameters<typeof tx.query>) => {
          statements.push(String(args[0]));
          return query(...args);
        }) as typeof tx.query;
        return fn(tx);
      })) as typeof db.transaction;
      try {
        assert.equal(await claimQuest(f.id, f.questId), f.reward);
        assert.match(statements[0], /SELECT id FROM players.*FOR UPDATE/);
      } finally {
        db.query = originalQuery;
        db.transaction = originalTransaction;
      }
      await assertPaidOnce(f, before);
    }
  });

  await run('ineligible volume, emission and rank claims leave no financial effects', async () => {
    for (const questId of ['daily_volume', `emission_capture:${COINS[0].id}:1`, 'rank_reward:1', 'rank_reward:999', 'emission_capture:missing:1', 'unknown']) {
      const f = await fixture('daily_bonus');
      const before = await snapshot(f.id);
      assert.equal((await request(f, questId)).status, 400);
      assert.deepEqual(await snapshot(f.id), before);
    }
  });
}

let completed = false;
try {
  await initDb();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
  if (replayMode) {
    const fixtures: Fixture[] = JSON.parse(readFileSync(path.join(dataDir, 'replay.json'), 'utf8'));
    for (const f of fixtures) {
      const before = await snapshot(f.id);
      assert.equal((await request(f)).status, 400);
      assert.deepEqual(await snapshot(f.id), before);
    }
    console.log(`PASS process restart rejects ${fixtures.length} committed claims without changing balances or totals`);
  } else {
    await main();
    writeFileSync(path.join(dataDir, 'replay.json'), JSON.stringify(manifest));
  }
  completed = true;
} catch (error) {
  console.error('QUEST REWARD TEST FAILURE', error);
  process.exitCode = 1;
} finally {
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  await db.close();
}

if (!replayMode) {
  try {
    if (completed) {
      const child = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), '--replay', dataDir], { encoding: 'utf8', timeout: 60_000 });
      assert.equal(child.status, 0, child.stderr || String(child.error));
      process.stdout.write(child.stdout);
      console.log(`QUEST REWARD TESTS: ${passed + 1} passed`);
    }
  } catch (error) {
    console.error('QUEST RESTART TEST FAILURE', error);
    process.exitCode = 1;
  } finally {
    // dataDir is created by mkdtemp above; never remove the child's input path.
    const resolved = path.resolve(dataDir);
    assert.equal(path.dirname(resolved), path.resolve(tmpdir()));
    assert.ok(path.basename(resolved).startsWith('crypto-sim-quest-tests-'));
    rmSync(resolved, { recursive: true, force: true });
  }
}
