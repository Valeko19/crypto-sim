// In-memory per-calendar-day trading-turnover tracker, mirroring the shop's
// daily-spend-limit pattern (api/shopState.ts) — same reasoning applies here:
// it only ever needs to answer "how much today", a server restart naturally
// resetting to 0 is fine, and it's not worth a DB table for that.
const volumeByPlayer = new Map<string, { day: string; volume: number }>();

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function recordTradeVolume(playerId: string, usddAmount: number): void {
  const day = today();
  const entry = volumeByPlayer.get(playerId);
  if (entry?.day === day) entry.volume += usddAmount;
  else volumeByPlayer.set(playerId, { day, volume: usddAmount });
}

export function todaysVolume(playerId: string): number {
  const entry = volumeByPlayer.get(playerId);
  return entry?.day === today() ? entry.volume : 0;
}
