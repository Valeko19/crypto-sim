export const DAILY_BONUS_AMOUNT = 50;

// Daily trading-turnover quest: reach this much cumulative buy+sell volume in
// the current calendar day (see engine/dailyVolume.ts) to unlock the reward,
// claimable at most once per 24h — same cooldown mechanics as DAILY_BONUS_AMOUNT.
export const DAILY_VOLUME_THRESHOLD = 1_000;
export const DAILY_VOLUME_REWARD = 100;

export interface EmissionThreshold {
  threshold: number; // percent
  reward: number; // USDD
}

export const EMISSION_THRESHOLDS: EmissionThreshold[] = [
  { threshold: 1, reward: 500 },
  { threshold: 5, reward: 2_500 },
  { threshold: 10, reward: 5_000 },
  { threshold: 30, reward: 15_000 },
  { threshold: 50, reward: 50_000 },
];
