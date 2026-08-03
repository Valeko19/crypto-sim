export const COIN_COLORS: Record<string, string> = {
  btcr: '#E3A63E', // Bitrix — gold
  etn: '#8B5CF6', // Vectra — purple
  vlr: '#2DD4BF', // Quantik — teal
  arc: '#3B82F6', // Substra — blue
  zph: '#22C55E', // Axion — green
  prsm: '#38BDF8', // Relay — sky blue
  embr: '#A0AEC0', // Slippage — silver grey
  wlmb: '#F0A93C', // Hamsterfly — golden orange
  hmst: '#1D4ED8', // Poseidon — deep ocean blue
  dogx: '#34D399', // Fomorrow — mint green
  pepz: '#F0483C', // Kazik — neon red-orange
};

export function coinColor(coinId: string): string {
  return COIN_COLORS[coinId] ?? '#8890AA';
}
