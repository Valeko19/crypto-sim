import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client, sleep } from './lib/client.js';
import { TestOutcome } from './lib/runner.js';
import { usd } from './lib/format.js';

// ---------------------------------------------------------------------------
// Test 8: debug endpoints must be unreachable under NODE_ENV=production.
//
// Originally this spun up a genuine second server process (own port, own
// throwaway PGDATA_DIR) and hit its HTTP endpoints directly — the most
// faithful possible check. In practice, in this sandboxed dev environment,
// that approach was unreliable: child_process.spawn intermittently failed
// with EPERM, and even when the process did start, PGlite initializing a
// fresh on-disk database occasionally hung indefinitely instead of erroring
// (observed directly while building this suite — see the exchange this was
// built in). A test that hangs the whole suite is worse than one that tests
// slightly less.
//
// Instead this checks the same guarantee two ways, neither touching an HTTP
// server or a database at all:
//   1. Spawns a MINIMAL child process that imports ONLY src/auth/telegram.ts
//      (a single file with no DB/HTTP dependencies) under NODE_ENV=production
//      and confirms DEV_AUTH_ALLOWED evaluates to false there (and true
//      under a normal dev env, as a sanity check the harness itself works).
//   2. Statically confirms every mutating /debug/* route handler in
//      src/api/routes.ts actually references DEV_AUTH_ALLOWED as a guard —
//      so this also catches a NEW debug route added later without the guard,
//      not just the ones already known about.
// ---------------------------------------------------------------------------

async function runIsolatedCheck(scriptPath: string, serverDir: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn('npx', ['tsx', scriptPath], { cwd: serverDir, env, shell: true });
    let out = '';
    let err = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('таймаут (10с) при проверке DEV_AUTH_ALLOWED в изолированном процессе'));
    }, 10_000);
    child.stdout.on('data', d => (out += d.toString()));
    child.stderr.on('data', d => (err += d.toString()));
    child.on('error', e => {
      clearTimeout(timeout);
      reject(e);
    });
    child.on('exit', code => {
      clearTimeout(timeout);
      if (code === 0) resolve(out);
      else reject(new Error(`код выхода ${code}: ${err || out}`));
    });
  });
}

async function checkDevAuthAllowed(serverDir: string, nodeEnv: string | undefined): Promise<boolean> {
  const authModuleUrl = pathToFileURL(path.join(serverDir, 'src', 'auth', 'telegram.ts')).href;
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'crypto-sim-auth-check-'));
  const scriptPath = path.join(tmpDir, 'check.mts');
  writeFileSync(
    scriptPath,
    `import { DEV_AUTH_ALLOWED } from ${JSON.stringify(authModuleUrl)};\nconsole.log(JSON.stringify({ devAuthAllowed: DEV_AUTH_ALLOWED }));\n`
  );
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (nodeEnv === undefined) delete env.NODE_ENV;
  else env.NODE_ENV = nodeEnv;
  delete env.ALLOW_DEV_AUTH;

  try {
    // child_process.spawn intermittently fails with EPERM in this sandboxed
    // dev environment even for a trivial, near-instant script — retry a few
    // times before giving up (see the note this test returns).
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        const output = await runIsolatedCheck(scriptPath, serverDir, env);
        const match = output.match(/\{[^}]*\}/);
        if (!match) throw new Error(`не удалось разобрать вывод: ${output}`);
        return JSON.parse(match[0]).devAuthAllowed;
      } catch (e) {
        lastError = e;
        if (attempt < 5) await sleep(500);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Routes deliberately left ungated (read-only diagnostics, no state mutation,
// nothing exposed beyond what an authenticated player can already see) — see
// the comment on GET /debug/tick-breakdown in routes.ts.
const INTENTIONALLY_UNGATED_DEBUG_ROUTES = new Set(['GET /debug/tick-breakdown']);

function checkGuardsInSource(serverDir: string): { allGuarded: boolean; details: string[] } {
  const routesPath = path.join(serverDir, 'src', 'api', 'routes.ts');
  const src = readFileSync(routesPath, 'utf8');
  const routeRegex = /router\.(get|post)\('(\/debug\/[a-zA-Z0-9\-\/:]+)'/g;
  const matches: { method: string; routePath: string; index: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = routeRegex.exec(src))) {
    matches.push({ method: m[1].toUpperCase(), routePath: m[2], index: m.index });
  }
  const details: string[] = [];
  let allGuarded = true;
  for (let i = 0; i < matches.length; i++) {
    const label = `${matches[i].method} ${matches[i].routePath}`;
    if (INTENTIONALLY_UNGATED_DEBUG_ROUTES.has(label)) {
      details.push(`${label}: намеренно без гейта (read-only диагностика)`);
      continue;
    }
    const start = matches[i].index;
    const end = i + 1 < matches.length ? matches[i + 1].index : Math.min(src.length, start + 800);
    const guarded = src.slice(start, end).includes('DEV_AUTH_ALLOWED');
    details.push(`${label}: ${guarded ? 'защищён DEV_AUTH_ALLOWED' : 'НЕ ЗАЩИЩЁН!'}`);
    if (!guarded) allGuarded = false;
  }
  return { allGuarded, details };
}

export async function test8_debugEndpointsBlockedInProd(serverDir: string): Promise<TestOutcome> {
  const lines: string[] = [];
  let pass = true;

  const prodValue = await checkDevAuthAllowed(serverDir, 'production');
  const devValue = await checkDevAuthAllowed(serverDir, undefined);
  lines.push(`DEV_AUTH_ALLOWED при NODE_ENV=production: ${prodValue} (ожидается false).`);
  lines.push(`DEV_AUTH_ALLOWED при обычном dev-окружении: ${devValue} (ожидается true — проверка, что сама проверка работает).`);
  if (prodValue !== false || devValue !== true) {
    pass = false;
    lines.push('  ПРОВАЛ: DEV_AUTH_ALLOWED не ведёт себя как ожидается в одном из режимов.');
  }

  const { allGuarded, details } = checkGuardsInSource(serverDir);
  lines.push('Проверка каждого /debug/* роута в routes.ts на наличие гейта DEV_AUTH_ALLOWED:');
  for (const d of details) lines.push(`  ${d}`);
  if (!allGuarded) {
    pass = false;
    lines.push('  ПРОВАЛ: как минимум один /debug/* роут не защищён DEV_AUTH_ALLOWED.');
  }

  return {
    pass,
    lines,
    note:
      'Изначальный план — поднять отдельный живой процесс сервера с NODE_ENV=production и опросить его debug-эндпоинты по HTTP — оказался ненадёжен именно в этой песочнице (спавн процесса иногда падал с EPERM, а иногда сервер поднимался, но PGlite зависала на инициализации свежей БД на диске, вместо того чтобы упасть с ошибкой). Тест переработан на два эквивалентных по сути, но не требующих HTTP-сервера/БД чека: (1) реальное вычисление DEV_AUTH_ALLOWED в изолированном дочернем процессе под NODE_ENV=production, (2) статическая проверка, что каждый /debug/*-роут в исходниках действительно ссылается на DEV_AUTH_ALLOWED. Это не полный end-to-end прогон живого сервера, но проверяет ту же гарантию напрямую и куда надёжнее в этом окружении.',
  };
}

// ---------------------------------------------------------------------------
// Test 9: instant pump + instant rank-reward claim.
// ---------------------------------------------------------------------------

export async function test9_instantPumpRankClaim(makeTestClient: (tag: string) => Client): Promise<TestOutcome> {
  const client = makeTestClient('rankclaim');
  const lines: string[] = [];
  let pass = true;

  // Pushes net worth from the starting 100 to ~2100 — well past the rank-1
  // ("Креветка", 1000-10000) threshold — in a single instantaneous call.
  await client.post('/debug/grant-balance', { amount: 2000 });

  const immediate = await client.tryPost('/quests/claim', { questId: 'rank_reward:1' });
  lines.push(`Немедленный клейм сразу после мгновенного пампа: HTTP ${immediate.status} ${JSON.stringify(immediate.body)}`);
  if (immediate.status === 200) {
    pass = false;
    lines.push('  ПРОВАЛ: награда выдана мгновенно, до того как движок вообще успел зафиксировать новый пик капитала.');
  }

  await sleep(2500); // let at least 2 real engine ticks run checkRankUpRewards

  const delayed = await client.tryPost('/quests/claim', { questId: 'rank_reward:1' });
  lines.push(`Повторный клейм через 2.5с: HTTP ${delayed.status} ${JSON.stringify(delayed.body)}`);
  if (delayed.status !== 200 || delayed.body?.amount !== 100) {
    pass = false;
    lines.push('  ПРОВАЛ: клейм не прошёл даже после того, как движок должен был зафиксировать новый пик капитала.');
  }

  return {
    pass,
    lines,
    note:
      'В текущем коде НЕТ отдельной 30-минутной выдержки перед клеймом ранговой награды (проверено по исходникам — src/engine/rankRewards.ts и POST /quests/claim отслеживают только пик net worth "highestLeagueIndex", без какого-либо таймера). Единственная реальная задержка — до следующего фонового тика (раз в секунду), который и фиксирует новый пик через checkRankUpRewards. Тест проверяет именно этот механизм: мгновенный клейм сразу после мгновенного пампа должен быть отклонён, а клейм чуть позже — пройти. Есть небольшая (доли процента) вероятность гонки: если фоновый тик случайно сработает в узком окне между grant-balance и немедленным клеймом, "немедленный" клейм может неожиданно пройти.',
  };
}

// ---------------------------------------------------------------------------
// Test 10: emission-capture reward can't be double-claimed across coins.
// ---------------------------------------------------------------------------

export async function test10_emissionDoubleClaim(makeTestClient: (tag: string) => Client): Promise<TestOutcome> {
  const client = makeTestClient('emissiondbl');
  const lines: string[] = [];
  let pass = true;
  const coinA = 'hmst';
  const coinB = 'dogx';
  const threshold = 1; // cheapest threshold — 1%

  for (const coinId of [coinA, coinB]) {
    const pool = await client.get(`/debug/pool/${coinId}`);
    const coinsResp = await client.get('/coins');
    const supply = coinsResp.coins.find((c: any) => c.id === coinId).supply;
    const quote = await client.post('/trade/quote', { coinId, side: 'buy', amountUsdd: 10 });
    const feePct = quote.feePct;

    const xTarget = pool.coinReserve - (threshold / 100) * supply * 1.05; // small margin over the exact 1%
    const yTarget = (pool.coinReserve * pool.usddReserve) / xTarget;
    const netNeeded = yTarget - pool.usddReserve;
    const amountUsdd = Math.ceil((netNeeded / (1 - feePct)) * 1.2);
    await client.post('/debug/grant-balance', { amount: amountUsdd });
    await client.post('/trade', { coinId, side: 'buy', amountUsdd });
  }

  const portfolioBefore = await client.get('/portfolio');
  const balanceBefore = portfolioBefore.usddBalance;

  const first = await client.tryPost('/quests/claim', { questId: `emission_capture:${coinA}:${threshold}` });
  lines.push(`Клейм на ${coinA} (${threshold}% эмиссии): HTTP ${first.status} ${JSON.stringify(first.body)}`);
  if (first.status !== 200) {
    pass = false;
    lines.push('  ПРОВАЛ: первый (честный) клейм не прошёл.');
  }

  const second = await client.tryPost('/quests/claim', { questId: `emission_capture:${coinB}:${threshold}` });
  lines.push(`Клейм того же порога (${threshold}%) на ДРУГОЙ монете (${coinB}): HTTP ${second.status} ${JSON.stringify(second.body)}`);
  if (second.status === 200) {
    pass = false;
    lines.push('  ПРОВАЛ: награда выдана повторно на другой монете за тот же порог эмиссии.');
  }

  const portfolioAfter = await client.get('/portfolio');
  const credited = portfolioAfter.usddBalance - balanceBefore;
  const expectedReward = first.body?.amount ?? 0;
  lines.push(`Зачислено на баланс между двумя попытками: ${usd(credited)} (ожидается ровно одна награда, ${usd(expectedReward)}).`);
  if (Math.abs(credited - expectedReward) > 0.01) {
    pass = false;
    lines.push('  ПРОВАЛ: зачисленная сумма не совпадает с одной наградой — похоже на двойную выплату или расхождение баланса.');
  }

  return { pass, lines };
}

// ---------------------------------------------------------------------------
// Test 11: request for more than the player's balance/holding, direct API.
// ---------------------------------------------------------------------------

export async function test11_overBalanceTrade(makeTestClient: (tag: string) => Client): Promise<TestOutcome> {
  const client = makeTestClient('overbalance');
  const lines: string[] = [];
  let pass = true;

  const before = await client.get('/portfolio');
  const balanceBefore = before.usddBalance;

  const buy = await client.tryPost('/trade', { coinId: 'btcr', side: 'buy', amountUsdd: balanceBefore * 1000 });
  const afterBuy = await client.get('/portfolio');
  lines.push(`Покупка на сумму в 1000x больше баланса (${usd(balanceBefore * 1000)} при балансе ${usd(balanceBefore)}): HTTP ${buy.status} ${JSON.stringify(buy.body)}`);
  lines.push(`Баланс до: ${usd(balanceBefore)}, после: ${usd(afterBuy.usddBalance)}.`);
  if (buy.status === 200 || Math.abs(afterBuy.usddBalance - balanceBefore) > 1e-9) {
    pass = false;
    lines.push('  ПРОВАЛ: заявка на покупку сверх баланса не была чисто отклонена (баланс изменился или запрос прошёл).');
  }

  const sell = await client.tryPost('/trade', { coinId: 'etn', side: 'sell', amountCoin: 999_999_999 });
  const afterSell = await client.get('/portfolio');
  lines.push(`Продажа монеты, которой нет на балансе (999,999,999 ETN): HTTP ${sell.status} ${JSON.stringify(sell.body)}`);
  if (sell.status === 200 || Math.abs(afterSell.usddBalance - afterBuy.usddBalance) > 1e-9) {
    pass = false;
    lines.push('  ПРОВАЛ: заявка на продажу несуществующей позиции не была чисто отклонена.');
  }

  return {
    pass,
    lines,
    note: 'ТЗ описывало сценарий с покупкой сверх баланса; тест расширен симметричным случаем продажи несуществующей позиции — та же категория уязвимости с другой стороны сделки.',
  };
}

// ---------------------------------------------------------------------------
// Test 12: concurrent trades from one account must not lose/duplicate state.
// ---------------------------------------------------------------------------

export async function test12_concurrentTrades(makeTestClient: (tag: string) => Client): Promise<TestOutcome> {
  const client = makeTestClient('concurrent');
  const lines: string[] = [];
  let pass = true;
  const coinId = 'btcr'; // deep pool — negligible price impact from these small trades, keeps the math simple
  const N = 10;
  const AMOUNT = 5;

  const before = await client.get('/portfolio');
  const balanceBefore = before.usddBalance;
  const holdingBefore = before.holdings.find((h: any) => h.coinId === coinId)?.amount ?? 0;

  const results = await Promise.all(
    Array.from({ length: N }, () => client.tryPost('/trade', { coinId, side: 'buy', amountUsdd: AMOUNT }))
  );
  const succeeded = results.filter(r => r.status === 200);
  lines.push(`Отправлено ${N} одновременных покупок по ${usd(AMOUNT)} с одного аккаунта. Успешных ответов: ${succeeded.length}/${N}.`);

  const expectedCharged = succeeded.reduce((sum, r) => sum + r.body.usddAmount + r.body.fee, 0);
  const expectedCoins = succeeded.reduce((sum, r) => sum + r.body.coinAmount, 0);

  const after = await client.get('/portfolio');
  const actualCharged = balanceBefore - after.usddBalance;
  const actualCoins = (after.holdings.find((h: any) => h.coinId === coinId)?.amount ?? 0) - holdingBefore;

  lines.push(`Ожидаемое списание (сумма по индивидуальным ответам сделок): ${usd(expectedCharged)}. Реальное изменение баланса: ${usd(actualCharged)}.`);
  lines.push(`Ожидаемое количество монет (сумма по ответам): ${expectedCoins.toFixed(8)}. Реальное изменение холдинга: ${actualCoins.toFixed(8)}.`);

  if (Math.abs(actualCharged - expectedCharged) > 1e-6 || Math.abs(actualCoins - expectedCoins) > 1e-6) {
    pass = false;
    lines.push('  ПРОВАЛ: итоговое состояние не совпадает с суммой индивидуальных ответов сделок — похоже на потерянное/задвоенное обновление при гонке.');
  }
  if (succeeded.length !== N) {
    pass = false;
    lines.push('  ПРОВАЛ: не все параллельные сделки прошли успешно, хотя баланса хватало на все с большим запасом.');
  }

  return { pass, lines };
}
