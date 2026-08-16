import { Router } from 'express';
import { EngineState, recentChangePct } from '../engine/state.js';
import { price } from '../engine/amm.js';
import { quoteBuy, quoteSell } from '../engine/amm.js';
import { executeTrade, TradeError } from '../engine/trade.js';
import { forcePhase, fearGreedLabel, phaseProgress, tick } from '../engine/tick.js';
import { justifiedPrice } from '../engine/gravity.js';
import { aggregateCandles, isChartTimeframe } from '../engine/candleAggregate.js';
import { triggerNewsEvent } from '../engine/news.js';
import { NewsDirection, NewsStrength } from '../config/news.js';
import { MACRO_CONFIG, MACRO_ORDER, MacroPhase } from '../engine/macroCycle.js';
import { COINS, COIN_MAP, tradeFeePct, sectionOf } from '../config/coins.js';
import { RANKS, RANK_UP_REWARDS } from '../config/ranks.js';
import { DAILY_BONUS_AMOUNT, EMISSION_THRESHOLDS, DAILY_VOLUME_THRESHOLD, DAILY_VOLUME_REWARD } from '../config/quests.js';
import { todaysVolume } from '../engine/dailyVolume.js';
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
  addEarnedTotal, getEarnedTotals,
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
    const timeframeParam = String(req.query.timeframe ?? '10s');
    if (!isChartTimeframe(timeframeParam)) return res.status(400).json({ error: 'invalid timeframe' });
    const candles = cs.currentCandle ? [...cs.candles, cs.currentCandle] : cs.candles;
    res.json({ candles: aggregateCandles(candles, timeframeParam) });
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
    const { coinId, side, amountUsdd, amountCoin, useMax } = req.body;
    try {
      const result = await executeTrade(state, req.playerId, { coinId, side, amountUsdd, amountCoin, useMax });
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

    const volumeRow = progress.find(p => p.quest_type === 'daily_volume');
    const volumeClaimedAt = volumeRow?.claimed_at ? new Date(volumeRow.claimed_at) : null;
    const volumeRecentlyClaimed = !!volumeClaimedAt && Date.now() - volumeClaimedAt.getTime() < 24 * 60 * 60 * 1000;
    const volumeToday = todaysVolume(req.playerId);

    // Always returns all 5 thresholds, even with no holdings at all — a
    // brand-new player should see the full ladder (all "not met") rather
    // than nothing, since the amounts themselves are useful to see up front.
    // Claimed is tracked per (player, threshold) only — NOT per coin — so a
    // threshold reached on one coin and then again on a different coin can
    // only ever be paid out once (see the matching check in POST /quests/claim).
    const leader = findEmissionLeader(state, portfolio.holdings);
    const ladder = EMISSION_THRESHOLDS.map(t => {
      const claimed = progress.some(
        p => p.quest_type === 'emission_capture' && p.threshold === t.threshold && p.claimed_at
      );
      return {
        threshold: t.threshold,
        reward: t.reward,
        met: leader ? leader.pct >= t.threshold : false,
        claimed,
        coinId: leader?.coinId ?? null,
        coinSymbol: leader ? COIN_MAP[leader.coinId].symbol : null,
      };
    });

    // achieved just means "peak ever reached this rank" (see rankRewards.ts) —
    // claimed is tracked the same way as emission_capture, via quest_progress
    // with quest_type='rank_reward' and threshold repurposed to hold the rank
    // index (coin_id unused, stored as 'none').
    const highestLeagueIndex = await getHighestLeagueIndex(req.playerId);
    const rankLadder = RANKS.slice(1).map((r, i) => {
      const rankIndex = i + 1; // RANKS[0] (Планктон) is skipped — starting rank, no reward
      const claimed = progress.some(
        p => p.quest_type === 'rank_reward' && p.threshold === rankIndex && p.claimed_at
      );
      return {
        name: r.name,
        reward: RANK_UP_REWARDS[rankIndex] ?? 0,
        rankIndex,
        achieved: highestLeagueIndex >= rankIndex,
        claimed,
      };
    });

    const earned = await getEarnedTotals(req.playerId);

    res.json({
      dailyBonus: { amount: DAILY_BONUS_AMOUNT, available: dailyAvailable, claimedAt: dailyRow?.claimed_at ?? null },
      dailyVolume: {
        amount: DAILY_VOLUME_REWARD,
        threshold: DAILY_VOLUME_THRESHOLD,
        current: volumeToday,
        met: volumeToday >= DAILY_VOLUME_THRESHOLD,
        claimed: volumeRecentlyClaimed,
        claimedAt: volumeRow?.claimed_at ?? null,
      },
      dailyEarnedTotal: earned.daily,
      emissionCapture: {
        leaderCoinId: leader?.coinId ?? null,
        leaderSymbol: leader ? COIN_MAP[leader.coinId].symbol : null,
        leaderPct: leader?.pct ?? 0,
        ladder,
      },
      emissionEarnedTotal: earned.emission,
      rankRewards: { ladder: rankLadder },
      rankEarnedTotal: earned.rank,
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
      await addEarnedTotal(req.playerId, 'daily', DAILY_BONUS_AMOUNT);
      return res.json({ success: true, amount: DAILY_BONUS_AMOUNT });
    }

    if (questId === 'daily_volume') {
      const progress = await getQuestProgress(req.playerId);
      const volumeRow = progress.find(p => p.quest_type === 'daily_volume');
      const lastClaim = volumeRow?.claimed_at ? new Date(volumeRow.claimed_at).getTime() : 0;
      if (Date.now() - lastClaim < 24 * 60 * 60 * 1000) {
        return res.status(400).json({ error: 'already claimed' });
      }
      if (todaysVolume(req.playerId) < DAILY_VOLUME_THRESHOLD) {
        return res.status(400).json({ error: 'insufficient volume' });
      }
      await claimQuestRow(req.playerId, 'daily_volume', 'none', 0);
      const { db } = await import('../db/index.js');
      await db.query('UPDATE players SET usdd_balance = usdd_balance + $1 WHERE id = $2', [DAILY_VOLUME_REWARD, req.playerId]);
      await addEarnedTotal(req.playerId, 'daily', DAILY_VOLUME_REWARD);
      return res.json({ success: true, amount: DAILY_VOLUME_REWARD });
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
      // Claimed is tracked per (player, threshold) only — a threshold already
      // paid out on a different coin must not be payable again here.
      const progress = await getQuestProgress(req.playerId);
      const already = progress.some(
        p => p.quest_type === 'emission_capture' && p.threshold === threshold && p.claimed_at
      );
      if (already) return res.status(400).json({ error: 'already claimed' });

      await claimQuestRow(req.playerId, 'emission_capture', coinId, threshold);
      const { db } = await import('../db/index.js');
      await db.query('UPDATE players SET usdd_balance = usdd_balance + $1 WHERE id = $2', [def.reward, req.playerId]);
      await addEarnedTotal(req.playerId, 'emission', def.reward);
      return res.json({ success: true, amount: def.reward });
    }

    if (questId.startsWith('rank_reward:')) {
      const [, rankIndexStr] = questId.split(':');
      const rankIndex = Number(rankIndexStr);
      const reward = RANK_UP_REWARDS[rankIndex] ?? 0;
      if (!Number.isInteger(rankIndex) || rankIndex <= 0 || rankIndex >= RANKS.length || reward <= 0) {
        return res.status(400).json({ error: 'invalid rank' });
      }

      // achieved = peak ever reached (see rankRewards.ts) — never the live
      // rank, so this can't be gamed by dipping back below the threshold.
      const highestLeagueIndex = await getHighestLeagueIndex(req.playerId);
      if (highestLeagueIndex < rankIndex) {
        return res.status(400).json({ error: 'rank not yet achieved' });
      }
      const progress = await getQuestProgress(req.playerId);
      const already = progress.some(
        p => p.quest_type === 'rank_reward' && p.threshold === rankIndex && p.claimed_at
      );
      if (already) return res.status(400).json({ error: 'already claimed' });

      await claimQuestRow(req.playerId, 'rank_reward', 'none', rankIndex);
      const { db } = await import('../db/index.js');
      await db.query('UPDATE players SET usdd_balance = usdd_balance + $1 WHERE id = $2', [reward, req.playerId]);
      await addEarnedTotal(req.playerId, 'rank', reward);
      return res.json({ success: true, amount: reward });
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
        runTotalUsdd: bot.run_total_usdd,
        runTotalCoins: bot.run_total_coins,
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

  // Runs the simulation forward synchronously instead of at the real
  // 1-tick/second pace — tick() is pure in-memory math (see engine/tick.ts),
  // so a tight loop of it is cheap and lets pre-beta test scripts observe
  // hours of simulated market behavior (macro phases, gravity, drift) in a
  // couple of seconds instead of actually waiting real wall-clock hours.
  // Bypasses the normal per-tick WS broadcast entirely — connected dev
  // clients just see time jump when this returns. Same "safe dev
  // environment" gate as the routes above.
  router.post('/debug/fast-forward', (req, res) => {
    if (!DEV_AUTH_ALLOWED) return res.status(403).json({ error: 'not available' });
    const ticks = Math.min(Math.max(Math.floor(Number(req.body?.ticks) || 0), 0), 300_000);

    const priceStats: Record<string, { min: number; max: number }> = {};
    for (const cfg of COINS) {
      const p = price(state.coins[cfg.id].pool);
      priceStats[cfg.id] = { min: p, max: p };
    }
    // Records BTCR's price at the start of every macro phase encountered
    // during the loop (including the phase already active when it started),
    // so a caller can derive each individual phase's actual % move in one
    // pass instead of polling between forced phase changes.
    const phaseLog: { phase: MacroPhase; atTick: number; btcrPrice: number }[] = [
      { phase: state.macroPhase, atTick: state.tickCount, btcrPrice: price(state.coins['btcr'].pool) },
    ];
    for (let i = 0; i < ticks; i++) {
      tick(state);
      for (const cfg of COINS) {
        const p = price(state.coins[cfg.id].pool);
        const s = priceStats[cfg.id];
        if (p < s.min) s.min = p;
        if (p > s.max) s.max = p;
      }
      if (state.macroPhase !== phaseLog[phaseLog.length - 1].phase) {
        phaseLog.push({ phase: state.macroPhase, atTick: state.tickCount, btcrPrice: price(state.coins['btcr'].pool) });
      }
    }
    res.json({ ticksRun: ticks, tickCount: state.tickCount, macroPhase: state.macroPhase, priceStats, phaseLog });
  });

  // Raw pool reserves — lets a test independently re-derive the
  // constant-product math (x*y=k) by hand instead of trusting the same
  // engine code that's under test. Also exposes playerOwnedCoins (see
  // restore-pools below) — it isn't part of the AMM pool itself, but it's
  // exactly the other piece of per-coin state a real trade mutates, and
  // gravity.ts's justifiedPrice() anchors hard on it (a squared ratio term),
  // so restoring reserves without it leaves the coin's long-horizon price
  // target badly skewed even though the pool itself looks back to normal.
  router.get('/debug/pool/:id', (req, res) => {
    if (!DEV_AUTH_ALLOWED) return res.status(403).json({ error: 'not available' });
    const cs = state.coins[req.params.id];
    if (!cs) return res.status(404).json({ error: 'coin not found' });
    res.json({ coinReserve: cs.pool.coinReserve, usddReserve: cs.pool.usddReserve, playerOwnedCoins: cs.playerOwnedCoins });
  });

  // Lets a test snapshot pool reserves (+ playerOwnedCoins) before a real
  // market-moving sequence (a /debug/fast-forward run, or a large buy/sell
  // pair) and put them back afterward, so observing "hours" of unattended
  // drift — or a large simulated buyer — doesn't PERMANENTLY move prices for
  // every other dev/QA session against this same server (pool reserves are
  // snapshotted to disk every 10s and resumed on restart — without this,
  // each test run would leave a one-way-ratcheting mark on the shared dev
  // market).
  router.post('/debug/restore-pools', (req, res) => {
    if (!DEV_AUTH_ALLOWED) return res.status(403).json({ error: 'not available' });
    const pools = req.body?.pools as Record<string, { coinReserve: number; usddReserve: number; playerOwnedCoins?: number }> | undefined;
    if (!pools) return res.status(400).json({ error: 'missing pools' });
    for (const [coinId, reserves] of Object.entries(pools)) {
      const cs = state.coins[coinId];
      if (!cs || !reserves) continue;
      cs.pool.coinReserve = reserves.coinReserve;
      cs.pool.usddReserve = reserves.usddReserve;
      if (reserves.playerOwnedCoins != null) cs.playerOwnedCoins = reserves.playerOwnedCoins;
    }
    res.json({ success: true });
  });

  // Credits the calling dev player directly, bypassing the shop/daily-limit
  // entirely, so market-moving tests (large emission capture, concurrent
  // trade races, etc.) can fund a test account without needing a realistic
  // in-game way to earn that much USDD first.
  router.post('/debug/grant-balance', async (req, res) => {
    if (!DEV_AUTH_ALLOWED) return res.status(403).json({ error: 'not available' });
    const amount = Number(req.body?.amount);
    if (!amount || amount <= 0) return res.status(400).json({ error: 'invalid amount' });
    const { db } = await import('../db/index.js');
    const result = await db.query<{ usdd_balance: number }>(
      'UPDATE players SET usdd_balance = usdd_balance + $1 WHERE id = $2 RETURNING usdd_balance',
      [amount, req.playerId]
    );
    res.json({ success: true, newBalance: result.rows[0]?.usdd_balance ?? null });
  });

  return router;
}

// STUB: real Telegram Stars Invoice API integration point. Today this simply
// credits the player's balance; swap the body for a real charge + webhook confirm.
async function processStarPayment(playerId: string, starsAmount: number, usddAmount: number): Promise<void> {
  const { db } = await import('../db/index.js');
  await db.query('UPDATE players SET usdd_balance = usdd_balance + $1 WHERE id = $2', [usddAmount, playerId]);
}
