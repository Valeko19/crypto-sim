import { MarketStatus, PortfolioView, Candle } from './api';

export interface LivePriceInfo { price: number; change24hPct: number; }

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

function emit() {
  for (const l of listeners) l();
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws`);

  ws.onmessage = ev => {
    try {
      const { type, payload } = JSON.parse(ev.data);
      if (type === 'price_updates') {
        const nextPrices: Record<string, LivePriceInfo> = { ...state.prices };
        for (const c of payload.coins) nextPrices[c.id] = { price: c.price, change24hPct: c.change24hPct };
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
    setTimeout(connect, 1500);
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
