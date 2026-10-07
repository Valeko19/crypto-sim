import express from 'express';
import cors from 'cors';
import http from 'node:http';
import { createInitialState, recentChangePct, Candle } from './engine/state.js';
import { startEngineLoop, fearGreedLabel, phaseProgress } from './engine/tick.js';
import { MACRO_CONFIG } from './engine/macroCycle.js';
import { price, limitPoolSupply } from './engine/amm.js';
import { COINS } from './config/coins.js';
import { db, initDb } from './db/index.js';
import { startDbMaintenance } from './db/maintenance.js';
import { getAllPoolSnapshots, getTotalHeldForCoin, pruneOldTradeLogEntries } from './db/queries.js';
import { createRouter } from './api/routes.js';
import { createAuthRouter } from './api/authRoutes.js';
import { createAdminRouter } from './api/adminRoutes.js';
import { createWsServer } from './ws/server.js';
import { computeAllPortfolios } from './api/helpers.js';
import { distributeStakingRewards } from './engine/staking.js';
import { STAKING_DISTRIBUTION_INTERVAL_MS } from './config/staking.js';
import { runTradingBots } from './engine/tradingBot.js';
import { BOT_POLL_INTERVAL_MS } from './config/tradingBot.js';
import { checkRankUpRewards } from './engine/rankRewards.js';
import { maybeRunPlayerResetOnBoot } from './admin/playerReset.js';
import { persistPoolSnapshots } from './engine/poolPersistence.js';
import { commitMarketMutation } from './engine/marketValuation.js';

const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;

async function main() {
  await initDb();
  await maybeRunPlayerResetOnBoot();

  const state = createInitialState();

  // Resume pool reserves from the last snapshot instead of the fresh starting
  // reserves, so a restart doesn't re-issue supply that's already sold to players.
  const snapshots = await getAllPoolSnapshots();
  for (const snap of snapshots) {
    const cs = state.coins[snap.coin_id];
    if (cs) cs.pool = {
      coinReserve: snap.coin_reserve, usddReserve: snap.usdd_reserve,
      ...(snap.reference_price != null ? { referencePrice: snap.reference_price } : {}),
    };
  }

  // Safety net, independent of whether a snapshot existed: the pool must never
  // hold more reachable supply than emission minus what players already own —
  // otherwise a fresh/reset pool re-issues coins that are already someone's
  // holdings, letting cumulative ownership exceed 100% of emission. Enforced
  // unconditionally on every boot so this can't regress again.
  for (const cfg of COINS) {
    const cs = state.coins[cfg.id];
    const reachable = cfg.emission * (1 - cfg.npcLockedPct);
    const totalHeld = await getTotalHeldForCoin(cfg.id);
    limitPoolSupply(cs.pool, reachable, totalHeld, cfg.startPrice);
    // Seeds the long-horizon gravity anchor's "real participation" metric (see
    // gravity.ts) from the same real-holdings total used above, so background
    // drift never gets credited for price support that only real trades earned.
    cs.playerOwnedCoins = totalHeld;
  }

  // Reconcile valuation prices with restored/supply-limited pools before serving.
  await commitMarketMutation(state, () => {});
  const maintenance = startDbMaintenance(db);
  await maintenance.runNow();
  const app = express();
  app.use(cors());
  app.use(express.json());
  // Mounted BEFORE the main /api router and deliberately NOT behind
  // resolvePlayer (see adminRoutes.ts) — must keep working in production
  // with real player data. Registration order matters here: the main
  // router's resolvePlayer is unconditional (`router.use`, no path) for
  // anything under /api, including /api/admin/* if that were tried first —
  // mounting admin first lets it fully handle its own path before the main
  // router ever sees the request.
  app.use('/api/admin', createAdminRouter());
  app.use('/api/auth', createAuthRouter());
  app.use('/api', createRouter(state));

  const httpServer = http.createServer(app);
  const { broadcast, sendToPlayer, getConnectedPlayerIds, wss } = createWsServer(httpServer);
  let stopping = false;
  const background = new Set<Promise<unknown>>();
  function track(work: Promise<unknown>) {
    const settled = work.catch(() => {}).finally(() => { background.delete(settled); });
    background.add(settled);
  }

  const engineTimer = startEngineLoop(state, () => {
    if (stopping) return;
    const coins = COINS.map(cfg => {
      const cs = state.coins[cfg.id];
      return {
        id: cfg.id,
        price: price(cs.pool),
        changePct: recentChangePct(cs),
      };
    });
    broadcast('price_updates', {
      coins,
      marketStatus: {
        phase: state.macroPhase,
        phaseLabel: MACRO_CONFIG[state.macroPhase].label,
        fearGreedIndex: state.fearGreedIndex,
        fearGreedLabel: fearGreedLabel(state.fearGreedIndex),
        ...phaseProgress(state),
        activeNews: state.activeNewsBanner,
      },
    });

    track(computeAllPortfolios(state)
      .then(async portfolios => {
        if (stopping) return;
        const sends: Promise<unknown>[] = [];
        for (const playerId of getConnectedPlayerIds()) {
          const view = portfolios.get(playerId);
          if (view) sends.push(sendToPlayer(playerId, 'portfolio_updates', view));
        }
        await Promise.allSettled([...sends, checkRankUpRewards(portfolios)]);
      }));

    // Push the in-progress candle for every coin each tick so the chart updates
    // live instead of the client having to poll the REST endpoint.
    const candles: { id: string; candle: Candle }[] = [];
    for (const cfg of COINS) {
      const cc = state.coins[cfg.id].currentCandle;
      if (cc) candles.push({ id: cfg.id, candle: cc });
    }
    broadcast('candle_updates', { candles });
  });

  const poolTimer = setInterval(() => {
    if (!stopping) track(persistPoolSnapshots(state));
  }, 10_000);

  const stakingTimer = setInterval(() => {
    if (!stopping) track(distributeStakingRewards(state));
  }, STAKING_DISTRIBUTION_INTERVAL_MS);

  const botTimer = setInterval(() => {
    if (!stopping) track(runTradingBots(state));
  }, BOT_POLL_INTERVAL_MS);

  // Keeps trade_log (see db/index.ts) from growing unbounded — once at boot
  // covers a server that restarts often (dev), the daily interval covers one
  // that doesn't (prod running for weeks between deploys).
  track(pruneOldTradeLogEntries());
  const pruneTimer = setInterval(() => {
    if (!stopping) track(pruneOldTradeLogEntries());
  }, 24 * 60 * 60 * 1000);

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      for (const timer of [engineTimer, poolTimer, stakingTimer, botTimer, pruneTimer]) clearInterval(timer);
      const maintenanceStopped = maintenance.stop();
      for (const socket of wss.clients) socket.terminate();
      const socketsClosed = new Promise<void>(resolve => wss.close(() => resolve()));
      const httpClosed = new Promise<void>(resolve => httpServer.close(() => resolve()));
      void (async () => {
        await Promise.all([maintenanceStopped, socketsClosed, httpClosed]);
        await Promise.all(background);
        // The market-lock barrier also drains the at-most-one admitted tick.
        // Keep the existing final snapshot path until its removal is audited.
        await persistPoolSnapshots(state);
        await db.close();
      })().then(() => process.exit(0), error => {
        console.error('Shutdown failed', error);
        process.exit(1);
      });
    });
  }

  httpServer.listen(PORT, () => {
    console.log(`crypto-sim server listening on http://localhost:${PORT}`);
  });
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
