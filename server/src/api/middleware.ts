import { Request, Response, NextFunction } from 'express';
import { resolveIdentity } from '../auth/telegram.js';
import { ensurePlayer } from '../db/queries.js';

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
  await ensurePlayer(identity.playerId, identity.username);
  req.playerId = identity.playerId;
  next();
}
