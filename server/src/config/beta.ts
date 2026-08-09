// Comma-separated Telegram usernames (without @), settable in Render's
// Environment tab without a redeploy. Unset entirely means the gate is off —
// open to everyone — so this never affects local dev until someone
// deliberately turns it on.
const raw = process.env.BETA_ALLOWLIST;
export const BETA_ALLOWLIST: Set<string> | null = raw
  ? new Set(
      raw
        .split(',')
        .map(s => s.trim().replace(/^@/, '').toLowerCase())
        .filter(Boolean)
    )
  : null;
