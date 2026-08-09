import { createHmac } from 'node:crypto';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
// Dev mode is only allowed outside production (or an explicit ALLOW_DEV_AUTH=1)
// — a missing/mistyped token on a real deploy should fail loudly, not
// silently downgrade to a mode with no signature check at all. Also reused
// by routes.ts to gate debug/QA routes that mutate shared market state
// (e.g. /debug/phase) — those must never be reachable by real players either.
export const DEV_AUTH_ALLOWED = process.env.NODE_ENV !== 'production' || process.env.ALLOW_DEV_AUTH === '1';

export interface Identity {
  playerId: string;
  username: string;
}

// Telegram's documented Mini App initData verification algorithm:
// secret_key = HMAC_SHA256(key="WebAppData", data=bot_token)
// hash = HMAC_SHA256(key=secret_key, data=data_check_string)
// where data_check_string is every field except `hash`, sorted alphabetically
// by key and newline-joined as "key=value".
function validateInitData(initData: string): Identity | null {
  if (!BOT_TOKEN) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secretKey = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const computedHash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  if (computedHash !== hash) return null;
  const userJson = params.get('user');
  if (!userJson) return null;
  const user = JSON.parse(userJson);
  return {
    playerId: `tg_${user.id}`,
    username: user.username ? `@${user.username}` : String(user.first_name ?? user.id),
  };
}

// devPlayerId is trusted as-is, but ONLY when dev mode is allowed and the id
// carries the 'dev_' namespace prefix — this keeps it from ever colliding
// with a real 'tg_<id>' identity.
export function resolveIdentity(initData?: string, devPlayerId?: string): Identity | null {
  if (initData) return validateInitData(initData);
  if (devPlayerId && DEV_AUTH_ALLOWED && devPlayerId.startsWith('dev_')) {
    return { playerId: devPlayerId, username: devPlayerId };
  }
  return null;
}
