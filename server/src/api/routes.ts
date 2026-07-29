import { Router } from 'express';
import { EngineState, change24hPct } from '../engine/state.js';
import { buyWithUsdd, sellCoin, quoteBuy, quoteSell, price } from '../engine/amm.js';
import { forcePhase, fearGreedLabel, phaseProgress } from '../engine/tick.js';
import { justifiedPrice } from '../engine/gravity.js';
import { MACRO_CONFIG, MACRO_ORDER, MacroPhase } from '../engine/macroCycle.js';
import { COINS, COIN_MAP, TRADE_FEE_PCT, MIN_TRADE_USDD, sectionOf } from '../config/coins.js';
import { RANKS } from '../config/ranks.js';
import { DAILY_BONUS_AMOUNT, EMISSION_THRESHOLDS } from '../config/quests.js';
import { SHOP_PACKAGES, STARS_TO_USDD_RATE } from '../config/shop.js';
import { remainingToday, recordSpend } from './shopState.js';
import {
  ensureLocalPlayer, getPlayer, LOCAL_PLAYER_ID, applyBuy, applySell, getHolding,
  getQuestProgress, claimQuestRow,
} from '../db/queries.js';
import { computePortfolio, computeLeaderboard, findEmissionLeader } from './helpers.js';

export function createRouter(state: EngineState) {
  const router = Router();

  router.get('/coins', (req, res) => {
    const list = COINS.map(cfg => {
      const cs = state.coins[cfg.id];
      const p = price(cs.pool);
      return {
        id: cfg.id,
        symbol: cfg.symbol,
        name: cfg.name,
        section: sectionOf(cfg.category),
        price: p,
        marketCap: p * cfg.emission,
        supply: cfg.emission,
        change24hPct: change24hPct(cs),
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
        const feeAmount = usddIn * TRADE_FEE_PCT;
        const q = quoteBuy(cs.pool, usddIn - feeAmount);
        res.json({ expectedCoinOut: q.coinOut, avgPrice: q.avgPrice, priceImpactPct: q.priceImpactPct, feeAmount });
      } else {
        let coinIn: number;
        if (amountCoin != null) coinIn = Number(amountCoin);
        else coinIn = Number(amountUsdd) / price(cs.pool);
        const q = quoteSell(cs.pool, coinIn);
        const feeAmount = q.usddOut * TRADE_FEE_PCT;
        res.json({ expectedUsddOut: q.usddOut - feeAmount, avgPrice: q.avgPrice, priceImpactPct: q.priceImpactPct, feeAmount });
      }
    } catch (e) {
      res.status(400).json({ error: 'quote failed' });
    }
  });

  router.post('/trade', async (req, res) => {
    const { coinId, side, amountUsdd, amountCoin } = req.body;
    const cs = state.coins[coinId];
    const cfg = COIN_MAP[coinId];
    if (!cs || !cfg) return res.status(404).json({ error: 'coin not found' });

    await ensureLocalPlayer();
    const player = await getPlayer(LOCAL_PLAYER_ID);

    if (side === 'buy') {
      const usddIn = Number(amountUsdd);
      if (!usddIn || usddIn < MIN_TRADE_USDD) return res.status(400).json({ error: `minimum trade is ${MIN_TRADE_USDD} USDD` });
      if (usddIn > player.usdd_balance) return res.status(400).json({ error: 'insufficient balance' });
      const fee = usddIn * TRADE_FEE_PCT;
      const netIn = usddIn - fee;
      const result = buyWithUsdd(cs.pool, netIn);
      await applyBuy(LOCAL_PLAYER_ID, coinId, result.coinAmount, usddIn, result.avgPrice);
      cs.playerOwnedCoins += result.coinAmount;
      return res.json({ ...result, fee });
    } else if (side === 'sell') {
      const holding = await getHolding(LOCAL_PLAYER_ID, coinId);
      if (!holding || holding.amount <= 0) return res.status(400).json({ error: 'no holding to sell' });
      let coinIn: number;
      if (amountCoin != null) coinIn = Number(amountCoin);
      else coinIn = Number(amountUsdd) / price(cs.pool);
      coinIn = Math.min(coinIn, holding.amount);
      if (coinIn <= 0) return res.status(400).json({ error: 'invalid amount' });
      const result = sellCoin(cs.pool, coinIn);
      const fee = result.usddAmount * TRADE_FEE_PCT;
      const netOut = result.usddAmount - fee;
      await applySell(LOCAL_PLAYER_ID, coinId, coinIn, netOut, result.avgPrice);
      cs.playerOwnedCoins = Math.max(0, cs.playerOwnedCoins - coinIn);
      return res.json({ ...result, usddAmount: netOut, fee });
    }
    return res.status(400).json({ error: 'side must be buy or sell' });
  });

  router.get('/portfolio', async (req, res) => {
    await ensureLocalPlayer();
    const portfolio = await computePortfolio(state, LOCAL_PLAYER_ID);
    res.json(portfolio);
  });

  router.get('/quests', async (req, res) => {
    await ensureLocalPlayer();
    const portfolio = await computePortfolio(state, LOCAL_PLAYER_ID);
    const progress = await getQuestProgress(LOCAL_PLAYER_ID);

    const dailyRow = progress.find(p => p.quest_type === 'daily_bonus');
    const dailyClaimedAt = dailyRow?.claimed_at ? new Date(dailyRow.claimed_at) : null;
    const dailyAvailable = !dailyClaimedAt || Date.now() - dailyClaimedAt.getTime() >= 24 * 60 * 60 * 1000;

    const leader = findEmissionLeader(state, portfolio.holdings);
    const ladder = leader
      ? EMISSION_THRESHOLDS.map(t => {
          const claimed = progress.some(
            p => p.quest_type === 'emission_capture' && p.coin_id === leader.coinId && p.threshold === t.threshold && p.claimed_at
          );
          return {
            threshold: t.threshold,
            reward: t.reward,
            met: leader.pct >= t.threshold,
            claimed,
            coinId: leader.coinId,
            coinSymbol: COIN_MAP[leader.coinId].symbol,
          };
        })
      : [];

    res.json({
      dailyBonus: { amount: DAILY_BONUS_AMOUNT, available: dailyAvailable, claimedAt: dailyRow?.claimed_at ?? null },
      emissionCapture: {
        leaderCoinId: leader?.coinId ?? null,
        leaderSymbol: leader ? COIN_MAP[leader.coinId].symbol : null,
        leaderPct: leader?.pct ?? 0,
        ladder,
      },
    });
  });

  router.post('/quests/claim', async (req, res) => {
    await ensureLocalPlayer();
    const { questId } = req.body as { questId: string };

    if (questId === 'daily_bonus') {
      const progress = await getQuestProgress(LOCAL_PLAYER_ID);
      const dailyRow = progress.find(p => p.quest_type === 'daily_bonus');
      const lastClaim = dailyRow?.claimed_at ? new Date(dailyRow.claimed_at).getTime() : 0;
      if (Date.now() - lastClaim < 24 * 60 * 60 * 1000) {
        return res.status(400).json({ error: 'already claimed' });
      }
      await claimQuestRow(LOCAL_PLAYER_ID, 'daily_bonus', 'none', 0);
      await ensureLocalPlayer();
      const { db } = await import('../db/index.js');
      await db.query('UPDATE players SET usdd_balance = usdd_balance + $1 WHERE id = $2', [DAILY_BONUS_AMOUNT, LOCAL_PLAYER_ID]);
      return res.json({ success: true, amount: DAILY_BONUS_AMOUNT });
    }

    if (questId.startsWith('emission_capture:')) {
      const [, coinId, thresholdStr] = questId.split(':');
      const threshold = Number(thresholdStr);
      const def = EMISSION_THRESHOLDS.find(t => t.threshold === threshold);
      if (!def) return res.status(400).json({ error: 'invalid threshold' });

      const portfolio = await computePortfolio(state, LOCAL_PLAYER_ID);
      const holding = portfolio.holdings.find(h => h.coinId === coinId);
      if (!holding || holding.pctEmission < threshold) {
        return res.status(400).json({ error: 'insufficient emission share' });
      }
      const progress = await getQuestProgress(LOCAL_PLAYER_ID);
      const already = progress.some(
        p => p.quest_type === 'emission_capture' && p.coin_id === coinId && p.threshold === threshold && p.claimed_at
      );
      if (already) return res.status(400).json({ error: 'already claimed' });

      await claimQuestRow(LOCAL_PLAYER_ID, 'emission_capture', coinId, threshold);
      const { db } = await import('../db/index.js');
      await db.query('UPDATE players SET usdd_balance = usdd_balance + $1 WHERE id = $2', [def.reward, LOCAL_PLAYER_ID]);
      return res.json({ success: true, amount: def.reward });
    }

    return res.status(400).json({ error: 'unknown quest' });
  });

  router.get('/shop/status', (req, res) => {
    res.json({ packages: SHOP_PACKAGES, rate: STARS_TO_USDD_RATE, remainingToday: remainingToday() });
  });

  // STUB: instantly credits USDD instead of charging real Telegram Stars.
  // Replace with a real Invoice API call (processStarPayment) before launch.
  router.post('/shop/purchase', async (req, res) => {
    const { starsAmount } = req.body as { starsAmount: number };
    if (!starsAmount || starsAmount <= 0) return res.status(400).json({ error: 'invalid amount' });
    const usddAmount = starsAmount * STARS_TO_USDD_RATE;
    if (usddAmount > remainingToday()) return res.status(400).json({ error: 'daily limit exceeded' });

    await ensureLocalPlayer();
    await processStarPayment(starsAmount, usddAmount);
    recordSpend(usddAmount);
    res.json({ success: true, usddCredited: usddAmount, remainingToday: remainingToday() });
  });

  router.get('/leaderboard', async (req, res) => {
    const league = String(req.query.league ?? RANKS[0].name);
    if (!RANKS.some(r => r.name === league)) return res.status(400).json({ error: 'unknown league' });
    const result = await computeLeaderboard(state, league);
    res.json({ league, ...result });
  });

  router.get('/ranks', (req, res) => {
    res.json({ ranks: RANKS.map(r => ({ name: r.name, min: r.min, max: Number.isFinite(r.max) ? r.max : null })) });
  });

  router.post('/debug/phase', (req, res) => {
    const { phase } = req.body as { phase: MacroPhase };
    if (!MACRO_ORDER.includes(phase)) return res.status(400).json({ error: 'unknown phase' });
    forcePhase(state, phase);
    res.json({ success: true, phase });
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
async function processStarPayment(starsAmount: number, usddAmount: number): Promise<void> {
  const { db } = await import('../db/index.js');
  await db.query('UPDATE players SET usdd_balance = usdd_balance + $1 WHERE id = $2', [usddAmount, LOCAL_PLAYER_ID]);
}
