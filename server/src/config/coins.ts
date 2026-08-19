export type CoinCategory = 'top1' | 'big_alt' | 'small_alt' | 'meme';

export interface CoinConfig {
  id: string; // lowercase ticker, used as DB id — kept stable across rebrands so holdings/history never orphan
  symbol: string;
  name: string;
  iconUrl: string; // served from client/public, see /coins/*.png
  category: CoinCategory;
  emission: number; // total supply
  startPrice: number; // fundamental/starting price in USDD
  npcLockedPct: number; // fraction of emission permanently unreachable
  volPerMinPct: [number, number]; // base volatility %/min range, category-flavored per coin
  macroCorrelation: number; // 0..1, how much of this coin's drift is macro-driven vs its own local cycle (unanimity)
  beta: number; // amplification applied to the macro-driven portion — alts/memes swing harder than the leader, not just a fraction of it
  localCycleMinMin: number;
  localCycleMaxMin: number;
  feePctOverride?: number; // per-coin trade fee override; falls back to TRADE_FEE_PCT if unset
}

// UI section grouping (design has 3 sections: Топ 1 / Альткоины / Мемкоины)
export function sectionOf(category: CoinCategory): 'top1' | 'alt' | 'meme' {
  if (category === 'top1') return 'top1';
  if (category === 'meme') return 'meme';
  return 'alt';
}

export const COINS: CoinConfig[] = [
  {
    id: 'btcr', symbol: 'BITX', name: 'Bitrix', iconUrl: '/coins/01_bitrix_BITX.png', category: 'top1',
    emission: 20_000_000, startPrice: 40_000, npcLockedPct: 0.40,
    volPerMinPct: [0.3, 0.7], macroCorrelation: 1, beta: 1, localCycleMinMin: 0, localCycleMaxMin: 0,
  },
  {
    id: 'etn', symbol: 'VCTR', name: 'Vectra', iconUrl: '/coins/02_vectra_VCTR.png', category: 'big_alt',
    emission: 120_000_000, startPrice: 333.3333333, npcLockedPct: 0.30,
    volPerMinPct: [0.8, 1.6], macroCorrelation: 0.9, beta: 1.5, localCycleMinMin: 15, localCycleMaxMin: 60,
  },
  {
    id: 'vlr', symbol: 'QNTK', name: 'Quantik', iconUrl: '/coins/03_quantik_QNTK.png', category: 'big_alt',
    emission: 550_000_000, startPrice: 45.45454545, npcLockedPct: 0.28,
    volPerMinPct: [1.0, 2.0], macroCorrelation: 0.9, beta: 1.5, localCycleMinMin: 15, localCycleMaxMin: 55,
  },
  {
    id: 'arc', symbol: 'SBST', name: 'Substra', iconUrl: '/coins/04_substra_SBST.png', category: 'small_alt',
    emission: 140_000_000, startPrice: 0.75, npcLockedPct: 0.22,
    volPerMinPct: [1.5, 3.0], macroCorrelation: 0.85, beta: 1.7, localCycleMinMin: 12, localCycleMaxMin: 45,
  },
  {
    id: 'zph', symbol: 'AXON', name: 'Axion', iconUrl: '/coins/05_axion_AXON.png', category: 'small_alt',
    emission: 200_000_000, startPrice: 0.35, npcLockedPct: 0.20,
    volPerMinPct: [1.8, 3.5], macroCorrelation: 0.85, beta: 1.8, localCycleMinMin: 12, localCycleMaxMin: 40,
  },
  {
    id: 'prsm', symbol: 'RLAY', name: 'Relay', iconUrl: '/coins/06_relay_RLAY.png', category: 'small_alt',
    emission: 300_000_000, startPrice: 0.14, npcLockedPct: 0.18,
    volPerMinPct: [2.0, 4.0], macroCorrelation: 0.85, beta: 1.9, localCycleMinMin: 10, localCycleMaxMin: 35,
  },
  {
    id: 'embr', symbol: 'SLIP', name: 'Slippage', iconUrl: '/coins/10_slippage_SLIP.png', category: 'meme',
    emission: 600_000_000, startPrice: 0.00025, npcLockedPct: 0.14,
    volPerMinPct: [3.0, 6.0], macroCorrelation: 0.8, beta: 2.1, localCycleMinMin: 10, localCycleMaxMin: 30,
    feePctOverride: 0.05, // 5% — the coin's whole gimmick is high slippage/fees
  },
  {
    id: 'wlmb', symbol: 'HMFL', name: 'Hamsterfly', iconUrl: '/coins/07_hamsterfly_HMFL.png', category: 'meme',
    emission: 1_200_000_000_000, startPrice: 0.0000001458333333, npcLockedPct: 0.16,
    volPerMinPct: [3.5, 7.0], macroCorrelation: 0.8, beta: 2.2, localCycleMinMin: 10, localCycleMaxMin: 30,
  },
  {
    id: 'hmst', symbol: 'PSD', name: 'Poseidon', iconUrl: '/coins/08_poseidon_PSD.png', category: 'meme',
    emission: 164_000_000, startPrice: 0.001219512195, npcLockedPct: 0.17,
    volPerMinPct: [4.0, 7.5], macroCorrelation: 0.78, beta: 2.3, localCycleMinMin: 8, localCycleMaxMin: 25,
  },
  {
    id: 'dogx', symbol: 'FMRW', name: 'Fomorrow', iconUrl: '/coins/09_fomorrow_FMRW.png', category: 'meme',
    emission: 140_000_000_000, startPrice: 0.000001607142857, npcLockedPct: 0.18,
    volPerMinPct: [4.5, 8.0], macroCorrelation: 0.78, beta: 2.4, localCycleMinMin: 8, localCycleMaxMin: 25,
  },
  {
    id: 'pepz', symbol: 'KAZK', name: 'Kazik', iconUrl: '/coins/11_kazik_KAZK.png', category: 'meme',
    emission: 420_000_000_000, startPrice: 0.0000005952380952, npcLockedPct: 0.19,
    volPerMinPct: [5.0, 8.0], macroCorrelation: 0.78, beta: 2.5, localCycleMinMin: 8, localCycleMaxMin: 20,
  },
];

export const COIN_MAP: Record<string, CoinConfig> = Object.fromEntries(COINS.map(c => [c.id, c]));

export const TRADE_FEE_PCT = 0.01; // 1% per trade, unless the coin overrides it
export const MIN_TRADE_USDD = 1;

export function tradeFeePct(coinId: string): number {
  return COIN_MAP[coinId]?.feePctOverride ?? TRADE_FEE_PCT;
}
