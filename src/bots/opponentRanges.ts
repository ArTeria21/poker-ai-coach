import type { BotView } from './botDecision';
import type { WeightedCombo } from '../equity/ranges';
import { validateCards } from '../equity/ranges';
import { freshDeck } from '../engine/deck';
import { handTier } from './preflopTiers';
import { postflopStrength } from './handStrength';
import { PERSONALITIES } from './personalities';

const BOARD_LENGTH = { preflop: 0, flop: 3, turn: 4, river: 5 };

/** Public observations only. Positive likelihoods preserve bluffs; these are heuristic reads, not solver ranges. */
export function modelOpponentRanges(view: BotView) {
  if (view.publicPlayers.length < 2 || view.publicPlayers.length > 6 || !view.publicPlayers.some(p => p.seatIndex === view.seatIndex)) throw new Error('Public player context required');
  if (view.board.length !== BOARD_LENGTH[view.phase]) throw new Error('Board does not match current street');
  validateCards([...view.holeCards, ...view.board]);
  const deck = freshDeck().filter(c => !view.holeCards.includes(c) && !view.board.includes(c));
  const hands: [string, string][] = [];
  for (let i = 0; i < deck.length; i++) for (let j = i + 1; j < deck.length; j++) hands.push([deck[i], deck[j]]);
  let raises = 0;
  const history = view.publicHistory.map(action => {
    const priorRaises = raises;
    if (action.street === 'preflop' && action.type === 'raise') raises++;
    const boardLength = BOARD_LENGTH[action.street];
    if (boardLength > view.board.length) throw new Error('History includes a future street');
    return { action, priorRaises, board: view.board.slice(0, boardLength) };
  });
  return view.publicPlayers.filter(player => player.seatIndex !== view.seatIndex && !player.folded).map(player => {
    const personality = PERSONALITIES[player.personalityId ?? ''] ?? PERSONALITIES.shark;
    const actions = history.filter(entry => entry.action.seatIndex === player.seatIndex);
    const logWeights = hands.map(cards => {
      let weight = 0;
      for (const { action, priorRaises, board } of actions) {
        let likelihood = 1;
        if (action.street === 'preflop') {
          if (action.type === 'check') continue; // A free BB option reveals no voluntary participation.
          const sizePressure = Math.min(3, Math.max(0, Math.log2(Math.max(1, action.toStreetBet / (3 * view.bigBlind)))));
          const depthBB = (action.stackBefore + action.toStreetBet - action.amountAdded) / view.bigBlind;
          const opening = personality.vpipTierByPosition[player.position] - (1 - personality.pfrRatio) * 1.5;
          let threshold = opening;
          if (action.type === 'raise' && priorRaises) threshold = Math.min(opening - 1.5, 2 + 3 * personality.bluffFrequency);
          if (action.type === 'call') threshold += personality.callStationFactor * 2 - (priorRaises ? 1 : 0);
          if (action.type === 'raise' && depthBB <= 10) threshold += 1 + (10 - depthBB) * 0.1;
          threshold = Math.max(0.8, threshold - sizePressure);
          const bluffFloor = Math.max(0.000001, personality.bluffFrequency * (action.type === 'raise' ? action.toStreetBet > 20 * view.bigBlind ? 0.003 : 0.06 : 0.03));
          likelihood = bluffFloor + (1 - bluffFloor) / (1 + Math.exp((handTier(cards) - threshold) * 1.5));
        } else {
          const info = postflopStrength(cards, board);
          const draw = info.flushDraw || info.straightDraw ? 0.3 : 0;
          if (action.type === 'raise') {
            const size = Math.min(3, action.amountAdded / Math.max(1, action.potBefore));
            const value = Math.pow(info.strength, 1 + size);
            likelihood = personality.bluffFrequency + value + draw * personality.aggressionFactor;
          } else if (action.type === 'call') {
            const price = action.toCallBefore / Math.max(1, action.potBefore + action.toCallBefore);
            likelihood = 0.03 + personality.callStationFactor * 0.3 + Math.max(0, info.strength - price) + draw;
          } else if (action.type === 'check') {
            likelihood = 1 - 0.7 * info.strength; // Strong hands retain a slow-play branch.
          }
        }
        weight += Math.log(likelihood);
      }
      return weight;
    });
    const maximum = Math.max(...logWeights);
    const range: WeightedCombo[] = hands.map((cards, i) => ({ cards: [...cards], weight: Math.exp(Math.max(-700, logWeights[i] - maximum)) }));
    return {
      seatIndex: player.seatIndex,
      range,
      assumptions: ['Uniform dealt-card prior; public position, personality and action-size likelihoods.', 'Soft value/draw/bluff heuristics; no hidden hands or future street cards.'],
    };
  });
}
