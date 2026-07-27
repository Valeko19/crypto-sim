import { coinColor } from '../lib/coinVisuals';

export function CoinAvatar({ coinId, symbol, size = 40 }: { coinId: string; symbol: string; size?: number }) {
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-full font-bold text-white"
      style={{
        width: size, height: size, background: coinColor(coinId),
        fontSize: size * 0.32, boxShadow: `0 0 12px ${coinColor(coinId)}55`,
      }}
    >
      {symbol.slice(0, 3)}
    </div>
  );
}
