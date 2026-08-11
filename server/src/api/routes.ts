import { Router } from 'express';
import { EngineState, recentChangePct } from '../engine/state.js';
import { price } from '../engine/amm.js';
import { quoteBuy, quoteSell } from '../engine/amm.js';
import { executeTrade, TradeError } from '../engine/trade.js';
import { forcePhase, fearGreedLabel, phaseProgress } from '../engine/tick.js';
import { justifiedPrice } from '../engine/gravity.js';
import { triggerNewsEvent } from '../engine/news.js';
import { NewsDirection, NewsStrength } from '../config/news.js';
import { MACRO_CONFIG, MACRO_ORDER, MacroPhase } from '../engine/macroCycle.js';
import { COINS, COIN_MAP, tradeFeePct, sectionOf } from '../config/coins.js';
import { RANKS, RANK_UP_REWARDS } from '../config/ranks.js';
import { DAILY_BONUS_AMOUNT, EMISSION_THRESHOLDS } from '../config/quests.js';
import { SHOP_PACKAGES, STARS_TO_USDD_RATE, DAILY_LIMIT_USDD } from '../config/shop.js';
import { MIN_BOT_INTERVAL_MS } from '../config/tradingBot.js';
import { remainingToday, recordSpend } from './shopState.js';
import { resolvePlayer } from './middleware.js';
import { DEV_AUTH_ALLOWED } from '../auth/telegram.js';
import {
  getHolding,
  getQuestProgress, claimQuestRow, reservedStakedAmount,
  createStakingPosition, getPositionById, requestUnstakePosition, deleteStakingPosition,
  withdrawStakingPosition, claimFlexibleCoinRewards, isPositionReserved,
  getTradingBot, configureTradingBot, setTradingBotEnabled, getHighestLeagueIndex,
} from '../db/queries.js';
import { computePortfolio, computeLeaderboard, findEmissionLeader, computeStaking } from './helpers.js';
import { STAKING_FLEXIBLE_COOLDOWN_MS, STAKING_FLEXIBLE_APR } from '../config/staking.js';

export function createRouter(state: EngineState) {
  const router = Router();

  router.use(resolvePlayer);

  router.get('/coins', (req, res) => {
    const list = COINS.map(cfg => {
      const cs = state.coins[cfg.id];
      const p = price(cs.pool);
      return {
        id: cfg.id,
        symbol: cfg.symbol,
        name: cfg.name,
        iconUrl: cfg.iconUrl,
        section: sectionOf(cfg.category),
        price: p,
        marketCap: p * cfg.emission,
        supply: cfg.emission,
        changePct: recentChangePct(cs),
        pctCapturedByPlayers: 0, // filled in below if holdings exist; kept simple for the list view
        livelinessMultiplier: cs.livelinessMultiplier, // diagnostic — noise amplification currently in effect
      };
    });
    res.json({
      coins: list,
      marketStatus: {
        phase: state.macroPhase,
        phaseLabel: MACRO_CONFIG[state.macroPhase].label,
        fearGreedIndex: state.fearGreedIndex,
        fearGreedLabel: fearGreedLabel(state.fearGreedIndex),
        ...phaseProgress(state),
        activeNews: state.activeNewsBanner,
      },
    });
  });

  router.get('/coins/:id/candles', (req, res) => {
    const cs = state.coins[req.params.id];
    if (!cs) return res.status(404).json({ error: 'coin not found' });
    const candles = cs.currentCandle ? [...cs.candles, cs.currentCandle] : cs.candles;
    res.json({ candles });
  });

  router.post('/trade/quote', async (req, res) => {
    const { coinId, side, amountUsdd, amountCoin } = req.body;
    const cs = state.coins[coinId];
    if (!cs) return res.status(404).json({ error: 'coin not found' });
    try {
      if (side === 'buy') {
        const usddIn = Number(amountUsdd);
        const feeAmount = usddIn * tradeFeePct(coinId);
        const q = quoteBuy(cs.pool, usddIn - feeAmount);
        res.json({ expectedCoinOut: q.coinOut, avgPrice: q.avgPrice, priceImpactPct: q.priceImpactPct, feeAmount, feePct: tradeFeePct(coinId) });
      } else {
        let coinIn: number;
        if (amountCoin != null) coinIn = Number(amountCoin);
        else coinIn = Number(amountUsdd) / price(cs.pool);
        const q = quoteSell(cs.pool, coinIn);
        const feeAmount = q.usddOut * tradeFeePct(coinId);
        res.json({ expectedUsddOut: q.usddOut - feeAmount, avgPrice: q.avgPrice, priceImpactPct: q.priceImpactPct, feeAmount, feePct: tradeFeePct(coinId) });
      }
    } catch (e) {
      res.status(400).json({ error: 'quote failed' });
    }
  });

  router.post('/trade', async (req, res) => {
    const { coinId, side, amountUsdd, amountCoin } = req.body;
    try {
      const result = await executeTrade(state, req.playerId, { coinId, side, amountUsdd, amountCoin });
      res.json(result);
    } catch (e) {
      const status = e instanceof TradeError ? e.status : 400;
      res.status(status).json({ error: e instanceof Error ? e.message : 'trade failed' });
    }
  });

  router.get('/portfolio', async (req, res) => {
    const portfolio = await computePortfolio(state, req.playerId);
    res.json(portfolio);
  });

  router.get('/staking', async (req, res) => {
    const coins = await computeStaking(state, req.playerId);
    res.json({
      coins,
      config: {
        flexibleAprPct: STAKING_FLEXIBLE_APR * 100,
        flexibleCooldownMs: STAKING_FLEXIBLE_COOLDOWN_MS,
      },
    });
  });

  router.post('/staking/stake', async (req, res) => {
    const { coinId, amount } = req.body as { coinId: string; amount: number };
    const cs = state.coins[coinId];
    const cfg = COIN_MAP[coinId];
    if (!cs || !cfg) return res.status(404).json({ error: 'coin not found' });
    const stakeAmount = Number(amount);
    if (!stakeAmount || stakeAmount <= 0) return res.status(400).json({ error: 'invalid amount' });

    const holding = await getHolding(req.playerId, coinId);
    const reserved = await reservedStakedAmount(req.playerId, coinId);
    const available = (holding?.amount ?? 0) - reserved;
    if (stakeAmount > available) return res.status(400).json({ error: 'insufficient sellable balance' });

    // Only the flexible mode is offered going forward (locked mode was
    // removed) — USD value fixed at this moment (see engine/staking.ts),
    // reward accrual never re-reads the coin's price again for this position.
    const stakePrice = price(cs.pool);
    const position = await createStakingPosition(req.playerId, coinId, stakeAmount, 'flexible', null, stakePrice);
    res.json({ success: true, position });
  });

  router.post('/staking/request-unstake', async (req, res) => {
    const { positionId } = req.body as { positionId: string };
    const position = await getPositionById(positionId);
    if (!position || position.player_id !== req.playerId) return res.status(404).json({ error: 'position not found' });
    if (position.mode !== 'flexible') return res.status(400).json({ error: 'only flexible positions can request unstake' });
    if (position.unstake_requested_at) return res.status(400).json({ error: 'unstake already requested' });

    const availableAt = new Date(Date.now() + STAKING_FLEXIBLE_COOLDOWN_MS);
    await requestUnstakePosition(positionId, availableAt);
    res.json({ success: true, unstakeAvailableAt: availableAt.toISOString() });
  });

  router.post('/staking/withdraw', async (req, res) => {
    const { positionId } = req.body as { positionId: string };
    const position = await getPositionById(positionId);
    if (!position || position.player_id !== req.playerId) return res.status(404).json({ error: 'position not found' });
    if (isPositionReserved(position, Date.now())) return res.status(400).json({ error: 'position is still locked/cooling down' });

    // Eligibility was checked above from the read, but the payout amount and
    // the delete itself happen in one atomic statement — see
    // withdrawStakingPosition's comment for why (a concurrent distribution
    // tick or a double-submitted request would otherwise risk a lost or
    // double-counted reward).
    const paidRewards = await withdrawStakingPosition(positionId, req.playerId);
    if (paidRewards === null) return res.status(404).json({ error: 'position already withdrawn' });
    if (paidRewards > 0) {
      const { db } = await import('../db/index.js');
      await db.query('UPDATE players SET usdd_balance = usdd_balance + $1 WHERE id = $2', [paidRewards, req.playerId]);
    }
    res.json({ success: true });
  });

  // Ends a locked position BEFORE its term completes: the staked amount is
  // simply un-reserved (coins were never moved out of player_holdings), but
  // pending_rewards is discarded entirely — the whole point of the penalty.
  // Gated on isPositionReserved (genuinely still mid-lock), not just
  // mode === 'locked', so this can't accidentally be used on an
  // already-completed lock and forfeit reward that has fully vested —
  // use /staking/withdraw for that case instead.
  router.post('/staking/break-lock', async (req, res) => {
    const { positionId } = req.body as { positionId: string };
    const position = await getPositionById(positionId);
    if (!position || position.player_id !== req.playerId) return res.status(404).json({ error: 'position not found' });
    if (position.mode !== 'locked' || !isPositionReserved(position, Date.now())) {
      return res.status(400).json({ error: 'position is not an active lock' });
    }
    await deleteStakingPosition(positionId);
    res.json({ success: true, amount: position.amount });
  });

  router.post('/staking/claim', async (req, res) => {
    const { coinId } = req.body as { coinId: string };
    if (!COIN_MAP[coinId]) return res.status(404).json({ error: 'coin not found' });
    const amount = await claimFlexibleCoinRewards(req.playerId, coinId);
    if (amount > 0) {
      const { db } = await import('../db/index.js');
      await db.query('UPDATE players SET usdd_balance = usdd_balance + $1 WHERE id = $2', [amount, req.playerId]);
    }
    res.json({ success: true, amount });
  });

  router.get('/quests', async (req, res) => {
    const portfolio = await computePortfolio(state, req.playerId);
    const progress = await getQuestProgress(req.playerId);

    const dailyRow = progress.find(p => p.quest_type === 'daily_bonus');
    const dailyClaimedAt = dailyRow?.claimed_at ? new Date(dailyRow.claimed_at) : null;
    const dailyAvailable = !dailyClaimedAt || Date.now() - dailyClaimedAt.getTime() >= 24 * 60 * 60 * 1000;

    // Always returns all 5 thresholds, even with no holdings at all — a
    // brand-new player should see the full ladder (all "not met") rather
    // than nothing, since the amounts themselves are useful to see up front.
    const leader = findEmissionLeader(state, portfolio.holdings);
    const ladder = EMISSION_THRESHOLDS.map(t => {
      const claimed = leader
        ? progress.some(
            p => p.quest_type === 'emission_capture' && p.coin_id === leader.coinId && p.threshold === t.threshold && p.claimed_at
          )
        : false;
      return {
        threshold: t.threshold,
        reward: t.reward,
        met: leader ? leader.pct >= t.threshold : false,
        claimed,
        coinId: leader?.coinId ?? null,
        coinSymbol: leader ? COIN_MAP[leader.coinId].symbol : null,
      };
    });

    const highestLeagueIndex = await getHighestLeagueIndex(req.playerId);
    const rankLadder = RANKS.slice(1).map((r, i) => {
      const rankIndex = i + 1; // RANKS[0] (Планктон) is skipped — starting rank, no reward
      return { name: r.name, reward: RANK_UP_REWARDS[rankIndex] ?? 0, achieved: highestLeagueIndex >= rankIndex };
    });

    res.json({
      dailyBonus: { amount: DAILY_BONUS_AMOUNT, available: dailyAvailable, claimedAt: dailyRow?.claimed_at ?? null },
      emissionCapture: {
        leaderCoinId: leader?.coinId ?? null,
        leaderSymbol: leader ? COIN_MAP[leader.coinId].symbol : null,
        leaderPct: leader?.pct ?? 0,
        ladder,
      },
      rankRewards: { ladder: rankLadder },
    });
  });

  router.post('/quests/claim', async (req, res) => {
    const { questId } = req.body as { questId: string };

    if (questId === 'daily_bonus') {
      const progress = await getQuestProgress(req.playerId);
      const dailyRow = progress.find(p => p.quest_type === 'daily_bonus');
      const lastClaim = dailyRow?.claimed_at ? new Date(dailyRow.claimed_at).getTime() : 0;
      if (Date.now() - lastClaim < 24 * 60 * 60 * 1000) {
        return res.status(400).json({ error: 'already claimed' });
      }
      await claimQuestRow(req.playerId, 'daily_bonus', 'none', 0);
      const { db } = await import('../db/index.js');
      await db.query('UPDATE players SET usdd_balance = usdd_balance + $1 WHERE id = $2', [DAILY_BONUS_AMOUNT, req.playerId]);
      return res.json({ success: true, amount: DAILY_BONUS_AMOUNT });
    }

    if (questId.startsWith('emission_capture:')) {
      const [, coinId, thresholdStr] = questId.split(':');
      const threshold = Number(thresholdStr);
      const def = EMISSION_THRESHOLDS.find(t => t.threshold === threshold);
      if (!def) return res.status(400).json({ error: 'invalid threshold' });

      const portfolio = await computePortfolio(state, req.playerId);
      const holding = portfolio.holdings.find(h => h.coinId === coinId);
      if (!holding || holding.pctEmission < threshold) {
        return res.status(400).json({ error: 'insufficient emission share' });
      }
      const progress = await getQuestProgress(req.playerId);
      const already = progress.some(
        p => p.quest_type === 'emission_capture' && p.coin_id === coinId && p.threshold === threshold && p.claimed_at
      );
      if (already) return res.status(400).json({ error: 'already claimed' });

      await claimQuestRow(req.playerId, 'emission_capture', coinId, threshold);
      const { db } = await import('../db/index.js');
      await db.query('UPDATE players SET usdd_balance = usdd_balance + $1 WHERE id = $2', [def.reward, req.playerId]);
      return res.json({ success: true, amount: def.reward });
    }

    return res.status(400).json({ error: 'unknown quest' });
  });

  router.get('/shop/status', (req, res) => {
    res.json({
      packages: SHOP_PACKAGES,
      rate: STARS_TO_USDD_RATE,
      remainingToday: remainingToday(req.playerId),
      dailyLimit: DAILY_LIMIT_USDD,
    });
  });

  // STUB: instantly credits USDD instead of charging real Telegram Stars.
  // Replace with a real Invoice API call (processStarPayment) before launch.
  router.post('/shop/purchase', async (req, res) => {
    const { starsAmount, packageId } = req.body as { starsAmount: number; packageId?: string };
    if (!starsAmount || starsAmount <= 0) return res.status(400).json({ error: 'invalid amount' });
    // Package purchases are priced server-side from the package's own bonused
    // usddAmount, not starsAmount*rate — that flat formula ignores the bonus
    // entirely and would silently under-credit every discounted package.
    // starsAmount must still match the package exactly (server-authoritative
    // pricing — never trust a client-supplied amount for what to credit).
    let usddAmount: number;
    if (packageId) {
      const pkg = SHOP_PACKAGES.find(p => p.id === packageId);
      if (!pkg || pkg.stars !== starsAmount) return res.status(400).json({ error: 'invalid package' });
      usddAmount = pkg.usddAmount;
    } else {
      usddAmount = starsAmount * STARS_TO_USDD_RATE;
    }
    if (usddAmount > remainingToday(req.playerId)) return res.status(400).json({ error: 'daily limit exceeded' });

    await processStarPayment(req.playerId, starsAmount, usddAmount);
    recordSpend(req.playerId, usddAmount);
    res.json({ success: true, usddCredited: usddAmount, remainingToday: remainingToday(req.playerId) });
  });

  // The trading bot is available to every player with no purchase step.
  router.get('/bot', async (req, res) => {
    const bot = await getTradingBot(req.playerId);
    res.json({
      config: bot && bot.coin_id ? {
        coinId: bot.coin_id,
        side: bot.side,
        intervalMs: bot.interval_ms,
        amount: bot.amount,
        enabled: bot.enabled,
        nextRunAt: bot.next_run_at,
      } : null,
    });
  });

  router.post('/bot/config', async (req, res) => {
    const { coinId, side, intervalMs, amount } = req.body as {
      coinId: string; side: 'buy' | 'sell'; intervalMs: number; amount: number;
    };
    if (!COIN_MAP[coinId]) return res.status(404).json({ error: 'coin not found' });
    if (side !== 'buy' && side !== 'sell') return res.status(400).json({ error: 'invalid side' });
    if (!intervalMs || Number(intervalMs) < MIN_BOT_INTERVAL_MS) {
      return res.status(400).json({ error: `minimum interval is ${MIN_BOT_INTERVAL_MS}ms` });
    }
    if (!amount || Number(amount) <= 0) return res.status(400).json({ error: 'invalid amount' });
    await configureTradingBot(req.playerId, coinId, side, Number(intervalMs), Number(amount));
    res.json({ success: true });
  });

  router.post('/bot/toggle', async (req, res) => {
    const bot = await getTradingBot(req.playerId);
    const { enabled } = req.body as { enabled: boolean };
    if (enabled && (!bot?.coin_id || !bot.side || !bot.interval_ms || !bot.amount)) {
      return res.status(400).json({ error: 'trading bot not configured' });
    }
    await setTradingBotEnabled(req.playerId, Boolean(enabled));
    res.json({ success: true });
  });

  router.get('/leaderboard', async (req, res) => {
    const league = String(req.query.league ?? RANKS[0].name);
    if (!RANKS.some(r => r.name === league)) return res.status(400).json({ error: 'unknown league' });
    const result = await computeLeaderboard(state, league, req.playerId);
    res.json({ league, ...result });
  });

  router.get('/ranks', (req, res) => {
    res.json({ ranks: RANKS.map(r => ({ name: r.name, min: r.min, max: Number.isFinite(r.max) ? r.max : null })) });
  });

  // Both routes below mutate SHARED market state (affects every player, not
  // just the caller) — gated behind the same "safe dev environment" flag as
  // the auth dev-fallback, so they're genuinely unreachable by real players
  // once deployed (NODE_ENV=production), not just hidden behind a UI toggle.
  router.post('/debug/phase', (req, res) => {
    if (!DEV_AUTH_ALLOWED) return res.status(403).json({ error: 'not available' });
    const { phase } = req.body as { phase: MacroPhase };
    if (!MACRO_ORDER.includes(phase)) return res.status(400).json({ error: 'unknown phase' });
    forcePhase(state, phase);
    res.json({ success: true, phase });
  });

  // Forces a news event immediately instead of waiting the real 3-6 minute
  // gap — for manual QA only, same idiom as /debug/phase above.
  router.post('/debug/force-news', (req, res) => {
    if (!DEV_AUTH_ALLOWED) return res.status(403).json({ error: 'not available' });
    const { direction, strength } = req.body as { direction?: NewsDirection; strength?: NewsStrength };
    if (direction && direction !== 'positive' && direction !== 'negative') {
      return res.status(400).json({ error: 'invalid direction' });
    }
    if (strength && strength !== 'weak' && strength !== 'medium' && strength !== 'strong') {
      return res.status(400).json({ error: 'invalid strength' });
    }
    const event = triggerNewsEvent(state, { direction, strength });
    res.json({ success: true, headline: event.headline, direction: event.direction });
  });

  // Per-tick component breakdown for the most recent tick — diagnostic for
  // seeing exactly how much each force (macro drift, local cycle, base noise,
  // relative noise) actually contributed, instead of inferring it from the chart.
  router.get('/debug/tick-breakdown', (req, res) => {
    const breakdown = COINS.map(cfg => {
      const cs = state.coins[cfg.id];
      return {
        id: cfg.id,
        symbol: cfg.symbol,
        ...cs.lastTick,
        projectLevel: cs.projectLevel,
        playerOwnedCoins: cs.playerOwnedCoins,
        justifiedPrice: justifiedPrice(cs),
        currentPrice: price(cs.pool),
      };
    });
    res.json({
      phase: state.macroPhase,
      macroMode: state.macroMode,
      macroPhaseDriftPctPerMin: state.macroPhaseDriftPctPerMin,
      coins: breakdown,
    });
  });

  return router;
}

// STUB: real Telegram Stars Invoice API integration point. Today this simply
// credits the player's balance; swap the body for a real charge + webhook confirm.
async function processStarPayment(playerId: string, starsAmount: number, usddAmount: number): Promise<void> {
  const { db } = await import('../db/index.js');
  await db.query('UPDATE players SET usdd_balance = usdd_balance + $1 WHERE id = $2', [usddAmount, playerId]);
}
