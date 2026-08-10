export const DAILY_BONUS_AMOUNT = 50;

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
