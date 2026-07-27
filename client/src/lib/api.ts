export interface CoinListItem {
  id: string;
  symbol: string;
  name: string;
  section: 'top1' | 'alt' | 'meme';
  price: number;
  marketCap: number;
  supply: number;
  change24hPct: number;
}

export interface MarketStatus {
  phase: string;
  phaseLabel: string;
  fearGreedIndex: number;
  fearGreedLabel: string;
  progressPct: number;
  elapsedSec: number;
  remainingSec: number;
  durationSec: number;
}

export interface Candle { t: number; o: number; h: number; l: number; c: number; }

export interface HoldingView {
  coinId: string; symbol: string; name: string; amount: number; value: number;
  pctEmission: number; pnlPct: number; avgBuyPrice: number; currentPrice: number;
}

export interface PortfolioView {
  usddBalance: number; holdings: HoldingView[]; netWorth: number; rank: string;
  league: string; leagueIndex: number; tradesCount: number; totalVolume: number; realizedPnl: number;
}

export interface QuestsView {
  dailyBonus: { amount: number; available: boolean; claimedAt: string | null };
  emissionCapture: {
    leaderCoinId: string | null; leaderSymbol: string | null; leaderPct: number;
    ladder: { threshold: number; reward: number; met: boolean; claimed: boolean; coinId: string; coinSymbol: string }[];
  };
}

export interface ShopStatus {
  packages: { id: string; usddAmount: number; stars: number; bonusPct: number; popular?: boolean }[];
  rate: number;
  remainingToday: number;
}

export interface LeaderboardEntry { place: number; username: string; netWorth: number; isPlayer: boolean; }
export interface LeaderboardView { league: string; entries: LeaderboardEntry[]; minCapital: number; totalPlayers: number; }
export interface RankInfo { name: string; min: number; max: number | null; }

async function req<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed: ${path}`);
  }
  return res.json();
}

export const api = {
  getCoins: () => req<{ coins: CoinListItem[]; marketStatus: MarketStatus }>('/coins'),
  getCandles: (coinId: string) => req<{ candles: Candle[] }>(`/coins/${coinId}/candles`),
  getPortfolio: () => req<PortfolioView>('/portfolio'),
  getQuests: () => req<QuestsView>('/quests'),
  claimQuest: (questId: string) => req<{ success: boolean; amount: number }>('/quests/claim', {
    method: 'POST', body: JSON.stringify({ questId }),
  }),
  getShopStatus: () => req<ShopStatus>('/shop/status'),
  purchaseShop: (starsAmount: number) => req<{ success: boolean; usddCredited: number; remainingToday: number }>('/shop/purchase', {
    method: 'POST', body: JSON.stringify({ starsAmount }),
  }),
  getLeaderboard: (league: string) => req<LeaderboardView>(`/leaderboard?league=${encodeURIComponent(league)}`),
  getRanks: () => req<{ ranks: RankInfo[] }>('/ranks'),
  quoteTrade: (body: { coinId: string; side: 'buy' | 'sell'; amountUsdd?: number; amountCoin?: number }) =>
    req<{ expectedCoinOut?: number; expectedUsddOut?: number; avgPrice: number; priceImpactPct: number; feeAmount: number }>(
      '/trade/quote', { method: 'POST', body: JSON.stringify(body) }
    ),
  trade: (body: { coinId: string; side: 'buy' | 'sell'; amountUsdd?: number; amountCoin?: number }) =>
    req<{ coinAmount: number; usddAmount: number; avgPrice: number; slippagePct: number; fee: number }>(
      '/trade', { method: 'POST', body: JSON.stringify(body) }
    ),
  forceDebugPhase: (phase: string) => req<{ success: boolean }>('/debug/phase', {
    method: 'POST', body: JSON.stringify({ phase }),
  }),
};
