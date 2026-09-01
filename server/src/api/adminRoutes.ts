import { Router } from 'express';
import { getTradeLog } from '../db/queries.js';

// Deliberately its own router, mounted separately from createRouter's (see
// index.ts) — that one applies resolvePlayer to everything, which requires a
// real Telegram identity or a dev_-prefixed header (itself disabled outside
// dev via DEV_AUTH_ALLOWED). This endpoint exists specifically to debug
// PRODUCTION data with real players, so it can't depend on either: it's
// gated purely by a shared secret compared against ADMIN_DEBUG_SECRET,
// checked here and nowhere else.
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 2000;

export function createAdminRouter() {
  const router = Router();

  router.get('/trade-log', async (req, res) => {
    const expected = process.env.ADMIN_DEBUG_SECRET;
    const provided = req.header('X-Admin-Secret') ?? (typeof req.query.secret === 'string' ? req.query.secret : undefined);
    // No configured secret means this endpoint is unreachable, not "open" —
    // never fall through to allowing access just because the env var was
    // left unset on some deploy.
    if (!expected || provided !== expected) {
      return res.status(403).json({ error: 'forbidden' });
    }

    const playerId = typeof req.query.player_id === 'string' ? req.query.player_id : undefined;
    const coinId = typeof req.query.coin_id === 'string' ? req.query.coin_id : undefined;
    const requestedLimit = Number(req.query.limit);
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.min(Math.floor(requestedLimit), MAX_LIMIT) : DEFAULT_LIMIT;

    const trades = await getTradeLog({ playerId, coinId, limit });
    res.json({ trades, count: trades.length, limit });
  });

  return router;
}
