import { useRive, Layout, Fit, Alignment } from '@rive-app/react-canvas';
import { rankEmoji, rankAnimationSrc } from '../lib/rankVisuals';

interface RankBadgeProps {
  rank: string;
  size?: number;
}

// Plays the rank's looping Rive idle animation when one exists yet
// (see RANK_ANIMATIONS) — falls back to the same static emoji used
// elsewhere for any rank without a file yet, so the other eight ranks
// keep working exactly as before until their own animations land.
export function RankBadge({ rank, size = 120 }: RankBadgeProps) {
  const src = rankAnimationSrc(rank);
  const { RiveComponent } = useRive(
    src
      ? {
          src,
          autoplay: true,
          layout: new Layout({ fit: Fit.Contain, alignment: Alignment.Center }),
        }
      : null
  );

  if (!src) {
    return (
      <div className="flex items-center justify-center" style={{ width: size, height: size, fontSize: size * 0.5 }}>
        {rankEmoji(rank)}
      </div>
    );
  }

  // RiveComponent auto-sizes its canvas to its immediate parent (a
  // ResizeObserver under the hood) rather than to a style/width prop passed
  // directly to it — the sized wrapper here is what actually controls it.
  return (
    <div style={{ width: size, height: size }}>
      <RiveComponent />
    </div>
  );
}
