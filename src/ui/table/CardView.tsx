import type { Card } from '../../cards/deck';
import { isRedSuit, rankLabel, suitSymbol } from '../../game/format';
import { useSettingsStore } from '../../app/settingsStore';

interface CardViewProps {
  /** Undefined renders a face-down card back. */
  card?: Card;
  size?: 'board' | 'hole' | 'mini';
  /** Stagger index for the deal-in animation. */
  dealIndex?: number;
  dimmed?: boolean;
}

function suitColorClass(card: Card, fourColorDeck: boolean): string {
  if (!fourColorDeck) return isRedSuit(card) ? 'card--red' : 'card--black';
  switch (card[1]) {
    case 'h':
      return 'card--red';
    case 'd':
      return 'card--blue';
    case 'c':
      return 'card--green';
    default:
      return 'card--black';
  }
}

export function CardView({ card, size = 'board', dealIndex = 0, dimmed = false }: CardViewProps) {
  const fourColorDeck = useSettingsStore((s) => s.fourColorDeck);
  const classes = ['card', `card--${size}`, dimmed ? 'card--dimmed' : '']
    .filter(Boolean)
    .join(' ');
  if (!card) {
    return (
      <div className={`${classes} card--back`} style={{ animationDelay: `${dealIndex * 90}ms` }}>
        <div className="card-back-pattern" />
      </div>
    );
  }
  return (
    <div
      className={`${classes} ${suitColorClass(card, fourColorDeck)}`}
      style={{ animationDelay: `${dealIndex * 90}ms` }}
    >
      <span className="card-corner">
        <b>{rankLabel(card)}</b>
        <i>{suitSymbol(card)}</i>
      </span>
      <span className="card-pip">{suitSymbol(card)}</span>
    </div>
  );
}
