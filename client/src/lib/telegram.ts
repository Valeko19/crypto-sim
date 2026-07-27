// STUB: no real Telegram auth yet — everything runs as a single local test
// profile (@local_player) so the app can be exercised in a plain browser.
// When Telegram integration lands, initialize the Telegram Web App SDK here
// (window.Telegram.WebApp.ready(), read initData for the real user, expand(),
// set the theme from Telegram's colorScheme, etc.) and export the real user
// in place of LOCAL_PLAYER.
export const LOCAL_PLAYER_USERNAME = '@local_player';

export function initTelegramStub(): void {
  // no-op placeholder — intentionally empty until real SDK wiring is added
}
