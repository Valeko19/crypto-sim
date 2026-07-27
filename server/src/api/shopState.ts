import { DAILY_LIMIT_USDD } from '../config/shop.js';

let currentDay = new Date().toISOString().slice(0, 10);
let spentToday = 0;

function rollDayIfNeeded() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== currentDay) {
    currentDay = today;
    spentToday = 0;
  }
}

export function remainingToday(): number {
  rollDayIfNeeded();
  return Math.max(0, DAILY_LIMIT_USDD - spentToday);
}

export function recordSpend(usddAmount: number): void {
  rollDayIfNeeded();
  spentToday += usddAmount;
}
