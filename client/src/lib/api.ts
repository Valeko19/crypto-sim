import { getIdentityHeaders } from './telegram';

export interface CoinListItem {
  id: string;
  symbol: string;
  name: string;
  iconUrl: string;
  section: 'top1' | 'alt' | 'meme';
  price: number;
  marketCap: number;
  supply: number;
  changePct: number; // rolling change over the last few minutes, not 24h
}

export interface ActiveNews {
  headline: string;
  direction: 'positive' | 'negative';
  expiresAt: number;
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
  activeNews: ActiveNews | null;
}

export interface Candle { t: number; o: number; h: number; l: number; c: number; }

export interface HoldingView {
  coinId: string; symbol: string; name: string; iconUrl: string; amount: number; value: number;
  pctEmission: number; pnlPct: number; avgBuyPrice: number; currentPrice: number;
}

export interface PortfolioView {
  usddBalance: number; holdings: HoldingView[]; netWorth: number; rank: string;
  league: string; leagueIndex: number; tradesCount: number; totalVolume: number; realizedPnl: number;
  username: string;
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
  dailyLimit: number;
}

export interface TradingBotConfig {
  coinId: string; side: 'buy' | 'sell'; intervalMs: number; amount: number; enabled: boolean; nextRunAt: string | null;
}

export interface TradingBotStatus {
  config: TradingBotConfig | null;
}

export interface LeaderboardEntry { place: number; username: string; netWorth: number; isPlayer: boolean; }
export interface LeaderboardView { league: string; entries: LeaderboardEntry[]; minCapital: number; totalPlayers: number; }
export interface RankInfo { name: string; min: number; max: number | null; }

export type StakingMode = 'flexible' | 'locked';

export interface StakingPositionView {
  id: string;
  amount: number;
  mode: StakingMode;
  stakedAt: string;
  lockUntil: string | null;
  unstakeRequestedAt: string | null;
  unstakeAvailableAt: string | null;
  reserved: boolean;
  aprPct: number;
  pendingRewards: number;
}

export interface StakingCoinView {
  coinId: string; symbol: string; name: string; iconUrl: string; currentPrice: number;
  holdingAmount: number; sellableAmount: number;
  positions: StakingPositionView[]; pendingRewards: number;
}

// In local dev the Vite proxy forwards /api to the server on the same origin
// (see vite.config.ts), so this stays empty. Split-domain deploys (client on
// Vercel, server on Render/Railway/etc.) set VITE_API_BASE to the server's
// own URL at build time since there's no shared origin to proxy through.
export const API_BASE = import.meta.env.VITE_API_BASE ?? '';

async function req<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}/api${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...getIdentityHeaders(), ...options?.headers },
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
  purchaseShop: (starsAmount: number, packageId?: string) => req<{ success: boolean; usddCredited: number; remainingToday: number }>('/shop/purchase', {
    method: 'POST', body: JSON.stringify({ starsAmount, packageId }),
  }),
  getLeaderboard: (league: string) => req<LeaderboardView>(`/leaderboard?league=${encodeURIComponent(league)}`),
  getRanks: () => req<{ ranks: RankInfo[] }>('/ranks'),
  quoteTrade: (body: { coinId: string; side: 'buy' | 'sell'; amountUsdd?: number; amountCoin?: number }) =>
    req<{ expectedCoinOut?: number; expectedUsddOut?: number; avgPrice: number; priceImpactPct: number; feeAmount: number; feePct: number }>(
      '/trade/quote', { method: 'POST', body: JSON.stringify(body) }
    ),
  trade: (body: { coinId: string; side: 'buy' | 'sell'; amountUsdd?: number; amountCoin?: number }) =>
    req<{ coinAmount: number; usddAmount: number; avgPrice: number; slippagePct: number; fee: number }>(
      '/trade', { method: 'POST', body: JSON.stringify(body) }
    ),
  getStaking: () => req<{
    coins: StakingCoinView[];
    config: { flexibleAprPct: number; flexibleCooldownMs: number };
  }>('/staking'),
  stake: (coinId: string, amount: number) => req<{ success: boolean; position: StakingPositionView }>(
    '/staking/stake', { method: 'POST', body: JSON.stringify({ coinId, amount }) }
  ),
  requestUnstake: (positionId: string) => req<{ success: boolean; unstakeAvailableAt: string }>(
    '/staking/request-unstake', { method: 'POST', body: JSON.stringify({ positionId }) }
  ),
  withdrawStaking: (positionId: string) => req<{ success: boolean }>(
    '/staking/withdraw', { method: 'POST', body: JSON.stringify({ positionId }) }
  ),
  breakLock: (positionId: string) => req<{ success: boolean; amount: number }>(
    '/staking/break-lock', { method: 'POST', body: JSON.stringify({ positionId }) }
  ),
  claimStakingRewards: (coinId: string) => req<{ success: boolean; amount: number }>(
    '/staking/claim', { method: 'POST', body: JSON.stringify({ coinId }) }
  ),
  getBotStatus: () => req<TradingBotStatus>('/bot'),
  configureBot: (coinId: string, side: 'buy' | 'sell', intervalMs: number, amount: number) => req<{ success: boolean }>(
    '/bot/config', { method: 'POST', body: JSON.stringify({ coinId, side, intervalMs, amount }) }
  ),
  toggleBot: (enabled: boolean) => req<{ success: boolean }>(
    '/bot/toggle', { method: 'POST', body: JSON.stringify({ enabled }) }
  ),
};
