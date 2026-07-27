import { EngineState } from '../engine/state.js';
import { price } from '../engine/amm.js';
import { COIN_MAP } from '../config/coins.js';
import { rankForNetWorth, leagueIndex, RANKS } from '../config/ranks.js';
import { getHoldings, getPlayer, listNpcBots, LOCAL_PLAYER_ID } from '../db/queries.js';

export interface HoldingView {
  coinId: string;
  symbol: string;
  name: string;
  amount: number;
  value: number;
  pctEmission: number;
  pnlPct: number;
  avgBuyPrice: number;
  currentPrice: number;
}

export interface PortfolioView {
  usddBalance: number;
  holdings: HoldingView[];
  netWorth: number;
  rank: string;
  league: string;
  leagueIndex: number;
  tradesCount: number;
  totalVolume: number;
  realizedPnl: number;
}

export async function computePortfolio(state: EngineState, playerId: string): Promise<PortfolioView> {
  const player = await getPlayer(playerId);
  const holdingRows = await getHoldings(playerId);

  const holdings: HoldingView[] = holdingRows.map(h => {
    const cfg = COIN_MAP[h.coin_id];
    const currentPrice = price(state.coins[h.coin_id].pool);
    const value = h.amount * currentPrice;
    return {
      coinId: h.coin_id,
      symbol: cfg.symbol,
      name: cfg.name,
      amount: h.amount,
      value,
      pctEmission: (h.amount / cfg.emission) * 100,
      pnlPct: h.avg_buy_price > 0 ? (currentPrice / h.avg_buy_price - 1) * 100 : 0,
      avgBuyPrice: h.avg_buy_price,
      currentPrice,
    };
  });

  const holdingsValue = holdings.reduce((sum, h) => sum + h.value, 0);
  const netWorth = player.usdd_balance + holdingsValue;
  const rank = rankForNetWorth(netWorth);

  return {
    usddBalance: player.usdd_balance,
    holdings,
    netWorth,
    rank: rank.name,
    league: rank.name,
    leagueIndex: leagueIndex(rank.name),
    tradesCount: player.trades_count,
    totalVolume: player.total_volume,
    realizedPnl: player.realized_pnl,
  };
}

export interface LeaderboardEntry {
  place: number;
  username: string;
  netWorth: number;
  isPlayer: boolean;
}

export async function computeLeaderboard(
  state: EngineState,
  leagueName: string
): Promise<{ entries: LeaderboardEntry[]; minCapital: number; totalPlayers: number }> {
  const bots = await listNpcBots();
  const leagueBots = bots.filter(b => b.league === leagueName);

  const portfolio = await computePortfolio(state, LOCAL_PLAYER_ID);
  const includesPlayer = portfolio.league === leagueName;

  const combined: { username: string; netWorth: number; isPlayer: boolean }[] = leagueBots.map(b => ({
    username: b.username,
    netWorth: b.simulated_net_worth,
    isPlayer: false,
  }));
  if (includesPlayer) {
    combined.push({ username: 'Вы', netWorth: portfolio.netWorth, isPlayer: true });
  }
  combined.sort((a, b) => b.netWorth - a.netWorth);

  const entries: LeaderboardEntry[] = combined.map((c, i) => ({ place: i + 1, ...c }));
  const rankDef = RANKS.find(r => r.name === leagueName)!;
  return { entries, minCapital: rankDef.min, totalPlayers: entries.length };
}

export function findEmissionLeader(state: EngineState, holdings: HoldingView[]): { coinId: string; pct: number } | null {
  if (holdings.length === 0) return null;
  let best = holdings[0];
  for (const h of holdings) {
    if (h.pctEmission > best.pctEmission) best = h;
  }
  return { coinId: best.coinId, pct: best.pctEmission };
}
