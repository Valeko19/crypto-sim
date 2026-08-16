import { Client, sleep } from './lib/client.js';
import { TestOutcome } from './lib/runner.js';
import { usd, pct } from './lib/format.js';

// ---------------------------------------------------------------------------
// Tests 1-3: share one long fast-forwarded market simulation (see runner note
// below) since they're all "let the unattended market run for a long time
// and look at the shape of what happened" questions over the SAME window.
// ---------------------------------------------------------------------------

interface CoinMeta {
  id: string;
  symbol: string;
  section: string;
  supply: number;
}

interface FastForwardResult {
  ticksRun: number;
  tickCount: number;
  macroPhase: string;
  priceStats: Record<string, { min: number; max: number }>;
  phaseLog: { phase: string; atTick: number; btcrPrice: number }[];
}

// At TICK_MS=1000 and the live PHASE_DURATION_MULTIPLIER=3, one full macro
// cycle currently averages ~2-5.4h of real time — actually waiting through
// "several full cycles" would take many hours. 200,000 ticks (~55.5h of
// simulated market time) run through POST /debug/fast-forward in a couple of
// real seconds instead, guaranteeing at least ~10 completed cycles even in
// the slowest-possible-phase-duration case (worst case ~19,440 ticks/cycle).
const FAST_FORWARD_TICKS = 200_000;

export async function runMarketSimulation(client: Client): Promise<{ ff: FastForwardResult; coins: CoinMeta[] }> {
  const coinsResp = await client.get('/coins');
  const coins: CoinMeta[] = coinsResp.coins.map((c: any) => ({ id: c.id, symbol: c.symbol, section: c.section, supply: c.supply }));

  // Snapshot every coin's pool before blasting the market tens of simulated
  // hours forward, and restore it afterward — this server/DB is a shared,
  // persistent dev environment (pool reserves are snapshotted to disk and
  // resumed across restarts), so without this, every run of this suite would
  // permanently ratchet prices further from their configured baseline. All
  // the min/max/phase data this test needs is already captured in `ff`
  // during the run itself, so nothing is lost by reverting afterward.
  const poolsBefore: Record<string, { coinReserve: number; usddReserve: number; playerOwnedCoins: number }> = {};
  for (const c of coins) {
    poolsBefore[c.id] = await client.get(`/debug/pool/${c.id}`);
  }

  const ff: FastForwardResult = await client.post('/debug/fast-forward', { ticks: FAST_FORWARD_TICKS });

  await client.post('/debug/restore-pools', { pools: poolsBefore });

  return { ff, coins };
}

const SECTION_ORDER = ['top1', 'alt', 'meme']; // highest category first

export function test1_marketWithoutPlayer(ff: FastForwardResult, coins: CoinMeta[]): TestOutcome {
  const lines: string[] = [];
  let pass = true;
  lines.push(
    `Прогнано ${ff.ticksRun} тиков (~${(ff.ticksRun / 3600).toFixed(1)} ч симулированного рыночного времени, без единой сделки игрока), пройдено фазовых сегментов: ${ff.phaseLog.length}.`
  );

  const capByCoin: Record<string, { min: number; max: number; section: string; symbol: string }> = {};
  for (const c of coins) {
    const s = ff.priceStats[c.id];
    if (!s) {
      pass = false;
      lines.push(`  ! нет данных по ${c.symbol}`);
      continue;
    }
    const minCap = s.min * c.supply;
    const maxCap = s.max * c.supply;
    capByCoin[c.id] = { min: minCap, max: maxCap, section: c.section, symbol: c.symbol };
    lines.push(`  ${c.symbol} (${c.section}): капитализация от ${usd(minCap)} до ${usd(maxCap)}`);
    if (minCap < 100) {
      pass = false;
      lines.push(`    ПРОВАЛ: минимальная капитализация ${usd(minCap)} — абсурдно низкая (< $100)`);
    }
  }

  const bySection: Record<string, { min: number; max: number }[]> = { top1: [], alt: [], meme: [] };
  for (const v of Object.values(capByCoin)) bySection[v.section]?.push(v);
  for (let i = 0; i < SECTION_ORDER.length; i++) {
    for (let j = i + 1; j < SECTION_ORDER.length; j++) {
      const higher = bySection[SECTION_ORDER[i]];
      const lower = bySection[SECTION_ORDER[j]];
      if (!higher.length || !lower.length) continue;
      const higherMin = Math.min(...higher.map(x => x.min));
      const lowerMax = Math.max(...lower.map(x => x.max));
      if (lowerMax > higherMin) {
        pass = false;
        lines.push(
          `  ПРОВАЛ: максимум капитализации категории "${SECTION_ORDER[j]}" (${usd(lowerMax)}) обгоняет минимум категории "${SECTION_ORDER[i]}" (${usd(higherMin)})`
        );
      }
    }
  }

  return {
    pass,
    lines,
    note:
      'Категориальная проверка расширена с примера из ТЗ ("мемкоин обгоняет топ-монету") на все пары категорий top1/alt/meme — тот же принцип. ВАЖНАЯ ОГОВОРКА: сравнение "min/max" берёт минимум и максимум капитализации КАЖДОЙ категории за ВЕСЬ прогнанный период независимо — это НЕ проверка "обогнала ли монета другую В ОДИН И ТОТ ЖЕ МОМЕНТ", а более строгая проверка "пересекались ли диапазоны когда-либо в принципе". При достаточно долгом прогоне и большой амплитуде макро-циклов (топ-монета в этом прогоне колебалась в 15+ раз от минимума к максимуму) такое пересечение возможно даже если на любой конкретный момент порядок капитализаций соблюдается. Если тест падает по этой причине — это сигнал для более пристального разбора, а не подтверждённое нарушение "в моменте". Тест использует debug-эндпоинт быстрой перемотки тиков (POST /api/debug/fast-forward, добавлен специально для этого набора тестов), который синхронно прогоняет tick() без реального ожидания часов — иначе честные "несколько полных макроциклов" заняли бы часы реального времени при текущем PHASE_DURATION_MULTIPLIER=3. tick() — чистая синхронная функция без сайд-эффектов ввода-вывода, так что результат идентичен тому, что дал бы обычный live-сервер за то же количество тиков, просто без ожидания. Резервы пулов сохраняются перед прогоном и восстанавливаются после (POST /debug/restore-pools) — иначе каждый запуск этого набора тестов необратимо сдвигал бы цены на общем dev-сервере всё дальше от базовых.',
  };
}

interface PhaseSegment {
  phase: string;
  startPrice: number;
  endPrice: number;
  pctChange: number;
}

function completedSegments(ff: FastForwardResult): PhaseSegment[] {
  const segs: PhaseSegment[] = [];
  // Segment 0 would run from phaseLog[0] (the moment fast-forward STARTED,
  // not a genuine phase transition — that phase could already have been
  // running a while) to phaseLog[1] — its price swing understates the
  // phase's true full move, so it's excluded, same as the trailing
  // still-in-progress phase (there's no segment formed past the last entry).
  for (let i = 1; i < ff.phaseLog.length - 1; i++) {
    const a = ff.phaseLog[i];
    const b = ff.phaseLog[i + 1];
    segs.push({ phase: a.phase, startPrice: a.btcrPrice, endPrice: b.btcrPrice, pctChange: (b.btcrPrice / a.btcrPrice - 1) * 100 });
  }
  return segs;
}

export function test2_bullBearSwing(ff: FastForwardResult): TestOutcome {
  const segs = completedSegments(ff);
  const bears = segs.filter(s => s.phase === 'bear');
  const bulls = segs.filter(s => s.phase === 'bull');
  const lines: string[] = [];
  let pass = true;

  lines.push(`Завершённых медвежьих фаз: ${bears.length}, бычьих фаз: ${bulls.length}.`);
  for (const s of bears) {
    const ok = s.pctChange <= -50 && s.pctChange >= -80;
    lines.push(`  Медвежья фаза: ${pct(s.pctChange)} (цель: -50%…-80%) ${ok ? 'OK' : 'ВНЕ ДИАПАЗОНА'}`);
    if (!ok) pass = false;
  }
  for (const s of bulls) {
    const mult = s.endPrice / s.startPrice;
    const ok = mult >= 2 && mult <= 5;
    lines.push(`  Бычья фаза: x${mult.toFixed(2)} (${pct(s.pctChange)}) (цель: x2…x5) ${ok ? 'OK' : 'ВНЕ ДИАПАЗОНА'}`);
    if (!ok) pass = false;
  }
  if (bears.length === 0 || bulls.length === 0) {
    pass = false;
    lines.push('  ПРОВАЛ: недостаточно завершённых фаз для оценки — увеличьте число прогоняемых тиков.');
  }
  return { pass, lines };
}

export function test3_winterNeutral(ff: FastForwardResult): TestOutcome {
  const segs = completedSegments(ff).filter(s => s.phase === 'accumulation');
  const lines: string[] = [];
  let pass = true;
  lines.push(`Завершённых "зимних" фаз (accumulation): ${segs.length} (нужно минимум 5).`);
  if (segs.length < 5) {
    pass = false;
    lines.push('  ПРОВАЛ: меньше 5 завершённых зимних фаз в прогнанном окне — увеличьте FAST_FORWARD_TICKS.');
  }
  for (const s of segs) lines.push(`  Зима: ${pct(s.pctChange)}`);

  const avg = segs.length ? segs.reduce((sum, s) => sum + s.pctChange, 0) / segs.length : 0;
  lines.push(`  Среднее изменение за зиму: ${pct(avg)} (порог: |среднее| <= 3%)`);
  if (Math.abs(avg) > 3) {
    pass = false;
    lines.push('  ПРОВАЛ: среднее отклонение по всем зимам больше 3%.');
  }

  const up = segs.filter(s => s.pctChange > 0).length;
  const down = segs.filter(s => s.pctChange < 0).length;
  const upRatio = segs.length ? up / segs.length : 0.5;
  lines.push(`  Рост/падение: ${up}/${down} из ${segs.length} (доля закрывшихся ростом: ${(upRatio * 100).toFixed(0)}%)`);
  if (Math.abs(upRatio - 0.5) > 0.2) {
    pass = false;
    lines.push('  ПРОВАЛ: соотношение роста/падения заметно смещено от 50/50.');
  }

  return {
    pass,
    lines,
    note: 'Порог "заметно отличается от 50/50" в ТЗ не задан числом — здесь это трактуется как отклонение доли роста от 50% больше чем на 20 процентных пунктов (т.е. диапазон 30%-70% считается "близко").',
  };
}

// ---------------------------------------------------------------------------
// Tests 4-5: share one player/position (test 5 sells back what test 4 bought).
// ---------------------------------------------------------------------------

// Meme coins first (smallest USDD pool reserve — cheapest to dominate), each
// a fallback for the last: the shared market is stateful and long-running
// (macro drift persists across process restarts via pool snapshots), so
// whichever coin happens to have the most free float LEFT right now is
// picked instead of assuming a fresh, untouched server.
const EMISSION_CAPTURE_CANDIDATES = ['wlmb', 'hmst', 'dogx', 'pepz', 'embr'];

export async function test4_emissionCapture(
  runId: string,
  makeTestClient: (tag: string) => Client
): Promise<{
  outcome: TestOutcome;
  coinId: string;
  client: Client;
  originalPool: { coinReserve: number; usddReserve: number; playerOwnedCoins: number } | null;
}> {
  const client = makeTestClient('emissioncap');
  const lines: string[] = [];
  let pass = true;

  const coinsResp = await client.get('/coins');
  let coinId: string | null = null;
  let supply = 0;
  let x0 = 0;
  let y0 = 0;
  let ownedBefore = 0;
  let maxReachablePct = 0;
  const skipped: string[] = [];
  for (const candidate of EMISSION_CAPTURE_CANDIDATES) {
    const s = coinsResp.coins.find((c: any) => c.id === candidate).supply;
    const pool = await client.get(`/debug/pool/${candidate}`);
    const reachablePct = (pool.coinReserve / s) * 100;
    if (reachablePct >= 64) {
      coinId = candidate;
      supply = s;
      x0 = pool.coinReserve;
      y0 = pool.usddReserve;
      ownedBefore = pool.playerOwnedCoins;
      maxReachablePct = reachablePct;
      break;
    }
    skipped.push(`${candidate} (доступно ${reachablePct.toFixed(1)}%)`);
  }
  if (!coinId) {
    return {
      outcome: {
        pass: false,
        lines: [
          `ПРОВАЛ: ни одна монета-кандидат не имеет достаточно свободного float для цели 60-70% сейчас: ${skipped.join(', ')}. Запустите "npx tsx scripts/reset-market-pools.ts" и повторите.`,
        ],
      },
      coinId: EMISSION_CAPTURE_CANDIDATES[0],
      client,
      originalPool: null,
    };
  }
  // Restored after test 5 finishes selling back (see index.ts) — tests 4-5
  // deliberately make real, large trades (that's the point), but without
  // this the coin would stay permanently ~65%-captured on this shared dev
  // server, and repeated suite runs would eventually exhaust every
  // candidate in EMISSION_CAPTURE_CANDIDATES. playerOwnedCoins matters just
  // as much as the pool reserves here: gravity.ts's justifiedPrice() anchors
  // hard (squared) on it, and test 5's sell-back is deliberately capped by
  // the pool's own single-trade guard, so it can NEVER fully undo test 4's
  // buy on its own — without restoring this explicitly, the coin's justified
  // price stays wildly inflated long after the pool itself looks normal
  // again (this was caught live: HMFL's simulated cap hit $2.8 TRILLION in
  // test 1 before this fix, from exactly this leftover skew).
  const originalPool = { coinReserve: x0, usddReserve: y0, playerOwnedCoins: ownedBefore };
  if (skipped.length) lines.push(`Пропущены (недостаточно free float): ${skipped.join(', ')}.`);
  const k0 = x0 * y0;

  const quote = await client.post('/trade/quote', { coinId, side: 'buy', amountUsdd: 10 });
  const feePct = quote.feePct;

  // Aim for 65% of TOTAL emission (centered in the 60-70% target range) via
  // the pool's own reserve: target pool coinReserve x_target = x0 -
  // frac*supply, then solve the exact net USDD input needed to reach it
  // under the constant-product invariant. Clamped to whatever share is
  // actually reachable for the chosen coin right now (see candidate
  // selection above — requires >=64% reachable) minus a small fixed margin
  // (not a multiplicative one, which could push the target back below the
  // 60% floor for a coin only just above the 64% reachability bar), so the
  // target always lands comfortably inside [60, 70].
  const targetFrac = Math.min(0.65, maxReachablePct / 100 - 0.02);
  const xTarget = x0 - targetFrac * supply;
  const yTarget = k0 / xTarget;
  const netNeeded = yTarget - y0;
  const grantAmount = Math.ceil((netNeeded / (1 - feePct)) * 1.3); // 30% safety margin
  await client.post('/debug/grant-balance', { amount: grantAmount });
  lines.push(`Монета: ${coinId}. Начальные резервы пула: coin=${x0.toFixed(2)}, USDD=${usd(y0)}. Комиссия: ${(feePct * 100).toFixed(2)}%.`);
  lines.push(`Тестовому игроку выдано ${usd(grantAmount)} напрямую через /debug/grant-balance.`);

  // Converge on xTarget with a sequence of buys, each closing 90% of the
  // remaining gap but NEVER more than 25% of the CURRENT pool reserve —
  // amm.ts's buyWithUsdd silently caps any single trade at 30% of the
  // reserve (executing/charging only the capped amount), which the
  // independent hand-rolled math below does NOT model, so every requested
  // step must stay safely under that cap for the two to stay comparable.
  // Self-corrects against the ACTUAL current pool state each iteration (not
  // a pre-computed schedule), converging on the 65% target in ~6-8 steps.
  const requestedAmounts: number[] = [];
  let totalCharged = 0;
  let totalCoinsReceived = 0;
  for (let i = 0; i < 12; i++) {
    const pool = await client.get(`/debug/pool/${coinId}`);
    const remainingGap = pool.coinReserve - xTarget;
    if (remainingGap <= pool.coinReserve * 0.0005) break; // converged
    const stepCoinOut = Math.min(remainingGap * 0.9, pool.coinReserve * 0.25);
    const kCurrent = pool.coinReserve * pool.usddReserve;
    const newX = pool.coinReserve - stepCoinOut;
    const newY = kCurrent / newX;
    const netIn = newY - pool.usddReserve;
    const amountUsdd = netIn / (1 - feePct);
    if (amountUsdd < 1) break;
    requestedAmounts.push(amountUsdd);
    const result = await client.post('/trade', { coinId, side: 'buy', amountUsdd });
    totalCharged += result.usddAmount + result.fee;
    totalCoinsReceived += result.coinAmount;
  }

  const portfolio = await client.get('/portfolio');
  const holding = portfolio.holdings.find((h: any) => h.coinId === coinId);
  const poolAfter = await client.get(`/debug/pool/${coinId}`);
  const actualFinalPrice = poolAfter.usddReserve / poolAfter.coinReserve;

  lines.push(`Число выполненных сделок: ${requestedAmounts.length}.`);
  lines.push(`Реально потрачено USDD (по ответам сделок): ${usd(totalCharged)}.`);
  lines.push(`Получено монет: ${totalCoinsReceived.toFixed(2)} (${holding ? holding.pctEmission.toFixed(2) : '?'}% эмиссии по портфелю).`);
  lines.push(`Итоговая цена: ${actualFinalPrice}, итоговая капитализация всей эмиссии: ${usd(actualFinalPrice * supply)}.`);

  // Independent cross-check: replay the SAME sequence of requested amounts
  // through hand-written constant-product math (x*y=k), from the SAME
  // initial reserves — not by calling the engine's own buyWithUsdd.
  let x = x0;
  let y = y0;
  let shadowCoins = 0;
  for (const amountUsdd of requestedAmounts) {
    const netIn = amountUsdd * (1 - feePct);
    const newY = y + netIn;
    const newX = k0 / newY;
    shadowCoins += x - newX;
    x = newX;
    y = newY;
  }
  const shadowFinalPrice = y / x;
  const coinsDeviationPct = shadowCoins > 0 ? (Math.abs(totalCoinsReceived - shadowCoins) / shadowCoins) * 100 : 0;
  const priceDeviationPct = (Math.abs(actualFinalPrice - shadowFinalPrice) / shadowFinalPrice) * 100;
  lines.push(`Независимый расчёт вручную (x*y=k от тех же исходных резервов и тех же запрошенных сумм): ${shadowCoins.toFixed(2)} монет, цена ${shadowFinalPrice}.`);
  lines.push(`Отклонение от независимого расчёта: монеты ${coinsDeviationPct.toFixed(3)}%, цена ${priceDeviationPct.toFixed(3)}% (допуск 3%).`);

  if (coinsDeviationPct > 3 || priceDeviationPct > 3) {
    pass = false;
    lines.push('  ПРОВАЛ: отклонение от честной математики constant-product AMM превышает допуск.');
  }
  if (!holding || holding.pctEmission < 60 || holding.pctEmission > 70) {
    pass = false;
    lines.push(`  ПРОВАЛ: итоговая доля эмиссии ${holding?.pctEmission?.toFixed(2)}% вне целевого диапазона 60-70%.`);
  }

  return {
    outcome: {
      pass,
      lines,
      note:
        'Тестовый баланс выдан напрямую через /debug/grant-balance (недоступно вне dev-режима) — в игре нет честного способа быстро накопить нужную сумму, а цель теста — математика AMM, не экономика набора капитала. Допуск в 3% на сравнение с независимым расчётом учитывает фоновый рыночный дрейф, идущий в реальном времени между последовательными HTTP-вызовами сделок (сервер не приостанавливается на время теста).',
    },
    coinId,
    client,
    originalPool,
  };
}

export async function test5_sellBackSlippage(
  client: Client,
  coinId: string,
  originalPool: { coinReserve: number; usddReserve: number; playerOwnedCoins: number } | null
): Promise<TestOutcome> {
  const portfolioBefore = await client.get('/portfolio');
  const holding = portfolioBefore.holdings.find((h: any) => h.coinId === coinId);
  if (!holding || holding.amount <= 0) {
    return { pass: false, lines: ['ПРОВАЛ: у тестового игрока нет позиции по этой монете — тест 5 зависит от результата теста 4.'] };
  }

  const priceBefore = holding.currentPrice;
  const sellAmount = holding.amount * 0.9;
  const result = await client.post('/trade', { coinId, side: 'sell', amountCoin: sellAmount });

  const actualCoinsSold = result.coinAmount; // may be capped below sellAmount by the pool's single-trade reserve guard
  const naiveExpected = actualCoinsSold * priceBefore;
  const slippagePct = (result.usddAmount / naiveExpected - 1) * 100;

  const lines: string[] = [];
  lines.push(
    `Продано ${actualCoinsSold.toFixed(2)} монет (запрошено ${sellAmount.toFixed(2)}${actualCoinsSold < sellAmount * 0.999 ? ', ограничено защитой пула от слишком большой единичной сделки' : ''}).`
  );
  lines.push(`"Наивная" оценка (цена до сделки × фактически проданное количество): ${usd(naiveExpected)}.`);
  lines.push(`Реально получено: ${usd(result.usddAmount)}.`);
  lines.push(`Проскальзывание: ${slippagePct.toFixed(2)}% (ожидается заметно хуже наивной оценки).`);

  let pass = true;
  if (slippagePct > -3) {
    pass = false;
    lines.push('  ПРОВАЛ: проскальзывание меньше 3% по модулю — не похоже на честную AMM-кривую для такой крупной позиции.');
  }

  // Put the coin's pool back where tests 4-5 found it — tests 4-5 make real,
  // large trades on purpose, but nothing later needs the resulting position
  // to persist, and leaving it permanently ~65%-captured would exhaust
  // EMISSION_CAPTURE_CANDIDATES over repeated runs of this suite against the
  // same shared dev server.
  if (originalPool) {
    await client.post('/debug/restore-pools', { pools: { [coinId]: originalPool } });
    lines.push(`Резерв пула ${coinId} восстановлен до состояния перед тестом 4.`);
  }

  return { pass, lines };
}

// ---------------------------------------------------------------------------
// Test 6: news ramp smoothness — uses REAL wall-clock waiting on purpose
// (ramp is 8-20 real seconds, cheap to actually wait out, and the point of
// this specific test is the live timing behavior, not just the math).
// ---------------------------------------------------------------------------

export async function test6_newsSmoothness(client: Client): Promise<TestOutcome> {
  const lines: string[] = [];
  let pass = true;
  const strengths: ('weak' | 'medium' | 'strong')[] = ['weak', 'medium', 'strong'];

  for (const strength of strengths) {
    const before = await client.get('/coins');
    const baseline = before.coins.find((c: any) => c.id === 'btcr').price;

    await client.post('/debug/force-news', { direction: 'positive', strength });

    const pollDurationSec = 25;
    const samples: { t: number; price: number }[] = [{ t: 0, price: baseline }];
    for (let t = 1; t <= pollDurationSec; t++) {
      await sleep(1000);
      const snap = await client.get('/coins');
      samples.push({ t, price: snap.coins.find((c: any) => c.id === 'btcr').price });
    }

    const finalPrice = samples[samples.length - 1].price;
    const totalMovePct = (finalPrice / baseline - 1) * 100;
    let tReach95 = pollDurationSec;
    if (totalMovePct !== 0) {
      for (const s of samples) {
        const fracDone = ((s.price / baseline - 1) * 100) / totalMovePct;
        if (fracDone >= 0.95) {
          tReach95 = s.t;
          break;
        }
      }
    }

    const firstSecondMovePct = (samples[1].price / baseline - 1) * 100;
    lines.push(
      `Сила "${strength}": итоговое изменение ${pct(totalMovePct)}, изменение за первую секунду ${pct(firstSecondMovePct)}, время до 95% полного изменения: ${tReach95}с.`
    );
    if (tReach95 < 3) {
      pass = false;
      lines.push('  ПРОВАЛ: изменение почти полностью произошло меньше чем за 3 секунды — похоже на телепортацию цены.');
    }
    await sleep(3000); // buffer before the next strength
  }

  return {
    pass,
    lines,
    note: 'Тест намеренно ждёт реальное время (не использует fast-forward) — здесь важна именно живая тайминговая характеристика ramp-а, а не просто факт математики.',
  };
}

// ---------------------------------------------------------------------------
// Test 7: 100% slider under a moving/active phase.
// ---------------------------------------------------------------------------

export async function test7_fullSliderUnderMovement(makeTestClient: (tag: string) => Client): Promise<TestOutcome> {
  const client = makeTestClient('slider100');
  const lines: string[] = [];
  let pass = true;

  await client.post('/debug/phase', { phase: 'euphoria' }); // shared market state — highest-volatility phase
  await client.post('/debug/grant-balance', { amount: 5000 });

  const coinId = 'zph'; // small_alt: enough volatility, ample pool liquidity relative to these small trade sizes
  const ROUNDS = 15; // 15 buy + 15 sell = 30 trades total
  let successes = 0;
  const failureDetails: string[] = [];
  const observedPrices: number[] = [];

  for (let i = 0; i < ROUNDS; i++) {
    const portfolio = await client.get('/portfolio');
    const balance = portfolio.usddBalance;
    const buyRes = await client.tryPost('/trade', { coinId, side: 'buy', amountUsdd: balance });
    if (buyRes.status === 200) {
      successes++;
      if (buyRes.body?.priceAfter) observedPrices.push(buyRes.body.priceAfter);
    } else {
      failureDetails.push(`покупка #${i}: HTTP ${buyRes.status} ${JSON.stringify(buyRes.body)}`);
    }

    const sellRes = await client.tryPost('/trade', { coinId, side: 'sell', useMax: true });
    if (sellRes.status === 200) {
      successes++;
      if (sellRes.body?.priceAfter) observedPrices.push(sellRes.body.priceAfter);
    } else {
      failureDetails.push(`продажа #${i}: HTTP ${sellRes.status} ${JSON.stringify(sellRes.body)}`);
    }
  }

  const total = ROUNDS * 2;
  lines.push(`Выполнено сделок по 100% доступного остатка: ${total} (${ROUNDS} покупок + ${ROUNDS} продаж) во время принудительной фазы "euphoria".`);
  lines.push(`Успешных: ${successes}/${total}.`);
  if (observedPrices.length > 1) {
    const min = Math.min(...observedPrices);
    const max = Math.max(...observedPrices);
    lines.push(`Диапазон наблюдаемой цены за время теста: ${min} … ${max} (движение ${(((max - min) / min) * 100).toFixed(2)}%) — подтверждает, что рынок реально двигался.`);
  }
  if (successes !== total) {
    pass = false;
    lines.push('  ПРОВАЛ: как минимум одна попытка на 100% остатка отклонена:');
    for (const d of failureDetails) lines.push(`    ${d}`);
  }
  return { pass, lines };
}
