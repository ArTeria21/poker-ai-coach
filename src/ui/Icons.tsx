import type { SVGProps } from 'react';

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

/** Deterministic FNV-1a 32-bit hash of a public player name for neutral avatar selection. */
function hashName(name: string): number {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const AVATAR_SHAPES = 6;
const AVATAR_TONES = 5;

/**
 * Minimalist 1.5px-stroke geometric player emblem.
 * Hero is identified by `isHero`; bots derive shape & tone strictly from a hash of `name`
 * so hidden bot archetypes are never leaked through the UI.
 */
export function SeatAvatarIcon({ name, isHero }: { name: string; isHero: boolean }) {
  if (isHero) {
    return (
      <svg width={20} height={20} viewBox="0 0 24 24" {...baseProps} className="seat-avatar-svg seat-avatar-svg--hero">
        <path d="M5 17h14l-1.5-8.5-3.5 3-2-5-2 5-3.5-3L5 17Z" />
        <path d="M6.5 20h11" />
      </svg>
    );
  }
  const hash = hashName(name);
  const shape = hash % AVATAR_SHAPES;
  const tone = Math.floor(hash / AVATAR_SHAPES) % AVATAR_TONES;
  const cls = `seat-avatar-svg seat-avatar-svg--tone${tone}`;
  switch (shape) {
    case 0:
      /* Geometric diamond prism */
      return (
        <svg width={20} height={20} viewBox="0 0 24 24" {...baseProps} className={cls} data-avatar-shape={shape}>
          <polygon points="12,3.5 19.5,12 12,20.5 4.5,12" />
          <polygon points="12,8.2 15.8,12 12,15.8 8.2,12" />
        </svg>
      );
    case 1:
      /* Concentric hexagon */
      return (
        <svg width={20} height={20} viewBox="0 0 24 24" {...baseProps} className={cls} data-avatar-shape={shape}>
          <polygon points="12,3.5 19,7.5 19,16.5 12,20.5 5,16.5 5,7.5" />
          <polygon points="12,8 15.5,10 15.5,14 12,16 8.5,14 8.5,10" />
        </svg>
      );
    case 2:
      /* Four-point compass star */
      return (
        <svg width={20} height={20} viewBox="0 0 24 24" {...baseProps} className={cls} data-avatar-shape={shape}>
          <path d="M12 3.5 14.3 9.7 20.5 12l-6.2 2.3L12 20.5l-2.3-6.2L3.5 12l6.2-2.3L12 3.5Z" />
          <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
        </svg>
      );
    case 3:
      /* Minimalist geometric shield */
      return (
        <svg width={20} height={20} viewBox="0 0 24 24" {...baseProps} className={cls} data-avatar-shape={shape}>
          <path d="M12 3.5 18.5 6.5v5.2c0 4.2-2.7 7.1-6.5 8.8-3.8-1.7-6.5-4.6-6.5-8.8V6.5L12 3.5Z" />
          <path d="M12 7.5v9" />
        </svg>
      );
    case 4:
      /* Orbital ring */
      return (
        <svg width={20} height={20} viewBox="0 0 24 24" {...baseProps} className={cls} data-avatar-shape={shape}>
          <circle cx="12" cy="12" r="7.5" />
          <ellipse cx="12" cy="12" rx="7.5" ry="3.2" transform="rotate(-32 12 12)" />
          <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
        </svg>
      );
    default:
      /* Faceted crest */
      return (
        <svg width={20} height={20} viewBox="0 0 24 24" {...baseProps} className={cls} data-avatar-shape={shape}>
          <polygon points="12,4 20,18 4,18" />
          <polygon points="12,9.5 16,16 8,16" />
        </svg>
      );
  }
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
