import { EngineState } from '../engine/state.js';
import { price } from '../engine/amm.js';
import { COINS, COIN_MAP } from '../config/coins.js';
import { rankForNetWorth, leagueIndex, RANKS } from '../config/ranks.js';
import {
  getHoldings, getAllHoldings, getPlayer, getAllPlayers, listNpcBots, PlayerRow, HoldingRow,
  getStakingPositions, isPositionReserved, effectiveApr,
} from '../db/queries.js';

export interface HoldingView {
  coinId: string;
  symbol: string;
  name: string;
  iconUrl: string;
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
  username: string;
}

function buildPortfolioView(state: EngineState, player: PlayerRow, holdingRows: HoldingRow[]): PortfolioView {
  const holdings: HoldingView[] = holdingRows.map(h => {
    const cfg = COIN_MAP[h.coin_id];
    const currentPrice = price(state.coins[h.coin_id].pool);
    const value = h.amount * currentPrice;
    return {
      coinId: h.coin_id,
      symbol: cfg.symbol,
      name: cfg.name,
      iconUrl: cfg.iconUrl,
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
    username: player.username,
  };
}

export async function computePortfolio(state: EngineState, playerId: string): Promise<PortfolioView> {
  const player = await getPlayer(playerId);
  const holdingRows = await getHoldings(playerId);
  return buildPortfolioView(state, player, holdingRows);
}

// One pass over ALL players — 2 DB queries regardless of player count, instead
// of 2 queries PER player. Used by the tick loop (every connected player's
// portfolio push, once a second) and the leaderboard, both of which need
// every player's view at once — the per-player computePortfolio above would
// turn either into an O(players) query storm against PGlite's single
// embedded connection.
export async function computeAllPortfolios(state: EngineState): Promise<Map<string, PortfolioView>> {
  const players = await getAllPlayers();
  const allHoldings = await getAllHoldings();
  const holdingsByPlayer = new Map<string, HoldingRow[]>();
  for (const h of allHoldings) {
    const list = holdingsByPlayer.get(h.player_id) ?? [];
    list.push(h);
    holdingsByPlayer.set(h.player_id, list);
  }
  const result = new Map<string, PortfolioView>();
  for (const p of players) {
    result.set(p.id, buildPortfolioView(state, p, holdingsByPlayer.get(p.id) ?? []));
  }
  return result;
}

export interface LeaderboardEntry {
  place: number;
  username: string;
  netWorth: number;
  isPlayer: boolean;
}

export async function computeLeaderboard(
  state: EngineState,
  leagueName: string,
  viewerPlayerId: string
): Promise<{ entries: LeaderboardEntry[]; minCapital: number; totalPlayers: number }> {
  const bots = await listNpcBots();
  const leagueBots = bots.filter(b => b.league === leagueName);

  const portfolios = await computeAllPortfolios(state);
  const realEntries = [...portfolios.entries()]
    .filter(([, v]) => v.league === leagueName)
    .map(([id, v]) => ({ username: v.username, netWorth: v.netWorth, isPlayer: id === viewerPlayerId }));

  const combined: { username: string; netWorth: number; isPlayer: boolean }[] = [
    ...leagueBots.map(b => ({ username: b.username, netWorth: b.simulated_net_worth, isPlayer: false })),
    ...realEntries,
  ];
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

export interface StakingPositionView {
  id: string;
  amount: number;
  mode: 'flexible' | 'locked';
  stakedAt: string;
  lockUntil: string | null;
  unstakeRequestedAt: string | null;
  unstakeAvailableAt: string | null;
  reserved: boolean; // still locked-in / cooling down — can't sell or withdraw
  aprPct: number;
  pendingRewards: number;
}

export interface StakingCoinView {
  coinId: string;
  symbol: string;
  name: string;
  iconUrl: string;
  currentPrice: number;
  holdingAmount: number;
  sellableAmount: number;
  positions: StakingPositionView[];
  pendingRewards: number; // claimable now — flexible positions only, see claimFlexibleCoinRewards
}

export async function computeStaking(state: EngineState, playerId: string): Promise<StakingCoinView[]> {
  const holdingRows = await getHoldings(playerId);
  const holdingByCoinId = new Map(holdingRows.map(h => [h.coin_id, h.amount]));
  const playerPositions = await getStakingPositions(playerId);
  const now = Date.now();

  const result: StakingCoinView[] = [];
  for (const cfg of COINS) {
    const positionsForCoin = playerPositions.filter(p => p.coin_id === cfg.id);
    const holdingAmount = holdingByCoinId.get(cfg.id) ?? 0;
    const reservedAmount = positionsForCoin
      .filter(p => isPositionReserved(p, now))
      .reduce((sum, p) => sum + p.amount, 0);

    const positions: StakingPositionView[] = positionsForCoin.map(p => ({
      id: p.id,
      amount: p.amount,
      mode: p.mode,
      stakedAt: p.staked_at,
      lockUntil: p.lock_until,
      unstakeRequestedAt: p.unstake_requested_at,
      unstakeAvailableAt: p.unstake_available_at,
      reserved: isPositionReserved(p, now),
      aprPct: effectiveApr(p, now) * 100,
      pendingRewards: p.pending_rewards,
    }));

    result.push({
      coinId: cfg.id,
      symbol: cfg.symbol,
      name: cfg.name,
      iconUrl: cfg.iconUrl,
      currentPrice: price(state.coins[cfg.id].pool),
      holdingAmount,
      sellableAmount: Math.max(0, holdingAmount - reservedAmount),
      positions,
      // Only flexible positions' reward is independently claimable — locked
      // positions' reward is only ever settled via withdraw (full term) or
      // forfeited via break-lock (see routes.ts), so it must NOT be summed
      // into the amount the "Забрать" button promises to pay out.
      pendingRewards: positions.filter(p => p.mode === 'flexible').reduce((sum, p) => sum + p.pendingRewards, 0),
    });
  }
  return result;
}
