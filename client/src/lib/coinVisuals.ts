export const COIN_COLORS: Record<string, string> = {
  btcr: '#F7A93C',
  etn: '#6C7BFF',
  vlr: '#4FC3E8',
  arc: '#9B6BF2',
  zph: '#2FD98A',
  prsm: '#B06BF2',
  embr: '#F2994A',
  wlmb: '#F23C7C',
  hmst: '#F2C94C',
  dogx: '#C9A227',
  pepz: '#6FCF57',
};

export function coinColor(coinId: string): string {
  return COIN_COLORS[coinId] ?? '#8890AA';
}
