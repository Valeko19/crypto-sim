// Diagnostic: measures real per-tick component contributions for BTCR across
// full phases, to find what's actually producing near-vertical multi-candle
// jumps and long same-color streaks reported on prod. Imports the engine
// directly (no HTTP/server needed) so it can inspect state.coins.btcr.lastTick
// after every single tick, not just what a debug endpoint samples.
import { createInitialState } from '../src/engine/state.js';
import { tick, forcePhase } from '../src/engine/tick.js';
import { MacroPhase } from '../src/engine/macroCycle.js';
import { price } from '../src/engine/amm.js';

const PHASES: MacroPhase[] = ['accumulation', 'early_bull', 'bull', 'euphoria', 'bear'];
const SINGLE_TICK_THRESHOLD = 5; // %, flag ticks moving more than this
const FEW_CANDLE_WINDOW = 30; // 3 candles worth of ticks
const FEW_CANDLE_THRESHOLD = 15; // %, flag 3-candle windows moving more than this

function componentBreakdownStr(lt: any): string {
  return `macro=${lt.macroDriftPct.toFixed(3)} local=${lt.localDriftPct.toFixed(3)} baseNoise=${lt.baseNoisePct.toFixed(3)} relNoise=${lt.relativeNoisePct.toFixed(3)} stumble=${lt.stumblePct.toFixed(3)} gravity=${lt.gravityPct.toFixed(3)} news=${lt.newsPct.toFixed(3)} total=${lt.totalPct.toFixed(3)}`;
}

function dominantComponent(lt: any): string {
  const parts: [string, number][] = [
    ['macro/homing', lt.macroDriftPct],
    ['local', lt.localDriftPct],
    ['baseNoise', lt.baseNoisePct],
    ['relativeNoise', lt.relativeNoisePct],
    ['stumble', lt.stumblePct],
    ['gravity', lt.gravityPct],
    ['news', lt.newsPct],
  ];
  parts.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  return parts[0][0];
}

const TRIALS = 15;
const COMPONENT_KEYS = ['macroDriftPct', 'localDriftPct', 'baseNoisePct', 'relativeNoisePct', 'stumblePct', 'gravityPct', 'newsPct'] as const;

for (const phase of PHASES) {
  let singleTickExtremesTotal = 0;
  let ticksTotal = 0;
  let fewCandleExtremesTotal = 0;
  let windowsTotal = 0;
  const dominantCounts: Record<string, number> = {};
  let maxSingleTick = 0;
  let maxSingleTickBreakdown = '';
  let maxFewCandleMove = 0;
  let maxFewCandleComponentSums: Record<string, number> | null = null;
  let maxStreakOverall = 0;
  const streakHistogram: Record<string, number> = { '<=3': 0, '4-6': 0, '7-9': 0, '10-14': 0, '15+': 0 };

  for (let trial = 0; trial < TRIALS; trial++) {
    const state = createInitialState();
    forcePhase(state, phase);
    const btcr = state.coins['btcr'];

    const priceWindow: number[] = [];
    const breakdownWindow: any[] = [];
    let trialMaxStreak = 0;

    const totalTicks = state.macroPhaseEndTick - state.macroPhaseStartTick;
    const ticksToRun = Math.round(totalTicks * 1.05);
    ticksTotal += ticksToRun;

    for (let i = 0; i < ticksToRun; i++) {
      tick(state);
      if (btcr.sameColorStreak > trialMaxStreak) trialMaxStreak = btcr.sameColorStreak;
      const lt = { ...btcr.lastTick };
      priceWindow.push(price(btcr.pool));
      breakdownWindow.push(lt);
      if (priceWindow.length > FEW_CANDLE_WINDOW) {
        priceWindow.shift();
        breakdownWindow.shift();
      }

      if (Math.abs(lt.totalPct) > SINGLE_TICK_THRESHOLD) {
        singleTickExtremesTotal++;
        const dom = dominantComponent(lt);
        dominantCounts[dom] = (dominantCounts[dom] ?? 0) + 1;
        if (Math.abs(lt.totalPct) > Math.abs(maxSingleTick)) {
          maxSingleTick = lt.totalPct;
          maxSingleTickBreakdown = componentBreakdownStr(lt);
        }
      }

      if (priceWindow.length === FEW_CANDLE_WINDOW) {
        windowsTotal++;
        const movePct = (priceWindow[priceWindow.length - 1] / priceWindow[0] - 1) * 100;
        if (Math.abs(movePct) > FEW_CANDLE_THRESHOLD) {
          fewCandleExtremesTotal++;
          if (Math.abs(movePct) > Math.abs(maxFewCandleMove)) {
            maxFewCandleMove = movePct;
            const sums: Record<string, number> = {};
            for (const key of COMPONENT_KEYS) sums[key] = breakdownWindow.reduce((s, b) => s + b[key], 0);
            maxFewCandleComponentSums = sums;
          }
        }
      }
    }

    if (trialMaxStreak > maxStreakOverall) maxStreakOverall = trialMaxStreak;
    const bucket = trialMaxStreak <= 3 ? '<=3' : trialMaxStreak <= 6 ? '4-6' : trialMaxStreak <= 9 ? '7-9' : trialMaxStreak <= 14 ? '10-14' : '15+';
    streakHistogram[bucket]++;
  }

  console.log(`\n=== Фаза: ${phase} (${TRIALS} прогонов, ~${(ticksTotal / TRIALS / 60).toFixed(1)} мин каждый) ===`);
  console.log(`Одиночных тиков с |move| > ${SINGLE_TICK_THRESHOLD}%: ${singleTickExtremesTotal} из ${ticksTotal} (${((singleTickExtremesTotal / ticksTotal) * 100).toFixed(3)}%)`);
  if (singleTickExtremesTotal > 0) {
    console.log(`  Доминирующий компонент среди них:`, dominantCounts);
    console.log(`  Максимальный одиночный скачок: ${maxSingleTick.toFixed(2)}%`);
    console.log(`  Разбивка на тике максимума: ${maxSingleTickBreakdown}`);
  }
  console.log(`3-свечных (30-тиковых) окон с |move| > ${FEW_CANDLE_THRESHOLD}%: ${fewCandleExtremesTotal} из ${windowsTotal} (${((fewCandleExtremesTotal / windowsTotal) * 100).toFixed(2)}%)`);
  console.log(`  Максимальное 3-свечное движение: ${maxFewCandleMove.toFixed(2)}%`);
  if (maxFewCandleComponentSums) {
    console.log(`  Сумма вклада каждого компонента по тикам ЭТОГО окна (30 тиков):`);
    for (const key of COMPONENT_KEYS) {
      console.log(`    ${key}: ${maxFewCandleComponentSums[key].toFixed(3)}`);
    }
  }
  console.log(`Максимальная однотонная серия свечей (за ${TRIALS} прогонов): ${maxStreakOverall}`);
  console.log(`  Распределение по прогонам (макс. серия в каждом):`, streakHistogram);
}
