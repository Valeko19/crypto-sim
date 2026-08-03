export const DAILY_BONUS_AMOUNT = 50;

export interface EmissionThreshold {
  threshold: number; // percent
  reward: number; // USDD
}

export const EMISSION_THRESHOLDS: EmissionThreshold[] = [
  { threshold: 0.1, reward: 5_000 },
  { threshold: 1, reward: 15_000 },
  { threshold: 5, reward: 200_000 },
  { threshold: 10, reward: 500_000 },
  { threshold: 30, reward: 5_000_000 },
  { threshold: 50, reward: 20_000_000 },
];
