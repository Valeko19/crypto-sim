import { MarketStatus, PortfolioView, Candle, API_BASE } from './api';
import { clearSessionToken, getIdentityForWs, captureAuthContext, isAuthContextCurrent, subscribeAuth, type AuthContext } from './telegram';

export interface LivePriceInfo { price: number; changePct: number; }

interface WsState {
  prices: Record<string, LivePriceInfo>;
  marketStatus: MarketStatus | null;
  portfolio: PortfolioView | null;
  candles: Record<string, Candle>;
}

// `state` is reassigned (not mutated in place) on every update: useSyncExternalStore
// detects changes via Object.is on whatever getSnapshot() returns, so returning the
// same top-level object reference forever would silently stop all re-renders.
let state: WsState = { prices: {}, marketStatus: null, portfolio: null, candles: {} };
const listeners = new Set<() => void>();
const SESSION_ACTIVITY_INTERVAL_MS = 5 * 60 * 1000;
let activeSocket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let activityTimer: ReturnType<typeof setInterval> | null = null;
let started = false;

function stopConnection() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (activityTimer) clearInterval(activityTimer);
  reconnectTimer = activityTimer = null;
  const old = activeSocket;
  activeSocket = null;
  old?.close();
}
function reconnect(context: AuthContext, delay: number) {
  if (!isAuthContextCurrent(context) || !context.identity) return;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (isAuthContextCurrent(context)) void connect();
  }, delay);
}
subscribeAuth(() => {
  stopConnection();
  state = { ...state, portfolio: null };
  emit();
  if (started) void connect();
});

function emit() {
  for (const l of listeners) l();
}

async function connect() {
  const context = captureAuthContext();
  if (!context.identity) return;
  let identity: Awaited<ReturnType<typeof getIdentityForWs>>;
  try {
    identity = await getIdentityForWs(context);
  } catch (error) {
    if (error instanceof Error && error.message.includes('authorization expired')) return;
    reconnect(context, 5000);
    return;
  }
  if (!isAuthContextCurrent(context) || activeSocket) return;

  // Same-origin by default (dev proxy handles /ws — see vite.config.ts); a
  // split-domain deploy sets VITE_API_BASE to the server's http(s) URL, which
  // is swapped to the matching ws(s) scheme here.
  const wsUrl = API_BASE
    ? `${API_BASE.replace(/^http/, 'ws')}/ws`
    : `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;
  const ws = new WebSocket(wsUrl);
  activeSocket = ws;
  const current = () => isAuthContextCurrent(context) && activeSocket === ws;

  // Identity is sent as the first message after open, not a query param on
  // wsUrl — the browser WebSocket API can't set custom headers, and a query
  // string would land in default access logs (unlike the REST header path).
  ws.onopen = () => {
    if (!current()) { ws.close(); return; }
    ws.send(JSON.stringify({ type: 'auth', ...identity }));
    if ('sessionToken' in identity) {
      activityTimer = setInterval(() => {
        if (current() && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'activity' }));
      }, SESSION_ACTIVITY_INTERVAL_MS);
    }
  };

  ws.onmessage = ev => {
    if (!current()) return;
    try {
      const { type, payload } = JSON.parse(ev.data);
      if (type === 'auth_error') {
        if (activityTimer) clearInterval(activityTimer);
        if ('sessionToken' in identity) clearSessionToken(identity.sessionToken);
        ws.close();
      } else if (type === 'price_updates') {
        const nextPrices: Record<string, LivePriceInfo> = { ...state.prices };
        for (const c of payload.coins) nextPrices[c.id] = { price: c.price, changePct: c.changePct };
        state = { ...state, prices: nextPrices, marketStatus: payload.marketStatus };
        emit();
      } else if (type === 'portfolio_updates') {
        state = { ...state, portfolio: payload };
        emit();
      } else if (type === 'candle_updates') {
        const nextCandles: Record<string, Candle> = { ...state.candles };
        for (const c of payload.candles) nextCandles[c.id] = c.candle;
        state = { ...state, candles: nextCandles };
        emit();
      }
    } catch {
      // ignore malformed frames
    }
  };

  ws.onclose = () => {
    if (!current()) return;
    if (activityTimer) clearInterval(activityTimer);
    activityTimer = null;
    activeSocket = null;
    reconnect(context, 1500);
  };
}

export function ensureWsStarted() {
  if (started) return;
  started = true;
  connect();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSnapshot(): WsState {
  // This synchronously clears personal state and invalidates the old socket on
  // an identity change; polling is only a proactive notification mechanism.
  captureAuthContext();
  return state;
}
