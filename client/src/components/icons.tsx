import { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

export function TradeIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" strokeWidth={1.8} stroke="currentColor" {...props}>
      <path d="M4 7h11m0 0-3.5-3.5M15 7l-3.5 3.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M20 17H9m0 0 3.5-3.5M9 17l3.5 3.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function QuestsIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" strokeWidth={1.8} stroke="currentColor" {...props}>
      <path d="M6 3.5h9.5L19 7v13.5H6z" strokeLinejoin="round" />
      <path d="M9 11.5h6M9 15h6" strokeLinecap="round" />
    </svg>
  );
}

export function ShopIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" strokeWidth={1.8} stroke="currentColor" {...props}>
      <path d="M4 8l1.5-4h13L20 8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 8h16v11.5H4z" strokeLinejoin="round" />
      <path d="M9 11.5a3 3 0 0 0 6 0" strokeLinecap="round" />
    </svg>
  );
}

export function LeaderboardIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" strokeWidth={1.8} stroke="currentColor" {...props}>
      <path d="M8 21h8M12 17v4" strokeLinecap="round" />
      <path d="M7 4h10v5a5 5 0 0 1-10 0V4Z" strokeLinejoin="round" />
      <path d="M7 6H4v1a4 4 0 0 0 4 4M17 6h3v1a4 4 0 0 1-4 4" strokeLinecap="round" />
    </svg>
  );
}

export function FarmingIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" strokeWidth={1.8} stroke="currentColor" {...props}>
      <path d="M12 20V10" strokeLinecap="round" />
      <path d="M12 13c0-3 2-5.5 5.5-6-0.3 3.5-2.5 5.5-5.5 6Z" strokeLinejoin="round" />
      <path d="M12 16c0-2.5-1.7-4.5-4.5-5 .2 2.8 2 4.5 4.5 5Z" strokeLinejoin="round" />
      <path d="M7 20h10" strokeLinecap="round" />
    </svg>
  );
}

export function ProfileIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" strokeWidth={1.8} stroke="currentColor" {...props}>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M4.5 20c1.4-3.6 4.3-5.5 7.5-5.5s6.1 1.9 7.5 5.5" strokeLinecap="round" />
    </svg>
  );
}

export function GiftIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" strokeWidth={1.8} stroke="currentColor" {...props}>
      <rect x="4" y="9" width="16" height="11" rx="1" />
      <path d="M4 9h16v3H4z" />
      <path d="M12 9v11M12 9c-1.8 0-3.2-1.2-3.2-2.7S9.6 3.5 11 3.8c1.1.2 1 1.8 1 5.2Zm0 0c1.8 0 3.2-1.2 3.2-2.7S14.4 3.5 13 3.8c-1.1.2-1 1.8-1 5.2Z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function TrendingUpIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" strokeWidth={1.8} stroke="currentColor" {...props}>
      <path d="M3 17l6-6l4 4l8-8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M14 7h7v7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function TrendingDownIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" strokeWidth={1.8} stroke="currentColor" {...props}>
      <path d="M3 7l6 6l4-4l8 8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M14 17h7v-7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ShareIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" strokeWidth={1.8} stroke="currentColor" {...props}>
      <circle cx="6" cy="12" r="2.2" />
      <circle cx="18" cy="5.5" r="2.2" />
      <circle cx="18" cy="18.5" r="2.2" />
      <path d="M8 11l8-4.3M8 13l8 4.3" strokeLinecap="round" />
    </svg>
  );
}
