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

// Rive (.riv) idle animation per rank, served from client/public/ranks/ — only
// filled in as each rank's animation is actually produced. Adding a new one
// later is just: drop the file in public/ranks/ and add one line here, no
// component changes (see RankBadge, which falls back to the static emoji
// above for any rank not listed here yet).
export const RANK_ANIMATIONS: Record<string, string> = {
  'Креветка': '/ranks/shrimp_idle.riv',
};

export function rankAnimationSrc(name: string): string | null {
  return RANK_ANIMATIONS[name] ?? null;
}
