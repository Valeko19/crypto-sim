// Converts a target log-return, to be achieved over `ticks` ticks, into the
// "%/min" drift convention used throughout the tick loop. Shared by tick.ts
// (macro-phase homing correction) and news.ts (news-event ramp) — pulled out
// on its own so those two don't need to import each other just for this.
export function logReturnToDriftPctPerMin(logReturn: number, ticks: number): number {
  return (logReturn / Math.max(1, ticks)) * 100 * 60;
}
