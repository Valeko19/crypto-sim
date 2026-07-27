export function FearGreedBar({ index, label }: { index: number; label: string }) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm text-muted">Индекс страха и жадности</span>
        <span className="text-sm font-semibold">
          {index} <span className="text-muted font-normal">· {label}</span>
        </span>
      </div>
      <div className="relative h-2 rounded-full bg-fear-greed-gradient">
        <div
          className="absolute top-1/2 h-4 w-4 -translate-y-1/2 -translate-x-1/2 rounded-full border-2 border-bg bg-white shadow"
          style={{ left: `${Math.max(0, Math.min(100, index))}%` }}
        />
      </div>
    </div>
  );
}
