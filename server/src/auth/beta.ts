import { BETA_ALLOWLIST } from '../config/beta.js';
import { Identity } from './telegram.js';

export const BETA_DENIED_MESSAGE = 'Игра пока в закрытой бете. Обратитесь к организатору за приглашением.';

// Gates only a brand-new player's first-ever visit (callers must check that
// separately, e.g. via getPlayer) — anyone already in the database is never
// affected by this, regardless of whether they're still on the list.
// Dev identities (plain-browser testing, not real Telegram) are always
// exempt, so nothing needs to be added here for local testing.
export function isBetaAllowed(identity: Identity): boolean {
  if (identity.playerId.startsWith('dev_')) return true;
  if (!BETA_ALLOWLIST) return true;
  const normalized = identity.username.replace(/^@/, '').toLowerCase();
  return BETA_ALLOWLIST.has(normalized);
}
