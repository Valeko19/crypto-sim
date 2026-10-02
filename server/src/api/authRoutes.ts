import { Router } from 'express';
import { getPlayer, ensurePlayer } from '../db/queries.js';
import { isBetaAllowed, BETA_DENIED_MESSAGE } from '../auth/beta.js';
import { resolveIdentity } from '../auth/telegram.js';
import { createAuthSession } from '../auth/sessions.js';

export function createAuthRouter() {
  const router = Router();

  router.post('/bootstrap', async (req, res) => {
    const initData = req.body?.initData;
    if (typeof initData !== 'string' || !initData) return res.status(400).json({ error: 'missing initData' });

    const identity = resolveIdentity(initData);
    if (!identity) return res.status(401).json({ error: 'unauthorized' });

    const existing = await getPlayer(identity.playerId);
    if (!existing && !isBetaAllowed(identity)) {
      return res.status(403).json({ error: BETA_DENIED_MESSAGE });
    }

    await ensurePlayer(identity.playerId, identity.username);
    const session = await createAuthSession(identity.playerId);
    res.json(session);
  });

  return router;
}