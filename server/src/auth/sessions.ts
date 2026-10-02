import { createHash, randomBytes } from 'node:crypto';
import { db } from '../db/index.js';
import { getPlayer } from '../db/queries.js';
import { Identity } from './telegram.js';

export const SESSION_IDLE_TTL_MS = 12 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function tokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createAuthSession(playerId: string, nowMs = Date.now()): Promise<{
  sessionToken: string;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
}> {
  const sessionToken = randomBytes(32).toString('base64url');
  const absoluteExpiresAt = new Date(nowMs + SESSION_ABSOLUTE_TTL_MS);
  const idleExpiresAt = new Date(Math.min(nowMs + SESSION_IDLE_TTL_MS, absoluteExpiresAt.getTime()));
  await db.query(
    `INSERT INTO auth_sessions (token_hash, player_id, created_at, last_activity_at, idle_expires_at, absolute_expires_at)
     VALUES ($1, $2, $3, $3, $4, $5)`,
    [tokenDigest(sessionToken), playerId, new Date(nowMs), idleExpiresAt, absoluteExpiresAt]
  );
  return {
    sessionToken,
    idleExpiresAt: idleExpiresAt.toISOString(),
    absoluteExpiresAt: absoluteExpiresAt.toISOString(),
  };
}

export async function resolveAuthSession(token: string, nowMs = Date.now()): Promise<Identity | null> {
  if (!SESSION_TOKEN_PATTERN.test(token)) return null;
  const now = new Date(nowMs);
  const nextIdleExpiry = new Date(nowMs + SESSION_IDLE_TTL_MS);
  const res = await db.query<{ player_id: string }>(
    `UPDATE auth_sessions
     SET last_activity_at = $2, idle_expires_at = LEAST($3, absolute_expires_at)
     WHERE token_hash = $1 AND revoked_at IS NULL
       AND idle_expires_at > $2 AND absolute_expires_at > $2
     RETURNING player_id`,
    [tokenDigest(token), now, nextIdleExpiry]
  );
  if (!res.rows.length) return null;
  const player = await getPlayer(res.rows[0].player_id);
  if (!player) return null;
  return { playerId: player.id, username: player.username };
}

export async function isAuthSessionValid(token: string, nowMs = Date.now()): Promise<boolean> {
  if (!SESSION_TOKEN_PATTERN.test(token)) return false;
  const res = await db.query<{ valid: boolean }>(
    `SELECT TRUE AS valid FROM auth_sessions
     WHERE token_hash = $1 AND revoked_at IS NULL
       AND idle_expires_at > $2 AND absolute_expires_at > $2`,
    [tokenDigest(token), new Date(nowMs)]
  );
  return res.rows.length > 0;
}

export async function revokeAuthSession(token: string, nowMs = Date.now()): Promise<boolean> {
  if (!SESSION_TOKEN_PATTERN.test(token)) return false;
  const res = await db.query<{ token_hash: string }>(
    'UPDATE auth_sessions SET revoked_at = $2 WHERE token_hash = $1 AND revoked_at IS NULL RETURNING token_hash',
    [tokenDigest(token), new Date(nowMs)]
  );
  return res.rows.length > 0;
}