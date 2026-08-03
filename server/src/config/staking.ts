// Staking is the one place in the project measured in REAL time (Date.now() /
// TIMESTAMPTZ), not game ticks — same idiom the daily-bonus 24h check already
// uses in routes.ts, deliberately not tied to the macro-cycle clock at all.

export const STAKING_FLEXIBLE_MULTIPLIER = 1;
export const STAKING_LOCKED_MULTIPLIER = 2.5; // "заметно выше" than flexible — tuned/verified, not hardcoded blindly

export const STAKING_LOCK_DURATION_MS = 2 * 24 * 60 * 60 * 1000; // 2 real days
export const STAKING_FLEXIBLE_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 real hours after requesting unstake

// Guaranteed minimum: ~4%/year on the staked USD value, paid out continuously
// via the distribution job below — small but never zero even with zero trades.
export const STAKING_GUARANTEED_RATE_PER_MS = 0.04 / (365 * 24 * 60 * 60 * 1000);

export const STAKING_DISTRIBUTION_INTERVAL_MS = 30_000;

export type StakingMode = 'flexible' | 'locked';
