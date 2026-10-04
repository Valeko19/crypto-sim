import { db } from './index.js';

export async function getGameEpoch(): Promise<string> {
  const result = await db.query<{epoch: string}>('SELECT epoch FROM game_epoch WHERE singleton=TRUE');
  if (!result.rows[0]) throw new Error('Missing game epoch');
  return result.rows[0].epoch;
}
