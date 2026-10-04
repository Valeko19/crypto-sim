import type { PGliteInterface } from '@electric-sql/pglite';
import { RANKS } from '../config/ranks.js';
import { price, type Pool } from '../engine/amm.js';
import type { EngineState } from '../engine/state.js';

type Client = Pick<PGliteInterface, 'query'>;

// Called inside the SAME transaction as settlement, before live publication.
export async function saveValuationPrices(tx: Client, state: EngineState, override?: { coinId: string; pool: Pool }) {
  const rows = Object.entries(state.coins).map(([coinId, cs]) => {
    const value = price(override?.coinId === coinId ? override.pool : cs.pool);
    if (!Number.isFinite(value) || value <= 0) throw new Error('invalid valuation price');
    return { coin_id: coinId, price: value };
  });
  await tx.query(`INSERT INTO market_valuation_prices (coin_id, price)
    SELECT coin_id, price FROM jsonb_to_recordset($1::jsonb) AS p(coin_id text, price double precision)
    ON CONFLICT (coin_id) DO UPDATE SET price = EXCLUDED.price`, [JSON.stringify(rows)]);
}

// One set-based query for all affected players; never N player transactions.
export async function recordRankPeaks(tx: Client, playerId?: string) {
  await tx.query(`WITH worth AS (
    SELECT p.id, p.usdd_balance + COALESCE(SUM(h.amount * v.price ORDER BY h.coin_id COLLATE "C"), 0) AS total
    FROM players p LEFT JOIN player_holdings h ON h.player_id = p.id
    LEFT JOIN market_valuation_prices v ON v.coin_id = h.coin_id
    WHERE ($1::text IS NULL OR p.id = $1) GROUP BY p.id, p.usdd_balance
  ), reached AS (
    SELECT w.id, MAX(r.idx) AS idx FROM worth w
    JOIN jsonb_to_recordset($2::jsonb) AS r(idx integer, minimum double precision) ON w.total >= r.minimum
    GROUP BY w.id
  ) INSERT INTO player_rank_progress (player_id, highest_league_index)
    SELECT id, idx FROM reached WHERE idx > 0
    ON CONFLICT (player_id) DO UPDATE
    SET highest_league_index = GREATEST(player_rank_progress.highest_league_index, EXCLUDED.highest_league_index)
    WHERE EXCLUDED.highest_league_index > player_rank_progress.highest_league_index`,
  [playerId ?? null, JSON.stringify(RANKS.map((r, idx) => ({ idx, minimum: r.min })))]);
}
