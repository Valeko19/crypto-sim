import type { PGliteInterface } from '@electric-sql/pglite';
import { db } from '../db/index.js';
import { DAILY_VOLUME_THRESHOLD } from '../config/quests.js';

type QueryClient = Pick<PGliteInterface, 'query'>;

export function utcDay(timestampMs = Date.now()): string {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

// Caller supplies the settlement transaction and its already captured UTC day.
// String(number) preserves the executed amount's decimal representation; never
// accumulate in binary64 or round individual executions to cents. Scale 324
// covers even 5e-324; 326 integer digits cover all finite doubles plus headroom
// for daily aggregation. NUMERIC storage depends on actual significant digits.
export async function recordTradeVolume(client: QueryClient, playerId: string, day: string, usddAmount: number): Promise<void> {
  if (!Number.isFinite(usddAmount) || usddAmount <= 0) throw new RangeError('invalid executed volume');
  await client.query(`INSERT INTO player_daily_volume (player_id, utc_day, volume)
    VALUES ($1, $2::date, $3::numeric)
    ON CONFLICT (player_id, utc_day) DO UPDATE
    SET volume = player_daily_volume.volume + EXCLUDED.volume`, [playerId, day, String(usddAmount)]);
}

export async function dailyVolumeProgress(playerId: string, client: QueryClient = db, day = utcDay()): Promise<{ current: number; met: boolean }> {
  const result = await client.query<{ volume: string; met: boolean }>(
    `SELECT volume::text, volume >= $3::numeric AS met FROM player_daily_volume
     WHERE player_id = $1 AND utc_day = $2::date`, [playerId, day, String(DAILY_VOLUME_THRESHOLD)]);
  const row = result.rows[0];
  // Number is only the existing UI display format. Financial eligibility uses
  // the exact SQL comparison, never this potentially rounded display value.
  return row ? { current: Number(row.volume), met: row.met } : { current: 0, met: false };
}

export async function todaysVolume(playerId: string): Promise<number> {
  return (await dailyVolumeProgress(playerId)).current;
}
