export interface RankDef {
  name: string;
  min: number;
  max: number; // Infinity for the top rank
}

export const RANKS: RankDef[] = [
  { name: 'Планктон', min: 0, max: 1_000 },
  { name: 'Креветка', min: 1_000, max: 10_000 },
  { name: 'Краб', min: 10_000, max: 50_000 },
  { name: 'Осьминог', min: 50_000, max: 250_000 },
  { name: 'Дельфин', min: 250_000, max: 1_000_000 },
  { name: 'Акула', min: 1_000_000, max: 10_000_000 },
  { name: 'Касатка', min: 10_000_000, max: 100_000_000 },
  { name: 'Кит', min: 100_000_000, max: 1_000_000_000 },
  { name: 'Кракен', min: 1_000_000_000, max: Infinity },
];

// One-time bonus paid the FIRST time a player's net worth ever reaches each
// rank — indexed 1:1 with RANKS above. Планктон (index 0) has none; it's the
// starting rank, not something "reached". Player's own highest-ever league
// index is tracked separately (see db: player_rank_progress) specifically so
// this can't be farmed by oscillating net worth back and forth across a
// boundary — only ever compared against the peak, never the live value.
export const RANK_UP_REWARDS: number[] = [
  0, // Планктон
  200, // Креветка
  2_000, // Краб
  10_000, // Осьминог
  50_000, // Дельфин
  200_000, // Акула
  2_000_000, // Касатка
  20_000_000, // Кит
  200_000_000, // Кракен
];

export function rankForNetWorth(netWorth: number): RankDef {
  for (const r of RANKS) {
    if (netWorth >= r.min && netWorth < r.max) return r;
  }
  return RANKS[RANKS.length - 1];
}

export function leagueIndex(name: string): number {
  return RANKS.findIndex(r => r.name === name);
}
