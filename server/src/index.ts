import express from 'express';
import cors from 'cors';
import http from 'node:http';
import { createInitialState, change24hPct, Candle } from './engine/state.js';
import { startEngineLoop, fearGreedLabel, phaseProgress } from './engine/tick.js';
import { MACRO_CONFIG } from './engine/macroCycle.js';
import { price } from './engine/amm.js';
import { COINS } from './config/coins.js';
import { initDb } from './db/index.js';
import { ensureLocalPlayer, LOCAL_PLAYER_ID, getAllPoolSnapshots, savePoolSnapshot, getTotalHeldForCoin } from './db/queries.js';
import { seedNpcBotsIfNeeded, driftNpcBots } from './npc/bots.js';
import { createRouter } from './api/routes.js';
import { createWsServer } from './ws/server.js';
import { computePortfolio } from './api/helpers.js';

const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;

async function main() {
  await initDb();
  await ensureLocalPlayer();
  await seedNpcBotsIfNeeded();

  const state = createInitialState();

  // Resume pool reserves from the last snapshot instead of the fresh starting
  // reserves, so a restart doesn't re-issue supply that's already sold to players.
  const snapshots = await getAllPoolSnapshots();
  for (const snap of snapshots) {
    const cs = state.coins[snap.coin_id];
    if (cs) cs.pool = { coinReserve: snap.coin_reserve, usddReserve: snap.usdd_reserve };
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
    const maxAllowedReserve = Math.max(reachable - totalHeld, reachable * 0.0005);
    if (cs.pool.coinReserve > maxAllowedReserve) {
      const currentPrice = price(cs.pool);
      cs.pool.coinReserve = maxAllowedReserve;
      cs.pool.usddReserve = maxAllowedReserve * currentPrice;
    }
    // Seeds the long-horizon gravity anchor's "real participation" metric (see
    // gravity.ts) from the same real-holdings total used above, so background
    // drift never gets credited for price support that only real trades earned.
    cs.playerOwnedCoins = totalHeld;
  }

  async function persistPoolSnapshots() {
    for (const cfg of COINS) {
      const pool = state.coins[cfg.id].pool;
      await savePoolSnapshot(cfg.id, pool.coinReserve, pool.usddReserve).catch(() => {});
    }
  }

  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use('/api', createRouter(state));

  const httpServer = http.createServer(app);
  const { broadcast } = createWsServer(httpServer);

  startEngineLoop(state, () => {
    const coins = COINS.map(cfg => {
      const cs = state.coins[cfg.id];
      return {
        id: cfg.id,
        price: price(cs.pool),
        change24hPct: change24hPct(cs),
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
      },
    });

    computePortfolio(state, LOCAL_PLAYER_ID)
      .then(portfolio => broadcast('portfolio_updates', portfolio))
      .catch(() => {});

    // Push the in-progress candle for every coin each tick so the chart updates
    // live instead of the client having to poll the REST endpoint.
    const candles: { id: string; candle: Candle }[] = [];
    for (const cfg of COINS) {
      const cc = state.coins[cfg.id].currentCandle;
      if (cc) candles.push({ id: cfg.id, candle: cc });
    }
    broadcast('candle_updates', { candles });
  });

  setInterval(() => {
    driftNpcBots().catch(() => {});
  }, 60_000);

  setInterval(() => {
    persistPoolSnapshots().catch(() => {});
  }, 10_000);

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      persistPoolSnapshots().finally(() => process.exit(0));
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
