export const TRADING_BOT_PRICE_STARS = 2000;
export const MIN_BOT_INTERVAL_MS = 1_000;
// Must poll strictly faster than MIN_BOT_INTERVAL_MS, not just equal to it —
// polling at the exact same rate as a 1s-interval bot creates a beat/aliasing
// effect (next_run_at drifts just past each poll tick, so it's only caught
// every other tick, halving the effective rate). Polling at a quarter of the
// floor keeps a 1s bot firing on time.
export const BOT_POLL_INTERVAL_MS = 250;
