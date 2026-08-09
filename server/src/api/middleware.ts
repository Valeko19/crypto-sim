import { Request, Response, NextFunction } from 'express';
import { resolveIdentity } from '../auth/telegram.js';
import { isBetaAllowed, BETA_DENIED_MESSAGE } from '../auth/beta.js';
import { ensurePlayer, getPlayer } from '../db/queries.js';

declare global {
  namespace Express {
    interface Request {
      playerId: string;
    }
  }
}

export async function resolvePlayer(req: Request, res: Response, next: NextFunction) {
  const identity = resolveIdentity(req.header('X-Telegram-Init-Data') ?? undefined, req.header('X-Dev-Player-Id') ?? undefined);
  if (!identity) return res.status(401).json({ error: 'unauthorized' });

  // The beta allowlist only ever gates a brand-new player's FIRST visit —
  // anyone already in the database keeps playing exactly as before,
  // regardless of whether they're still on the list.
  const existing = await getPlayer(identity.playerId);
  if (!existing && !isBetaAllowed(identity)) {
    return res.status(403).json({ error: BETA_DENIED_MESSAGE });
  }

  await ensurePlayer(identity.playerId, identity.username);
  req.playerId = identity.playerId;
  next();
}
