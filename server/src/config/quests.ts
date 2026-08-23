export const DAILY_BONUS_AMOUNT = 500;

// Daily trading-turnover quest: reach this much cumulative buy+sell volume in
// the current calendar day (see engine/dailyVolume.ts) to unlock the reward,
// claimable at most once per 24h — same cooldown mechanics as DAILY_BONUS_AMOUNT.
export const DAILY_VOLUME_THRESHOLD = 1_000;
export const DAILY_VOLUME_REWARD = 500;

export interface EmissionThreshold {
  threshold: number; // percent
  reward: number; // USDD
}

export const EMISSION_THRESHOLDS: EmissionThreshold[] = [
  { threshold: 1, reward: 200 },
  { threshold: 5, reward: 1_000 },
  { threshold: 10, reward: 5_000 },
  { threshold: 30, reward: 20_000 },
  { threshold: 50, reward: 100_000 },
];
