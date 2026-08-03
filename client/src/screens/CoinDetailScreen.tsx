import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { createChart, ColorType, CandlestickSeriesPartialOptions, IChartApi, ISeriesApi } from 'lightweight-charts';
import { api, CoinListItem } from '../lib/api';
import { useMarketSocket } from '../hooks/useMarketSocket';
import { CoinAvatar } from '../components/CoinAvatar';
import { formatCompact, formatPrice, formatPct, formatUsdd, formatQty, parseAmountInput, formatAmountInput, pctColorClass, pricePrecision } from '../lib/format';

// borderVisible must stay on: quiet coins can have a near-zero-height body for
// several candles in a row, and a fill with no stroke rounds down to nothing
// visible at that pixel height — it reads as a gap even though the data point
// is there. A 1px border always draws, so the candle stays visible.
const CANDLE_SERIES_OPTIONS: CandlestickSeriesPartialOptions = {
  upColor: '#22C55E', downColor: '#F04452', borderVisible: true,
  borderUpColor: '#22C55E', borderDownColor: '#F04452',
  wickUpColor: '#22C55E', wickDownColor: '#F04452',
};

export function CoinDetailScreen() {
  const { coinId = '' } = useParams();
  const navigate = useNavigate();
  const live = useMarketSocket();

  const [coin, setCoin] = useState<CoinListItem | null>(null);
  const [holding, setHolding] = useState<{ amount: number; pctEmission: number; pnlPct: number } | null>(null);
  const [balance, setBalance] = useState(0);

  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  // Buy is always priced in USDD, sell always in the coin itself — no toggle,
  // so the unit switches automatically with the side instead of needing a
  // separate control that could get out of sync with it.
  const mode = side === 'buy' ? 'usdd' : 'coin';
  const [amount, setAmount] = useState('');
  const [quote, setQuote] = useState<{ avgPrice: number; priceImpactPct: number; feeAmount: number; feePct: number; out: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const chartRef = useRef<HTMLDivElement | null>(null);
  const chartApiRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const lastPrecisionRef = useRef<number | null>(null);

  useEffect(() => {
    api.getCoins().then(res => setCoin(res.coins.find(c => c.id === coinId) ?? null));
    refreshPortfolio();
  }, [coinId]);

  function refreshPortfolio() {
    api.getPortfolio().then(p => {
      setBalance(p.usddBalance);
      const h = p.holdings.find(x => x.coinId === coinId);
      setHolding(h ? { amount: h.amount, pctEmission: h.pctEmission, pnlPct: h.pnlPct } : null);
    });
  }

  // Chart setup (once)
  useEffect(() => {
    if (!chartRef.current) return;
    const chart = createChart(chartRef.current, {
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#8890AA' },
      grid: { vertLines: { color: '#1B2036' }, horzLines: { color: '#1B2036' } },
      width: chartRef.current.clientWidth,
      height: 260,
      timeScale: { timeVisible: true, secondsVisible: true },
      rightPriceScale: { borderColor: '#252B44' },
      crosshair: { mode: 0 },
    });
    const series = chart.addCandlestickSeries(CANDLE_SERIES_OPTIONS);
    chartApiRef.current = chart;
    seriesRef.current = series;

    const onResize = () => chart.applyOptions({ width: chartRef.current!.clientWidth });
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      chart.remove();
    };
  }, []);

  function applyPrecisionIfNeeded(lastClose: number) {
    const precision = pricePrecision(lastClose);
    if (precision !== lastPrecisionRef.current) {
      lastPrecisionRef.current = precision;
      seriesRef.current?.applyOptions({
        priceFormat: { type: 'price', precision, minMove: Math.pow(10, -precision) },
      });
    }
  }

  // Load candle history once per coin (chart bootstrap only — live updates
  // afterwards arrive over the WebSocket, see the effect below).
  useEffect(() => {
    let cancelled = false;
    lastPrecisionRef.current = null; // force a fresh priceFormat for the new coin
    api.getCandles(coinId).then(({ candles }) => {
      if (cancelled || !seriesRef.current || candles.length === 0) return;
      applyPrecisionIfNeeded(candles[candles.length - 1].c);
      seriesRef.current.setData(
        candles.map(c => ({ time: (c.t / 1000) as any, open: c.o, high: c.h, low: c.l, close: c.c }))
      );
      chartApiRef.current?.timeScale().scrollToRealTime();
    });
    return () => { cancelled = true; };
  }, [coinId]);

  // Live candle updates pushed over the WebSocket (one per tick) — pushes the
  // in-progress bar straight into the chart instead of re-polling over REST.
  useEffect(() => {
    const c = live.candles[coinId];
    if (!c || !seriesRef.current) return;
    applyPrecisionIfNeeded(c.c);
    seriesRef.current.update({ time: (c.t / 1000) as any, open: c.o, high: c.h, low: c.l, close: c.c });
  }, [live.candles[coinId], coinId]);

  const livePrice = live.prices[coinId]?.price ?? coin?.price ?? 0;
  const liveChange = live.prices[coinId]?.changePct ?? coin?.changePct ?? 0;

  // Trading price stays live (every ~1s via WS) since that's what buy/sell
  // math needs, but market cap only needs to feel current — refresh it every
  // 10s instead of jumping every tick.
  const livePriceRef = useRef(livePrice);
  livePriceRef.current = livePrice;
  const [capPrice, setCapPrice] = useState(livePrice);
  useEffect(() => {
    const interval = setInterval(() => setCapPrice(livePriceRef.current), 10_000);
    return () => clearInterval(interval);
  }, []);
  // The screen stays mounted across coinId changes (route param swap, not a
  // remount) — resync immediately on navigation instead of showing the
  // previous coin's cap for up to 10s.
  useEffect(() => {
    setCapPrice(livePriceRef.current);
  }, [coinId]);
  // On first load, both the REST coin fetch and the first WS tick can arrive
  // after this component's initial render, so livePrice (and capPrice, seeded
  // from it) can start at 0 — catch up as soon as a real price shows up
  // instead of waiting for the next 10s tick.
  useEffect(() => {
    if (capPrice === 0 && livePrice > 0) setCapPrice(livePrice);
  }, [livePrice, capPrice]);

  // 100% on the slider = full balance when buying, full holding when selling —
  // expressed in whichever unit (USDD / coin quantity) the input is currently in.
  const available = side === 'buy'
    ? (mode === 'usdd' ? balance : (livePrice > 0 ? balance / livePrice : 0))
    : (mode === 'usdd' ? (holding?.amount ?? 0) * livePrice : (holding?.amount ?? 0));
  const sliderPct = available > 0 ? Math.max(0, Math.min(100, ((Number(amount) || 0) / available) * 100)) : 0;

  function applyPct(pct: number) {
    const raw = available * (pct / 100);
    setAmount(raw > 0 ? String(Number(raw.toFixed(8))) : '');
  }

  // The input shows a thousands-grouped display (formatAmountInput) while
  // `amount` itself stays a plain parseable numeric string — reformatting on
  // every keystroke shifts the caret, so it's repositioned by counting digits
  // typed before it rather than left to drift to the end of the field.
  function handleAmountChange(e: React.ChangeEvent<HTMLInputElement>) {
    const input = e.target;
    const rawValue = input.value;
    const cursorPos = input.selectionStart ?? rawValue.length;
    const digitsBeforeCursor = rawValue.slice(0, cursorPos).replace(/\D/g, '').length;

    const cleaned = parseAmountInput(rawValue);
    setAmount(cleaned);

    requestAnimationFrame(() => {
      const formatted = formatAmountInput(cleaned);
      let count = 0;
      let pos = formatted.length;
      for (let i = 0; i < formatted.length; i++) {
        if (/\d/.test(formatted[i])) count++;
        if (count === digitsBeforeCursor) { pos = i + 1; break; }
      }
      input.setSelectionRange(pos, pos);
    });
  }

  async function fetchQuote(num: number) {
    try {
      const body = mode === 'usdd' ? { coinId, side, amountUsdd: num } : { coinId, side, amountCoin: num };
      const res = await api.quoteTrade(body);
      const out = side === 'buy' ? res.expectedCoinOut! : res.expectedUsddOut!;
      setQuote({ avgPrice: res.avgPrice, priceImpactPct: res.priceImpactPct, feeAmount: res.feeAmount, feePct: res.feePct, out });
    } catch {
      setQuote(null);
    }
  }

  // Debounced quote preview.
  useEffect(() => {
    const num = Number(amount);
    if (!num || num <= 0) { setQuote(null); return; }
    const timer = setTimeout(() => fetchQuote(num), 300);
    return () => clearTimeout(timer);
  }, [amount, side, mode, coinId]);

  async function submit() {
    const num = Number(amount);
    if (!num || num <= 0) return;
    setBusy(true);
    setMessage(null);
    try {
      const body = mode === 'usdd' ? { coinId, side, amountUsdd: num } : { coinId, side, amountCoin: num };
      const res = await api.trade(body);
      setMessage(
        side === 'buy'
          ? `Куплено ${res.coinAmount.toFixed(6)} ${coin?.symbol} по ~$${formatPrice(res.avgPrice)}`
          : `Продано за ${formatUsdd(res.usddAmount)}`
      );
      // Keep the amount so repeat trades of the same size don't require retyping —
      // just refresh the quote against the post-trade pool/balance state.
      refreshPortfolio();
      fetchQuote(num);
    } catch (e: any) {
      setMessage(e.message ?? 'Ошибка сделки');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="px-4 pt-4">
      <button onClick={() => navigate(-1)} className="mb-3 text-sm text-muted hover:text-white">← Назад</button>

      {coin && (
        <div className="flex items-center gap-3">
          <CoinAvatar coinId={coin.id} symbol={coin.symbol} iconUrl={coin.iconUrl} size={44} />
          <div>
            <div className="flex items-baseline gap-2">
              <span className="text-lg font-bold">{coin.symbol}</span>
              <span className="text-sm text-muted">{coin.name}</span>
            </div>
            <div className="text-xs text-muted">MCap ${formatCompact(capPrice * coin.supply)} · Supply {formatCompact(coin.supply)}</div>
          </div>
        </div>
      )}

      <div className="mt-3 flex items-baseline gap-3">
        <span className="text-3xl font-bold">${formatPrice(livePrice)}</span>
        <span className={`text-sm font-medium ${pctColorClass(liveChange)}`}>{formatPct(liveChange)}</span>
      </div>

      <div className="mt-4 overflow-hidden rounded-2xl border border-border bg-card">
        <div ref={chartRef} className="w-full" />
      </div>

      {holding && coin && (
        <div className="mt-3 rounded-2xl border border-border bg-card p-3 text-sm">
          <span className="text-muted">Позиция: </span>
          {formatQty(holding.amount, livePrice)} {coin.symbol} · {holding.pctEmission.toFixed(3)}% эмиссии
        </div>
      )}

      <div className="mt-4 rounded-2xl border border-border bg-card p-4">
        <div className="mb-3 flex gap-2">
          <button
            onClick={() => { setSide('buy'); setAmount(''); }}
            className={`flex-1 rounded-xl py-2 text-sm font-semibold transition-colors ${side === 'buy' ? 'bg-positive/20 text-positive' : 'text-muted'}`}
          >
            Купить
          </button>
          <button
            onClick={() => { setSide('sell'); setAmount(''); }}
            className={`flex-1 rounded-xl py-2 text-sm font-semibold transition-colors ${side === 'sell' ? 'bg-negative/20 text-negative' : 'text-muted'}`}
          >
            Продать
          </button>
        </div>

        <div className="mb-2 text-xs text-muted">
          {mode === 'usdd' ? 'Сумма в USDD' : `Количество ${coin?.symbol ?? ''}`}
        </div>
        <input
          type="text"
          inputMode="decimal"
          value={formatAmountInput(amount)}
          onChange={handleAmountChange}
          placeholder="0.00"
          className="w-full rounded-xl border border-border bg-bg px-3 py-2.5 text-lg outline-none focus:border-accent-to"
        />

        <div className="mt-2 flex items-center justify-between text-xs text-muted">
          <span>Доступно</span>
          <span>
            {mode === 'usdd' ? formatUsdd(available) : `${available.toFixed(6)} ${coin?.symbol ?? ''}`}
          </span>
        </div>

        <div className="mt-3">
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={sliderPct}
            onChange={e => applyPct(Number(e.target.value))}
            disabled={available <= 0}
            className="w-full accent-accent-to disabled:opacity-30"
          />
          <div className="mt-1 flex justify-between text-[10px] text-muted">
            <span>0%</span>
            <span>25%</span>
            <span>50%</span>
            <span>75%</span>
            <span>100%</span>
          </div>
        </div>

        <div className="mt-2 grid grid-cols-4 gap-2">
          {[25, 50, 75, 100].map(pct => (
            <button
              key={pct}
              type="button"
              disabled={available <= 0}
              onClick={() => applyPct(pct)}
              className="rounded-lg border border-border py-1.5 text-xs text-muted transition-colors hover:border-accent-to hover:text-white disabled:opacity-30"
            >
              {pct}%
            </button>
          ))}
        </div>

        {quote && (
          <div className="mt-3 rounded-xl bg-card-light p-3 text-xs text-muted">
            <div>Ожидаемая цена: ~${formatPrice(quote.avgPrice)}</div>
            <div className={Math.abs(quote.priceImpactPct) > 3 ? 'text-negative' : ''}>
              Проскальзывание: {formatPct(quote.priceImpactPct, 2)}
            </div>
            <div>Комиссия ({(quote.feePct * 100).toFixed(2).replace(/\.?0+$/, '')}%): {formatUsdd(quote.feeAmount)}</div>
            <div>Вы получите: {side === 'buy' ? `${quote.out.toFixed(6)} ${coin?.symbol ?? ''}` : formatUsdd(quote.out)}</div>
          </div>
        )}

        <button
          onClick={submit}
          disabled={busy || !amount}
          className="mt-4 w-full rounded-xl bg-accent-gradient py-3 font-semibold shadow-glow disabled:opacity-40"
        >
          {side === 'buy' ? 'Купить' : 'Продать'}
        </button>

        {message && <div className="mt-2 text-center text-xs text-muted">{message}</div>}
      </div>
    </div>
  );
}
