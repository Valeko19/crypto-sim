declare global {
  interface Window {
    Telegram?: {
      WebApp?: {
        ready(): void;
        expand(): void;
        initData: string;
      };
    };
  }
}

export function initTelegram(): void {
  window.Telegram?.WebApp?.ready();
  window.Telegram?.WebApp?.expand();
}

function getInitData(): string | null {
  return window.Telegram?.WebApp?.initData || null;
}

// Outside real Telegram (plain browser / dev tunnel), window.Telegram never
// exists — fall back to a per-browser random id persisted in localStorage so
// multiplayer can be built and tested (multiple browser profiles = multiple
// independent accounts) before a real Telegram bot exists. The 'dev_' prefix
// namespaces it away from real 'tg_<id>' identities on the server.
const DEV_ID_KEY = 'crypto_sim_dev_player_id';

function getDevPlayerId(): string {
  let id = localStorage.getItem(DEV_ID_KEY);
  if (!id) {
    id = 'dev_' + crypto.randomUUID();
    localStorage.setItem(DEV_ID_KEY, id);
  }
  return id;
}

export function getIdentityHeaders(): Record<string, string> {
  const initData = getInitData();
  return initData ? { 'X-Telegram-Init-Data': initData } : { 'X-Dev-Player-Id': getDevPlayerId() };
}

export function getIdentityForWs(): { initData: string } | { devPlayerId: string } {
  const initData = getInitData();
  return initData ? { initData } : { devPlayerId: getDevPlayerId() };
}
