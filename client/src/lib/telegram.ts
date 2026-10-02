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

const SESSION_TOKEN_KEY = 'crypto_sim_session_token';
const API_BASE = import.meta.env.VITE_API_BASE ?? '';
let memorySessionToken: string | null = null;
let bootstrapInFlight: Promise<string> | null = null;

function getInitData(): string | null {
  return window.Telegram?.WebApp?.initData || null;
}

function readSessionToken(): string | null {
  if (memorySessionToken) return memorySessionToken;
  try {
    memorySessionToken = sessionStorage.getItem(SESSION_TOKEN_KEY);
  } catch {
    memorySessionToken = null;
  }
  return memorySessionToken;
}

function storeSessionToken(token: string): void {
  memorySessionToken = token;
  try {
    sessionStorage.setItem(SESSION_TOKEN_KEY, token);
  } catch {
    // Keep the token for this page lifetime if sessionStorage is unavailable.
  }
}

export function clearSessionToken(expectedToken?: string): void {
  const current = readSessionToken();
  if (expectedToken && current !== expectedToken) return;
  memorySessionToken = null;
  try {
    sessionStorage.removeItem(SESSION_TOKEN_KEY);
  } catch {
    // No persistent token to remove.
  }
}

async function bootstrapSession(): Promise<string> {
  const initData = getInitData();
  if (!initData) throw new Error('Telegram authorization expired. Reopen the Mini App.');

  let response: Response;
  try {
    response = await fetch(`${API_BASE}/api/auth/bootstrap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData }),
    });
  } catch {
    throw new Error('Could not connect to the authentication server');
  }
  if (!response.ok) throw new Error('Telegram authorization expired. Reopen the Mini App.');

  const result = await response.json() as { sessionToken?: unknown };
  if (typeof result.sessionToken !== 'string') throw new Error('Invalid authentication response');
  storeSessionToken(result.sessionToken);
  return result.sessionToken;
}

function getOrBootstrapSession(): Promise<string> {
  const token = readSessionToken();
  if (token) return Promise.resolve(token);
  if (!bootstrapInFlight) {
    bootstrapInFlight = bootstrapSession().finally(() => { bootstrapInFlight = null; });
  }
  return bootstrapInFlight;
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

export async function getIdentityHeaders(): Promise<Record<string, string>> {
  if (getInitData() || readSessionToken()) {
    return { 'X-Session-Token': await getOrBootstrapSession() };
  }
  return { 'X-Dev-Player-Id': getDevPlayerId() };
}

export async function refreshIdentityHeaders(expiredToken: string): Promise<Record<string, string>> {
  clearSessionToken(expiredToken);
  if (!getInitData()) throw new Error('Telegram authorization expired. Reopen the Mini App.');
  return { 'X-Session-Token': await getOrBootstrapSession() };
}

export async function getIdentityForWs(): Promise<{ sessionToken: string } | { devPlayerId: string }> {
  if (getInitData() || readSessionToken()) return { sessionToken: await getOrBootstrapSession() };
  return { devPlayerId: getDevPlayerId() };
}
