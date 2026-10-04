declare global {
  interface Window {
    Telegram?: { WebApp?: { ready(): void; expand(): void; initData: string } };
  }
}
const SESSION_KEY = 'crypto_sim_session_v2';
const LEGACY_KEY = 'crypto_sim_session_token';
const API_BASE = import.meta.env.VITE_API_BASE ?? '';
type Identity = { kind: 'telegram'; id: string } | { kind: 'dev'; id: string };
export interface AuthContext { readonly generation: number; readonly identity: Identity | null }
interface Session { telegramUserId: string; token: string }
let context: AuthContext = { generation: 0, identity: null };
let session: Session | null = null;
let gameEpoch: string | null = null;
export function captureGameEpoch() { return gameEpoch; }
function acceptGameEpoch(value: unknown) {
  // Epoch 0 is the pre-reset compatibility epoch for older server versions.
  const next = typeof value === 'string' ? value : '0';
  const changed = gameEpoch !== null && gameEpoch !== next;
  gameEpoch = next;
  if (changed) {
    context = { ...context, generation: context.generation + 1 };
    inFlight = null;
    for (const controller of requests) controller.abort();
    requests.clear();
    for (const listener of listeners) listener();
    for (const listener of snapshotListeners) listener();
  }
}
let inFlight: { context: AuthContext; promise: Promise<string> } | null = null;
let devId: string | null = null;
let lastInitData: string | undefined;
let parsedIdentity: Identity | null = null;
const listeners = new Set<() => void>();
const snapshotListeners = new Set<() => void>();
const requests = new Set<AbortController>();
interface AuthSnapshot extends AuthContext { readonly authenticated: boolean }
let snapshot: AuthSnapshot = { ...context, authenticated: false };

export class AuthChangedError extends Error {
  constructor() { super('Account changed; request cancelled'); }
}
function readIdentity(): Identity | null {
  const initData = window.Telegram?.WebApp?.initData;
  if (initData) {
    if (initData === lastInitData) return parsedIdentity;
    lastInitData = initData;
    parsedIdentity = null;
    try {
      const user = JSON.parse(new URLSearchParams(initData).get('user') ?? 'null');
      if (Number.isSafeInteger(user?.id) && user.id > 0) parsedIdentity = { kind: 'telegram', id: String(user.id) };
    } catch { /* Unknown identity must never reuse a bearer. */ }
    return parsedIdentity;
  }
  lastInitData = undefined;
  parsedIdentity = null;
  if (!import.meta.env.DEV) return null;
  if (!devId) {
    try { devId = localStorage.getItem('crypto_sim_dev_player_id'); } catch { /* unavailable */ }
    if (!devId?.startsWith('dev_')) devId = 'dev_' + crypto.randomUUID();
    try { localStorage.setItem('crypto_sim_dev_player_id', devId); } catch { /* memory only */ }
  }
  return { kind: 'dev', id: devId };
}
export function captureAuthContext(): AuthContext {
  const next = readIdentity();
  if (next?.kind !== context.identity?.kind || next?.id !== context.identity?.id) {
    context = { generation: context.generation + 1, identity: next };
    session = null;
    inFlight = null;
    for (const controller of requests) controller.abort();
    requests.clear();
    for (const listener of listeners) listener();
    for (const listener of snapshotListeners) listener();
  }
  return context;
}
// Every read checks the current host identity, even before a lifecycle event or poll.
// Keep the snapshot reference stable between actual context/session changes.
export function getAuthSnapshot(): AuthSnapshot {
  const current = captureAuthContext();
  const authenticated = current.identity?.kind === 'dev'
    || (current.identity?.kind === 'telegram' && session?.telegramUserId === current.identity.id);
  if (snapshot.generation !== current.generation || snapshot.authenticated !== authenticated) {
    snapshot = { ...current, authenticated };
  }
  return snapshot;
}
export function subscribeAuthSnapshot(listener: () => void): () => void {
  snapshotListeners.add(listener);
  return () => { snapshotListeners.delete(listener); };
}
export function subscribeAuth(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function isAuthContextCurrent(expected: AuthContext): boolean {
  return captureAuthContext() === expected;
}
export function assertAuthContext(expected: AuthContext): void {
  if (!isAuthContextCurrent(expected)) throw new AuthChangedError();
}
export function authRequest(expected: AuthContext) {
  assertAuthContext(expected);
  const controller = new AbortController();
  requests.add(controller);
  return { signal: controller.signal, release: () => { requests.delete(controller); } };
}
export function initTelegram(): () => void {
  window.Telegram?.WebApp?.ready();
  window.Telegram?.WebApp?.expand();
  captureAuthContext();
  const refresh = () => { captureAuthContext(); };
  window.addEventListener('focus', refresh);
  window.addEventListener('pageshow', refresh);
  document.addEventListener('visibilitychange', refresh);
  const timer = setInterval(refresh, 250);
  return () => {
    clearInterval(timer);
    window.removeEventListener('focus', refresh);
    window.removeEventListener('pageshow', refresh);
    document.removeEventListener('visibilitychange', refresh);
  };
}
function readCachedSession(): Session | null {
  try {
    sessionStorage.removeItem(LEGACY_KEY);
    const value = JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? 'null');
    if (typeof value?.telegramUserId === 'string' && typeof value?.token === 'string') return value;
  } catch { /* No unowned fallback when storage is blocked or malformed. */ }
  return null;
}
export function clearSessionToken(expectedToken?: string): void {
  const cached = readCachedSession();
  if (!expectedToken || session?.token === expectedToken) session = null;
  if (!expectedToken || cached?.token === expectedToken) {
    try { sessionStorage.removeItem(SESSION_KEY); } catch { /* memory only */ }
  }
}
function confirmedOwner(body: { telegramUserId?: unknown; playerId?: unknown }, expected: AuthContext): boolean {
  return expected.identity?.kind === 'telegram' && body.telegramUserId === expected.identity.id
    && body.playerId === `tg_${expected.identity.id}`;
}
async function restoreOrBootstrap(expected: AuthContext): Promise<string> {
  if (expected.identity?.kind !== 'telegram') throw new Error('Telegram authorization expired. Reopen the Mini App.');
  const request = authRequest(expected);
  try {
    const cached = readCachedSession();
    if (cached?.telegramUserId === expected.identity.id) {
      // On restoration verify the opaque bearer owner once with the server.
      // Storage metadata is not proof of token ownership.
      const response = await fetch(`${API_BASE}/api/auth/session`, {
        headers: { 'X-Session-Token': cached.token }, signal: request.signal,
      });
      assertAuthContext(expected);
      if (response.ok) {
        const owner = await response.json();
        assertAuthContext(expected);
        if (confirmedOwner(owner, expected)) {
          session = cached;
          acceptGameEpoch(owner.gameEpoch);
          for (const listener of snapshotListeners) listener();
          return cached.token;
        }
      } else if (response.status !== 401) throw new Error('Could not restore authentication');
      clearSessionToken(cached.token);
    }
    assertAuthContext(expected);
    const initData = window.Telegram?.WebApp?.initData;
    if (!initData) throw new Error('Telegram authorization expired. Reopen the Mini App.');
    const response = await fetch(`${API_BASE}/api/auth/bootstrap`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData }), signal: request.signal,
    });
    assertAuthContext(expected);
    if (!response.ok) throw new Error('Telegram authorization expired. Reopen the Mini App.');
    const result = await response.json();
    assertAuthContext(expected);
    if (!confirmedOwner(result, expected) || typeof result.sessionToken !== 'string') throw new Error('Invalid authentication response');
    session = { telegramUserId: result.telegramUserId, token: result.sessionToken };
    acceptGameEpoch(result.gameEpoch);
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch { /* memory only */ }
    for (const listener of snapshotListeners) listener();
    return session.token;
  } finally { request.release(); }
}
function getOrBootstrapSession(expected: AuthContext): Promise<string> {
  assertAuthContext(expected);
  if (session && session.telegramUserId === expected.identity?.id) return Promise.resolve(session.token);
  if (inFlight?.context === expected) return inFlight.promise;
  const promise = restoreOrBootstrap(expected).finally(() => {
    if (inFlight?.promise === promise) inFlight = null;
  });
  inFlight = { context: expected, promise };
  return promise;
}
export async function getIdentityHeaders(expected = captureAuthContext()): Promise<Record<string, string>> {
  assertAuthContext(expected);
  if (expected.identity?.kind === 'dev') {
    const response = await fetch(`${API_BASE}/api/auth/epoch`);
    if (!response.ok) throw new Error('Could not load game epoch');
    const body = await response.json();
    assertAuthContext(expected);
    acceptGameEpoch(body.gameEpoch);
    assertAuthContext(expected);
    return { 'X-Dev-Player-Id': expected.identity.id, 'X-Game-Epoch': gameEpoch! };
  }
  const token = await getOrBootstrapSession(expected);
  assertAuthContext(expected);
  return { 'X-Session-Token': token, 'X-Game-Epoch': gameEpoch ?? '0' };
}
export async function refreshIdentityHeaders(expiredToken: string, expected = captureAuthContext()): Promise<Record<string, string>> {
  assertAuthContext(expected);
  clearSessionToken(expiredToken);
  return getIdentityHeaders(expected);
}
export async function getIdentityForWs(expected = captureAuthContext()): Promise<{ sessionToken: string } | { devPlayerId: string }> {
  const headers = await getIdentityHeaders(expected);
  return headers['X-Session-Token'] ? { sessionToken: headers['X-Session-Token'] } : { devPlayerId: headers['X-Dev-Player-Id'] };
}
