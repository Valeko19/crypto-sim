export function formatCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e12) return (n / 1e12).toFixed(2) + 'T';
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return (n / 1e3).toFixed(2) + 'K';
  return n.toFixed(0);
}

export function formatPrice(n: number): string {
  const abs = Math.abs(n);
  if (abs === 0) return '0';
  if (abs >= 1000) return n.toLocaleString('ru-RU', { maximumFractionDigits: 0 });
  if (abs >= 1) return n.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // small prices: show enough significant digits to be meaningful (memecoins can be 1e-8)
  let decimals = 4;
  if (abs < 0.0001) decimals = 8;
  else if (abs < 0.01) decimals = 6;
  return n.toLocaleString('ru-RU', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function formatUsdd(n: number): string {
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatPct(n: number, digits = 1): string {
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(digits)}%`;
}

export function pctColorClass(n: number): string {
  return n >= 0 ? 'text-positive' : 'text-negative';
}

export function formatDurationShort(totalSec: number): string {
  const sec = Math.max(0, Math.round(totalSec));
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  if (min === 0) return `${rem}с`;
  return `${min}м ${rem}с`;
}

// Decimal places needed so a chart price axis shows the full value instead of
// rounding tiny memecoin prices (e.g. $0.00000005) down to $0.00.
export function pricePrecision(price: number): number {
  const abs = Math.abs(price);
  if (!abs) return 2;
  if (abs >= 1) return 2;
  const leadingZeros = -Math.floor(Math.log10(abs)) - 1;
  return Math.min(leadingZeros + 4, 10);
}
