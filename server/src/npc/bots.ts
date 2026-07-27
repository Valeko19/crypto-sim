import { RANKS, rankForNetWorth } from '../config/ranks.js';
import { countNpcBots, insertNpcBot, listNpcBots, updateNpcBot, NpcBotRow } from '../db/queries.js';

const NAME_PREFIXES = [
  'ape', 'trader', 'moon', 'crypto', 'whale', 'degen', 'satoshi', 'diamond', 'bull', 'bear',
  'pump', 'hodl', 'shark', 'ninja', 'yolo', 'chart', 'signal', 'alpha', 'rocket', 'coin',
];
const NAME_SUFFIXES = [
  'jr', 'hunter', 'king', 'lord', '88', '2077', 'pro', 'x', 'master', 'wolf',
  'gang', 'baron', 'legend', 'sensei', '007', 'capital', 'labs', 'fund', 'god', 'og',
];

function randomUsername(used: Set<string>): string {
  let name: string;
  do {
    const prefix = NAME_PREFIXES[Math.floor(Math.random() * NAME_PREFIXES.length)];
    const suffix = NAME_SUFFIXES[Math.floor(Math.random() * NAME_SUFFIXES.length)];
    name = `@${prefix}_${suffix}`;
  } while (used.has(name));
  used.add(name);
  return name;
}

// Stratified so every league has a handful of bots, per spec ("рейтинг заполнен NPC-ботами").
const BOTS_PER_LEAGUE_RANGE: [number, number] = [2, 4];

function sampleNetWorthInLeague(min: number, max: number): number {
  const cappedMax = Number.isFinite(max) ? max : min * 12;
  // log-uniform so bots don't all cluster at the low end of a wide league band
  const logMin = Math.log(Math.max(min, 1));
  const logMax = Math.log(cappedMax);
  const t = Math.random();
  return Math.exp(logMin + t * (logMax - logMin));
}

export async function seedNpcBotsIfNeeded(): Promise<void> {
  const existing = await countNpcBots();
  if (existing > 0) return;

  const used = new Set<string>();
  let n = 0;
  for (const rank of RANKS) {
    const count = Math.floor(Math.random() * (BOTS_PER_LEAGUE_RANGE[1] - BOTS_PER_LEAGUE_RANGE[0] + 1)) + BOTS_PER_LEAGUE_RANGE[0];
    for (let i = 0; i < count; i++) {
      const netWorth = sampleNetWorthInLeague(Math.max(rank.min, 50), rank.max);
      const bot: NpcBotRow = {
        id: `bot_${n++}`,
        username: randomUsername(used),
        simulated_net_worth: netWorth,
        league: rankForNetWorth(netWorth).name,
      };
      await insertNpcBot(bot);
    }
  }
}

export async function driftNpcBots(): Promise<void> {
  const bots = await listNpcBots();
  for (const bot of bots) {
    const changePct = (Math.random() * 3.5 - 0.5 + (Math.random() < 0.5 ? -1 : 1) * Math.random() * 1.5) / 100;
    // roughly ±0.5-3%, direction random
    const clamped = Math.max(-0.03, Math.min(0.03, changePct));
    const newNetWorth = Math.max(10, bot.simulated_net_worth * (1 + clamped));
    const league = rankForNetWorth(newNetWorth).name;
    await updateNpcBot(bot.id, newNetWorth, league);
  }
}
