export const RANK_EMOJI: Record<string, string> = {
  'Планктон': '🦠',
  'Креветка': '🦐',
  'Краб': '🦀',
  'Осьминог': '🐙',
  'Дельфин': '🐬',
  'Акула': '🦈',
  'Касатка': '🐋',
  'Кит': '🐳',
  'Кракен': '🦑',
};

export function rankEmoji(name: string): string {
  return RANK_EMOJI[name] ?? '❓';
}
