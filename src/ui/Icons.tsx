import type { ReactNode, SVGProps } from 'react';
import { AVATARS, type Avatar } from '../bots/lineup';

const baseProps: SVGProps<SVGSVGElement> = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
};

/** Brand geometric spade emblem for the header mark. */
export function BrandSpadeIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width={20} height={20} viewBox="0 0 24 24" {...baseProps} {...props}>
      <path d="M12 3.2C7.4 8.6 4 11.7 4 15.2a4.6 4.6 0 0 0 7.1 3.8L9.6 21h4.8l-1.5-2A4.6 4.6 0 0 0 20 15.2C20 11.7 16.6 8.6 12 3.2Z" />
      <circle cx="12" cy="13.5" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function SoundOnIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" {...baseProps} {...props}>
      <path d="M11 5.5 6.8 9H3.5v6h3.3L11 18.5V5.5Z" />
      <path d="M15.2 8.8a4.6 4.6 0 0 1 0 6.4" />
      <path d="M18.1 6a8.5 8.5 0 0 1 0 12" />
    </svg>
  );
}

export function SoundOffIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" {...baseProps} {...props}>
      <path d="M11 5.5 6.8 9H3.5v6h3.3L11 18.5V5.5Z" />
      <path d="m15.5 9.5 5 5" />
      <path d="m20.5 9.5-5 5" />
    </svg>
  );
}

/** Minimalist capsule microphone icon; no <title> so button textContent remains exact for voice tests. */
export function MicIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" {...baseProps} {...props}>
      <rect x="9" y="3.5" width="6" height="10" rx="3" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0" />
      <path d="M12 18v3" />
      <path d="M9 21h6" />
    </svg>
  );
}

/** Four-suit quadrant toggle emblem for 2-color vs 4-color deck mode. */
export function DeckColorIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width={15} height={15} viewBox="0 0 24 24" {...baseProps} {...props}>
      <rect x="4" y="4" width="7" height="7" rx="2" />
      <rect x="13" y="4" width="7" height="7" rx="2" />
      <rect x="4" y="13" width="7" height="7" rx="2" />
      <rect x="13" y="13" width="7" height="7" rx="2" />
    </svg>
  );
}

/** Poker chip stack / ratio glyph for Chips ↔ Big Blinds display toggle. */
export function ChipsBBIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width={15} height={15} viewBox="0 0 24 24" {...baseProps} {...props}>
      <ellipse cx="12" cy="7" rx="7" ry="2.8" />
      <path d="M5 7v5c0 1.55 3.13 2.8 7 2.8s7-1.25 7-2.8V7" />
      <path d="M5 12v5c0 1.55 3.13 2.8 7 2.8s7-1.25 7-2.8v-5" />
    </svg>
  );
}

export function ChevronDownIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" {...baseProps} {...props}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export function TableIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width={15} height={15} viewBox="0 0 24 24" {...baseProps} {...props}>
      <rect x="3" y="6" width="18" height="12" rx="6" />
      <rect x="7" y="9.5" width="10" height="5" rx="2.5" />
    </svg>
  );
}

export function CoachIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width={15} height={15} viewBox="0 0 24 24" {...baseProps} {...props}>
      <path d="M5 6.5A2.5 2.5 0 0 1 7.5 4h9A2.5 2.5 0 0 1 19 6.5v7A2.5 2.5 0 0 1 16.5 16H10l-4.5 3.5V16A2.5 2.5 0 0 1 5 13.5v-7Z" />
    </svg>
  );
}

export function DiagnosticsIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width={20} height={20} viewBox="0 0 24 24" {...baseProps} {...props}>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3m-11-1 2 2 4-4" />
    </svg>
  );
}

export function MemoryIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width={20} height={20} viewBox="0 0 24 24" {...baseProps} {...props}>
      <rect x="6" y="3" width="14" height="14" rx="3" />
      <path d="M16 21H7a3 3 0 0 1-3-3V9m6-1h6m-6 4h4" />
    </svg>
  );
}

export function ArrowRightIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" {...baseProps} {...props}>
      <path d="M4 12h16m-6-6 6 6-6 6" />
    </svg>
  );
}

export function CloseIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" {...baseProps} {...props}>
      <path d="m6 6 12 12M18 6 6 18" />
    </svg>
  );
}

const dot = (cx: number, cy: number, r = 0.9) => <circle cx={cx} cy={cy} r={r} fill="currentColor" stroke="none" />;

/** Cute decorative figurines; they mean nothing about how a bot plays. */
const FIGURINES: Record<Avatar, ReactNode> = {
  shield: <><path d="M12 3.5 18.5 6v5.5c0 4.2-2.8 7.1-6.5 8.8-3.7-1.7-6.5-4.6-6.5-8.8V6L12 3.5Z" /><path d="m9.3 11.8 2 2 3.6-4" /></>,
  sword: <><path d="M20 4 19 8.5l-8.5 8.5-3.5-3.5L15.5 5 20 4Z" /><path d="m5.5 12.5 6 6" /><path d="m8 16-3.5 3.5" /></>,
  moon: <><path d="M15.5 4.2a8 8 0 1 0 4.3 11.3 6.5 6.5 0 0 1-4.3-11.3Z" />{dot(18.5, 6.5)}</>,
  anchor: <><circle cx="12" cy="5.5" r="1.8" /><path d="M12 7.3V20" /><path d="M8.5 10.5h7" /><path d="M5 13.5c0 3.6 3.1 6.5 7 6.5s7-2.9 7-6.5" /></>,
  owl: <><path d="M6 9c0-3 2.7-5 6-5s6 2 6 5v6c0 3-2.7 5-6 5s-6-2-6-5V9Z" /><path d="M6.5 6 5 3.5M17.5 6 19 3.5" /><circle cx="9.5" cy="10" r="2" /><circle cx="14.5" cy="10" r="2" /><path d="m11.2 12.8.8 1.2.8-1.2" /></>,
  fox: <><path d="m4 4 4.5 3h7L20 4l-1 7-7 9-7-9-1-7Z" />{dot(9.5, 11)}{dot(14.5, 11)}{dot(12, 16)}</>,
  cat: <><path d="M5 4v7c0 4.4 3.1 8 7 8s7-3.6 7-8V4l-4 3.5H9L5 4Z" />{dot(9.5, 12)}{dot(14.5, 12)}<path d="M2.5 13.5h3M18.5 13.5h3" /><path d="M11.3 15h1.4l-.7.8-.7-.8Z" /></>,
  rocket: <><path d="M12 3c3 2.5 4.5 5.8 4.5 9.5V17h-9v-4.5C7.5 8.8 9 5.5 12 3Z" /><circle cx="12" cy="10" r="1.6" /><path d="M7.5 13.5 5 16v3l2.5-2M16.5 13.5 19 16v3l-2.5-2" /><path d="m10.5 19.5 1.5 2 1.5-2" /></>,
  cactus: <><path d="M10 20.5V6a2 2 0 0 1 4 0v14.5" /><path d="M10 13H8a2 2 0 0 1-2-2V9" /><path d="M14 11h2a2 2 0 0 0 2-2V7.5" /><path d="M6.5 20.5h11" /></>,
  mushroom: <><path d="M4 12a8 7 0 0 1 16 0H4Z" /><path d="M9.5 12v6a2.5 2.5 0 0 0 5 0v-6" />{dot(9, 8.5, 1)}{dot(14.5, 8, 1.2)}</>,
  key: <><circle cx="7.5" cy="12" r="3.5" /><path d="M11 12h9.5" /><path d="M17.5 12v3M20.5 12v2.5" /></>,
  compass: <><circle cx="12" cy="12" r="8.5" /><path d="m15.5 8.5-2.2 4.8-4.8 2.2 2.2-4.8 4.8-2.2Z" />{dot(12, 12, 0.7)}</>,
  shark: <><path d="M6 13c3-3 9-4.5 15 0-6 4.5-12 3-15 0Z" /><path d="M6 13 2.5 9.5v7L6 13Z" /><path d="m11 10.3 2-3.8 1.8 3.6" />{dot(17.5, 12.5, 0.8)}</>,
  octopus: <><path d="M6 12a6 6.5 0 0 1 12 0H6Z" /><path d="M6 12c0 3-2 4-2.5 6M9 12.5c0 3-1 5-1.5 6.5M12 12.5v6.5M15 12.5c0 3 1 5 1.5 6.5M18 12c0 3 2 4 2.5 6" />{dot(9.5, 9)}{dot(14.5, 9)}</>,
  feather: <><path d="M20 4c-7.5.5-12.5 5.5-13 13 7.5-.5 12.5-5.5 13-13Z" /><path d="M4 20 16.5 7.5" /></>,
};
const AVATAR_TONES = 5;

/** Seat emblem: the hero's crown, or the bot's randomly drawn decorative figurine. */
export function SeatAvatarIcon({ avatar, isHero }: { avatar: Avatar | null; isHero: boolean }) {
  if (isHero || !avatar) {
    return (
      <svg width={20} height={20} viewBox="0 0 24 24" {...baseProps} className="seat-avatar-svg seat-avatar-svg--hero">
        <path d="M5 17h14l-1.5-8.5-3.5 3-2-5-2 5-3.5-3L5 17Z" />
        <path d="M6.5 20h11" />
      </svg>
    );
  }
  const tone = AVATARS.indexOf(avatar) % AVATAR_TONES;
  return (
    <svg width={20} height={20} viewBox="0 0 24 24" {...baseProps} className={`seat-avatar-svg seat-avatar-svg--tone${tone}`} data-avatar={avatar}>
      {FIGURINES[avatar]}
    </svg>
  );
}

/** Precision geometric SVG felt overlay inside the poker table oval. */
export function FeltOverlaySvg() {
  return (
    <svg
      className="table-felt-svg"
      viewBox="0 0 800 440"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {/* Outer hairline brass & mint betting ellipse */}
      <ellipse
        cx="400"
        cy="220"
        rx="302"
        ry="152"
        fill="none"
        stroke="rgba(212, 255, 232, 0.14)"
        strokeWidth="1.2"
      />
      <ellipse
        cx="400"
        cy="220"
        rx="290"
        ry="142"
        fill="none"
        stroke="rgba(216, 180, 106, 0.12)"
        strokeWidth="0.9"
        strokeDasharray="3 7"
      />
      {/* Cardinal geometric diamond ticks */}
      <polygon points="400,62 405,68 400,74 395,68" fill="rgba(216, 180, 106, 0.22)" />
      <polygon points="400,366 405,372 400,378 395,372" fill="rgba(216, 180, 106, 0.22)" />
      <polygon points="92,220 98,215 104,220 98,225" fill="rgba(212, 255, 232, 0.18)" />
      <polygon points="696,220 702,215 708,220 702,225" fill="rgba(212, 255, 232, 0.18)" />
      {/* Subtle botanical glasshouse center geometry */}
      <circle
        cx="400"
        cy="220"
        r="54"
        fill="none"
        stroke="rgba(86, 240, 159, 0.08)"
        strokeWidth="1"
      />
      <path
        d="M400 184c-11 13-19 21-19 30a11 11 0 0 0 17 9.2l-3.5 7.8h11l-3.5-7.8a11 11 0 0 0 17-9.2c0-9-8-17-19-30Z"
        fill="none"
        stroke="rgba(212, 255, 232, 0.08)"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}
