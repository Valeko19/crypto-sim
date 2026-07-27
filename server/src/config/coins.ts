export type CoinCategory = 'top1' | 'big_alt' | 'small_alt' | 'meme';

export interface CoinConfig {
  id: string; // lowercase ticker, used as DB id
  symbol: string;
  name: string;
  category: CoinCategory;
  emission: number; // total supply
  startPrice: number; // fundamental/starting price in USDD
  npcLockedPct: number; // fraction of emission permanently unreachable
  volPerMinPct: [number, number]; // base volatility %/min range, category-flavored per coin
  macroCorrelation: number; // 0..1, how much of this coin's drift is macro-driven vs its own local cycle (unanimity)
  beta: number; // amplification applied to the macro-driven portion — alts/memes swing harder than the leader, not just a fraction of it
  localCycleMinMin: number;
  localCycleMaxMin: number;
}

// UI section grouping (design has 3 sections: Топ 1 / Альткоины / Мемкоины)
export function sectionOf(category: CoinCategory): 'top1' | 'alt' | 'meme' {
  if (category === 'top1') return 'top1';
  if (category === 'meme') return 'meme';
  return 'alt';
}

export const COINS: CoinConfig[] = [
  {
    id: 'btcr', symbol: 'BTCR', name: 'Bitcore', category: 'top1',
    emission: 20_000_000, startPrice: 100_000, npcLockedPct: 0.75,
    volPerMinPct: [0.3, 0.7], macroCorrelation: 1, beta: 1, localCycleMinMin: 0, localCycleMaxMin: 0,
  },
  {
    id: 'etn', symbol: 'ETN', name: 'Etherna', category: 'big_alt',
    emission: 120_000_000, startPrice: 3_000, npcLockedPct: 0.55,
    volPerMinPct: [0.8, 1.6], macroCorrelation: 0.9, beta: 1.5, localCycleMinMin: 15, localCycleMaxMin: 60,
  },
  {
    id: 'vlr', symbol: 'VLR', name: 'Velora', category: 'big_alt',
    emission: 550_000_000, startPrice: 150, npcLockedPct: 0.55,
    volPerMinPct: [1.0, 2.0], macroCorrelation: 0.9, beta: 1.5, localCycleMinMin: 15, localCycleMaxMin: 55,
  },
  {
    id: 'arc', symbol: 'ARC', name: 'Arca', category: 'small_alt',
    emission: 140_000_000, startPrice: 500, npcLockedPct: 0.45,
    volPerMinPct: [1.5, 3.0], macroCorrelation: 0.85, beta: 1.7, localCycleMinMin: 12, localCycleMaxMin: 45,
  },
  {
    id: 'zph', symbol: 'ZPH', name: 'Zephyr', category: 'small_alt',
    emission: 200_000_000, startPrice: 1.5, npcLockedPct: 0.42,
    volPerMinPct: [1.8, 3.5], macroCorrelation: 0.85, beta: 1.8, localCycleMinMin: 12, localCycleMaxMin: 40,
  },
  {
    id: 'prsm', symbol: 'PRSM', name: 'Prism', category: 'small_alt',
    emission: 300_000_000, startPrice: 0.6, npcLockedPct: 0.4,
    volPerMinPct: [2.0, 4.0], macroCorrelation: 0.85, beta: 1.9, localCycleMinMin: 10, localCycleMaxMin: 35,
  },
  {
    id: 'embr', symbol: 'EMBR', name: 'Ember', category: 'meme',
    emission: 600_000_000, startPrice: 0.05, npcLockedPct: 0.3,
    volPerMinPct: [3.0, 6.0], macroCorrelation: 0.8, beta: 2.1, localCycleMinMin: 10, localCycleMaxMin: 30,
  },
  {
    id: 'wlmb', symbol: 'WLMB', name: 'Wolomb', category: 'meme',
    emission: 1_200_000_000_000, startPrice: 0.000004, npcLockedPct: 0.2,
    volPerMinPct: [3.5, 7.0], macroCorrelation: 0.8, beta: 2.2, localCycleMinMin: 10, localCycleMaxMin: 30,
  },
  {
    id: 'hmst', symbol: 'HMST', name: 'Hamsti', category: 'meme',
    emission: 164_000_000, startPrice: 0.0001, npcLockedPct: 0.28,
    volPerMinPct: [4.0, 7.5], macroCorrelation: 0.78, beta: 2.3, localCycleMinMin: 8, localCycleMaxMin: 25,
  },
  {
    id: 'dogx', symbol: 'DOGX', name: 'Dogex', category: 'meme',
    emission: 140_000_000_000, startPrice: 0.0000009, npcLockedPct: 0.3,
    volPerMinPct: [4.5, 8.0], macroCorrelation: 0.78, beta: 2.4, localCycleMinMin: 8, localCycleMaxMin: 25,
  },
  {
    id: 'pepz', symbol: 'PEPZ', name: 'Pepzy', category: 'meme',
    emission: 420_000_000_000, startPrice: 0.00000005, npcLockedPct: 0.32,
    volPerMinPct: [5.0, 8.0], macroCorrelation: 0.78, beta: 2.5, localCycleMinMin: 8, localCycleMaxMin: 20,
  },
];

export const COIN_MAP: Record<string, CoinConfig> = Object.fromEntries(COINS.map(c => [c.id, c]));

export const TRADE_FEE_PCT = 0.002; // 0.2% per trade
export const MIN_TRADE_USDD = 1;
