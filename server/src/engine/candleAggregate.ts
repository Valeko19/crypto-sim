import { Candle } from './state.js';
import { CANDLE_INTERVAL_MS } from './state.js';

// Chart timeframes: 10s is the raw base candle (see state.ts), 30s/1m are
// built by grouping consecutive base candles — never stored separately, only
// computed on request, so a client switching timeframes gets pre-aggregated
// candles instead of the whole raw history to aggregate itself.
export type ChartTimeframe = '10s' | '30s' | '1m';

const TIMEFRAME_GROUP_SIZE: Record<ChartTimeframe, number> = {
  '10s': 1,
  '30s': 3,
  '1m': 6,
};

export function isChartTimeframe(value: string): value is ChartTimeframe {
  return value in TIMEFRAME_GROUP_SIZE;
}

// Groups are anchored to each candle's OWN timestamp (all base candles sit on
// an exact, gapless CANDLE_INTERVAL_MS grid — see updateCandle in tick.ts),
// not to array position — array position drifts as the oldest candles get
// evicted (see MAX_CANDLES), which would otherwise make the grouping
// boundaries silently shift by up to (groupSize-1) candles over time. The
// very first group in the result can be a short/partial one if the buffer's
// oldest surviving candle doesn't happen to fall exactly on a group boundary
// — that's expected, there's simply no older data to fill it with.
export function aggregateCandles(candles: Candle[], timeframe: ChartTimeframe): Candle[] {
  const groupSize = TIMEFRAME_GROUP_SIZE[timeframe];
  if (groupSize <= 1 || candles.length === 0) return candles;

  const groupSpanMs = groupSize * CANDLE_INTERVAL_MS;
  const result: Candle[] = [];
  let i = 0;
  while (i < candles.length) {
    const groupStartBucket = Math.floor(candles[i].t / groupSpanMs) * groupSpanMs;
    const groupEndBucket = groupStartBucket + groupSpanMs;
    const start = i;
    while (i < candles.length && candles[i].t < groupEndBucket) i++;
    const group = candles.slice(start, i);
    result.push({
      t: group[0].t,
      o: group[0].o,
      c: group[group.length - 1].c,
      h: Math.max(...group.map(g => g.h)),
      l: Math.min(...group.map(g => g.l)),
    });
  }
  return result;
}
