// Staking is the one place in the project measured in REAL time (Date.now() /
// TIMESTAMPTZ), not game ticks — same idiom the daily-bonus 24h check already
// uses in routes.ts, deliberately not tied to the macro-cycle clock at all.

// Fixed APR, same for every coin regardless of trading volume/category —
// doubling as a flexible/locked reward multiplier (locked pays more for
// giving up early access).
export const STAKING_FLEXIBLE_APR = 0.50; // 50%/year
export const STAKING_LOCKED_APR = 0.50; // 50%/year

export const STAKING_LOCK_DURATION_MS = 5 * 24 * 60 * 60 * 1000; // 5 real days
export const STAKING_FLEXIBLE_COOLDOWN_MS = 1 * 60 * 60 * 1000; // 1 real hour after requesting unstake

export const STAKING_DISTRIBUTION_INTERVAL_MS = 30_000;

export type StakingMode = 'flexible' | 'locked';
