export interface RankDef {
  name: string;
  min: number;
  max: number; // Infinity for the top rank
}

export const RANKS: RankDef[] = [
  { name: 'Планктон', min: 0, max: 500 },
  { name: 'Креветка', min: 500, max: 2_000 },
  { name: 'Краб', min: 2_000, max: 20_000 },
  { name: 'Осьминог', min: 20_000, max: 100_000 },
  { name: 'Дельфин', min: 100_000, max: 500_000 },
  { name: 'Акула', min: 500_000, max: 5_000_000 },
  { name: 'Касатка', min: 5_000_000, max: 50_000_000 },
  { name: 'Кит', min: 50_000_000, max: 500_000_000 },
  { name: 'Кракен', min: 500_000_000, max: Infinity },
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
