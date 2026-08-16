// Resets every coin's AMM pool back to its pristine config-derived starting
// reserves (same formula as createInitialState in engine/state.ts) via the
// dev-only POST /debug/restore-pools endpoint. Player accounts/holdings/
// quest progress are untouched — this only resets MARKET state (prices).
//
// Useful after heavy market-moving dev testing (e.g. scripts/tests, which
// otherwise snapshots/restores pools around its own fast-forward runs, but
// won't undo drift from manual poking or runs from before that safeguard
// existed). Run: npx tsx scripts/reset-market-pools.ts
import { COINS } from '../src/config/coins.js';

const BASE = process.env.TEST_SERVER_URL ?? 'http://localhost:8787';

async function main() {
  const pools: Record<string, { coinReserve: number; usddReserve: number; playerOwnedCoins: number }> = {};
  for (const cfg of COINS) {
    const coinReserve = cfg.emission * (1 - cfg.npcLockedPct);
    const usddReserve = coinReserve * cfg.startPrice;
    // Also zeroes gravity.ts's playerOwnedCoins anchor — otherwise a coin
    // that was previously bought up heavily (e.g. by scripts/tests' test 4)
    // keeps a wildly inflated justifiedPrice() target even after the pool
    // reserves themselves look normal again (dev test players' own small
    // real holdings are negligible next to a full reset baseline).
    pools[cfg.id] = { coinReserve, usddReserve, playerOwnedCoins: 0 };
  }

  const res = await fetch(`${BASE}/api/debug/restore-pools`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Dev-Player-Id': 'dev_market_reset_script' },
    body: JSON.stringify({ pools }),
  });
  const body = await res.json();
  if (!res.ok) {
    console.error(`Не удалось сбросить пулы: HTTP ${res.status}`, body);
    process.exit(1);
  }
  console.log(`Пулы всех ${COINS.length} монет сброшены на изначальные резервы из config/coins.ts.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
