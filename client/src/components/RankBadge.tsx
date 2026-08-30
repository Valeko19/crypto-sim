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
  // The `background: transparent` below is defensive (harmless for any
  // correctly-authored file) but does NOT fix the dark square visible around
  // shrimp_idle specifically — verified directly (sampled the canvas's own
  // pixel data: fully opaque RGBA(40,40,40,255) even with this style already
  // applied to both the canvas and its wrapper). That square is the
  // artboard's own background fill baked into the .riv file itself, not
  // something CSS or this component can remove — it needs the source file
  // re-exported from the Rive editor with the artboard's background set to
  // transparent (or its background fill shape deleted).
  return (
    <div style={{ width: size, height: size, background: 'transparent' }}>
      <RiveComponent style={{ background: 'transparent' }} />
    </div>
  );
}
