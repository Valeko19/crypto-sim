import { db } from '../db/index.js';
import { getQuestProgress, claimQuestRow, getHolding, getHighestLeagueIndex, addEarnedTotal, type EarnedCategory } from '../db/queries.js';
import { COIN_MAP } from '../config/coins.js';
import { DAILY_BONUS_AMOUNT, DAILY_VOLUME_REWARD, DAILY_VOLUME_THRESHOLD, EMISSION_THRESHOLDS } from '../config/quests.js';
import { RANKS, RANK_UP_REWARDS } from '../config/ranks.js';
import { todaysVolume } from './dailyVolume.js';

export class QuestClaimError extends Error {}

export async function claimQuest(playerId: string, questId: unknown): Promise<number> {
  if (typeof questId !== 'string') throw new QuestClaimError('unknown quest');
  return db.transaction(async tx => {
    // The player row always exists, including for the first-ever claim. Lock
    // it before reading eligibility; locking a missing quest row cannot work.
    const player = await tx.query('SELECT id FROM players WHERE id = $1 FOR UPDATE', [playerId]);
    if (!player.rows.length) throw new QuestClaimError('player not found');
    const progress = await getQuestProgress(playerId, tx);
    let questType: string;
    let threshold = 0;
    let reward: number;
    let category: EarnedCategory;

    if (questId === 'daily_bonus' || questId === 'daily_volume') {
      questType = questId;
      const row = progress.find(p => p.quest_type === questType);
      const lastClaim = row?.claimed_at ? new Date(row.claimed_at).getTime() : 0;
      if (Date.now() - lastClaim < 24 * 60 * 60 * 1000) throw new QuestClaimError('already claimed');
      if (questId === 'daily_volume' && todaysVolume(playerId) < DAILY_VOLUME_THRESHOLD) {
        throw new QuestClaimError('insufficient volume');
      }
      reward = questId === 'daily_bonus' ? DAILY_BONUS_AMOUNT : DAILY_VOLUME_REWARD;
      category = 'daily';
    } else if (questId.startsWith('emission_capture:')) {
      const [, coinId, thresholdStr] = questId.split(':');
      threshold = Number(thresholdStr);
      const def = EMISSION_THRESHOLDS.find(t => t.threshold === threshold);
      if (!def) throw new QuestClaimError('invalid threshold');
      const holding = await getHolding(playerId, coinId, tx);
      const coin = COIN_MAP[coinId];
      if (!holding || !coin || (holding.amount / coin.emission) * 100 < threshold) {
        throw new QuestClaimError('insufficient emission share');
      }
      questType = 'emission_capture';
      reward = def.reward;
      category = 'emission';
    } else if (questId.startsWith('rank_reward:')) {
      threshold = Number(questId.split(':')[1]);
      reward = RANK_UP_REWARDS[threshold] ?? 0;
      if (!Number.isInteger(threshold) || threshold <= 0 || threshold >= RANKS.length || reward <= 0) {
        throw new QuestClaimError('invalid rank');
      }
      if (await getHighestLeagueIndex(playerId, tx) < threshold) throw new QuestClaimError('rank not yet achieved');
      questType = 'rank_reward';
      category = 'rank';
    } else {
      throw new QuestClaimError('unknown quest');
    }

    // Also recognize legacy emission markers stored under an actual coin_id.
    // New markers use 'none', i.e. (player, quest type, threshold) as the key.
    if (category !== 'daily' && progress.some(p => p.quest_type === questType && p.threshold === threshold && p.claimed_at)) {
      throw new QuestClaimError('already claimed');
    }
    await claimQuestRow(tx, playerId, questType, threshold);
    await tx.query('UPDATE players SET usdd_balance = usdd_balance + $1 WHERE id = $2', [reward, playerId]);
    await addEarnedTotal(playerId, category, reward, tx);
    return reward;
  });
}
