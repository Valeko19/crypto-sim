import { useEffect, useRef, useState } from 'react';
import { ActiveNews } from '../lib/api';
import { TrendingUpIcon, TrendingDownIcon } from './icons';

// Timeline for the "neon sign switching on" flicker once the card has
// finished sliding in: alternating on/off holds with shrinking gaps, ending
// permanently on. Only the glow toggles — the card body (bg/border/text)
// stays fully visible throughout.
const FLICKER_TIMELINE: { on: boolean; holdMs: number }[] = [
  { on: true, holdMs: 80 },
  { on: false, holdMs: 150 },
  { on: true, holdMs: 80 },
  { on: false, holdMs: 100 },
  { on: true, holdMs: 80 },
  { on: false, holdMs: 60 },
  { on: true, holdMs: 0 }, // settles on, holdMs unused
];

const ENTER_DURATION_MS = 480;
const EXIT_DURATION_MS = 300;

type Phase = 'entering' | 'flickering' | 'stable' | 'exiting';

interface Displayed {
  headline: string;
  direction: 'positive' | 'negative';
  expiresAt: number;
}

export function NewsBanner({ news }: { news: ActiveNews | null }) {
  const [displayed, setDisplayed] = useState<Displayed | null>(null);
  const [phase, setPhase] = useState<Phase>('entering');
  const [entered, setEntered] = useState(false); // drives the slide/fade transform
  const [glowOn, setGlowOn] = useState(false);
  const [barScale, setBarScale] = useState(1);
  const [barDurationMs, setBarDurationMs] = useState(0);

  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const rafs = useRef<number[]>([]);
  const pendingRef = useRef<ActiveNews | null>(null);

  function clearAllTimers() {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    rafs.current.forEach(cancelAnimationFrame);
    rafs.current = [];
  }
  function after(ms: number, fn: () => void) {
    timers.current.push(setTimeout(fn, ms));
  }
  function nextFrame(fn: () => void) {
    rafs.current.push(requestAnimationFrame(() => rafs.current.push(requestAnimationFrame(fn))));
  }

  function startEnter(n: ActiveNews) {
    setDisplayed({ headline: n.headline, direction: n.direction, expiresAt: n.expiresAt });
    setPhase('entering');
    setEntered(false);
    setGlowOn(false);
    setBarScale(1);
    setBarDurationMs(0);
    nextFrame(() => setEntered(true));
    after(ENTER_DURATION_MS, runFlicker);
  }

  function runFlicker() {
    setPhase('flickering');
    let t = 0;
    FLICKER_TIMELINE.forEach(step => {
      after(t, () => setGlowOn(step.on));
      t += step.holdMs;
    });
    after(t, () => setPhase('stable'));
  }

  function startExit(onDone: () => void) {
    clearAllTimers();
    setPhase('exiting');
    setEntered(false);
    after(EXIT_DURATION_MS, onDone);
  }

  // Countdown bar only starts draining once the flicker settles — duration is
  // whatever's actually left until expiresAt, so it always hits zero exactly
  // when the banner is due to disappear regardless of how long entering+
  // flickering took.
  useEffect(() => {
    if (phase !== 'stable' || !displayed) return;
    const remaining = Math.max(0, displayed.expiresAt - Date.now());
    setBarDurationMs(remaining);
    setBarScale(1);
    nextFrame(() => setBarScale(0));
  }, [phase, displayed?.expiresAt]);

  useEffect(() => {
    if (!news) {
      if (displayed) startExit(() => setDisplayed(null));
      return;
    }
    if (!displayed) {
      startEnter(news);
      return;
    }
    if (displayed.headline !== news.headline || displayed.direction !== news.direction) {
      pendingRef.current = news;
      startExit(() => {
        const next = pendingRef.current;
        pendingRef.current = null;
        if (next) startEnter(next);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [news?.headline, news?.direction, news === null]);

  useEffect(() => clearAllTimers, []);

  if (!displayed) return null;

  const positive = displayed.direction === 'positive';
  const glowClass = positive ? 'shadow-glow-green' : 'shadow-glow-red';
  const barColor = positive ? '#22C55E' : '#F04452';

  return (
    <div
      className={`mt-3 transition-all ease-[cubic-bezier(0.34,1.56,0.64,1)] ${
        phase === 'exiting' ? 'duration-300 ease-in' : 'duration-500'
      } ${entered ? 'translate-y-0 opacity-100' : '-translate-y-4 opacity-0'}`}
    >
      <div
        className={`relative overflow-hidden rounded-2xl border p-3 transition-shadow duration-150 ${
          positive ? 'border-positive/30 bg-positive/5' : 'border-negative/30 bg-negative/5'
        } ${glowOn ? glowClass : 'shadow-none'}`}
      >
        <div className="flex items-start gap-3">
          <div
            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
              positive ? 'bg-positive/20 text-positive' : 'bg-negative/20 text-negative'
            }`}
          >
            {positive ? <TrendingUpIcon className="h-4 w-4" /> : <TrendingDownIcon className="h-4 w-4" />}
          </div>
          <p className={`line-clamp-3 flex-1 text-sm font-medium ${positive ? 'text-positive' : 'text-negative'}`}>
            {displayed.headline}
          </p>
        </div>

        {/* Clipped by the card's own overflow-hidden+rounded-2xl above, so the
            bar (and its glow) always follows the card's real rounded corners
            instead of approximating them with its own separate radius. */}
        <div
          className="absolute inset-x-0 bottom-0 origin-left"
          style={{
            height: '0.75px',
            background: barColor,
            boxShadow: `0 0 2px ${barColor}, 0 0 6px ${barColor}`,
            transform: `scaleX(${barScale})`,
            transitionProperty: 'transform',
            transitionTimingFunction: 'linear',
            transitionDuration: `${barDurationMs}ms`,
          }}
        />
      </div>
    </div>
  );
}
