import { DAILY_LIMIT_USDD } from '../config/shop.js';

const spendByPlayer = new Map<string, { day: string; spent: number }>();

export function remainingToday(playerId: string): number {
  const today = new Date().toISOString().slice(0, 10);
  const entry = spendByPlayer.get(playerId);
  const spent = entry?.day === today ? entry.spent : 0;
  return Math.max(0, DAILY_LIMIT_USDD - spent);
}

export function recordSpend(playerId: string, usddAmount: number): void {
  const today = new Date().toISOString().slice(0, 10);
  const entry = spendByPlayer.get(playerId);
  if (entry?.day === today) entry.spent += usddAmount;
  else spendByPlayer.set(playerId, { day: today, spent: usddAmount });
}
