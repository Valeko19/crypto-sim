import { Router } from 'express';
import { getPlayer, ensurePlayer } from '../db/queries.js';
import { isBetaAllowed, BETA_DENIED_MESSAGE } from '../auth/beta.js';
import { resolveIdentity } from '../auth/telegram.js';
import { createAuthSession, resolveAuthSession } from '../auth/sessions.js';

export function createAuthRouter() {
  const router = Router();
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.get('/session', async (req, res) => {
    const token = req.header('X-Session-Token');
    const identity = token ? await resolveAuthSession(token) : null;
    if (!identity || !identity.playerId.startsWith('tg_')) return res.status(401).json({ error: 'unauthorized' });
    res.json({ playerId: identity.playerId, telegramUserId: identity.playerId.slice(3) });
  });

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
    res.json({ ...session, playerId: identity.playerId, telegramUserId: identity.playerId.slice(3) });
  });

  return router;
}
