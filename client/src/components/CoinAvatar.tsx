import { useState } from 'react';
import { coinColor } from '../lib/coinVisuals';

export function CoinAvatar({
  coinId, symbol, iconUrl, size = 40,
}: { coinId: string; symbol: string; iconUrl?: string; size?: number }) {
  const [failed, setFailed] = useState(false);

  if (iconUrl && !failed) {
    return (
      <img
        src={iconUrl}
        alt={symbol}
        width={size}
        height={size}
        onError={() => setFailed(true)}
        className="shrink-0 rounded-full object-cover"
        style={{ width: size, height: size, boxShadow: `0 0 12px ${coinColor(coinId)}55` }}
      />
    );
  }

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
