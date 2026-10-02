import { MarketStatus, PortfolioView, Candle, API_BASE } from './api';
import { clearSessionToken, getIdentityForWs } from './telegram';

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

function emit() {
  for (const l of listeners) l();
}

async function connect() {
  let identity: Awaited<ReturnType<typeof getIdentityForWs>>;
  try {
    identity = await getIdentityForWs();
  } catch (error) {
    if (error instanceof Error && error.message.includes('authorization expired')) return;
    setTimeout(() => { void connect(); }, 5000);
    return;
  }

  // Same-origin by default (dev proxy handles /ws — see vite.config.ts); a
  // split-domain deploy sets VITE_API_BASE to the server's http(s) URL, which
  // is swapped to the matching ws(s) scheme here.
  const wsUrl = API_BASE
    ? `${API_BASE.replace(/^http/, 'ws')}/ws`
    : `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;
  const ws = new WebSocket(wsUrl);
  let activityTimer: ReturnType<typeof setInterval> | null = null;

  // Identity is sent as the first message after open, not a query param on
  // wsUrl — the browser WebSocket API can't set custom headers, and a query
  // string would land in default access logs (unlike the REST header path).
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'auth', ...identity }));
    if ('sessionToken' in identity) {
      activityTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'activity' }));
      }, SESSION_ACTIVITY_INTERVAL_MS);
    }
  };

  ws.onmessage = ev => {
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
    if (activityTimer) clearInterval(activityTimer);
    setTimeout(() => { void connect(); }, 1500);
  };
}

let started = false;
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
  return state;
}
