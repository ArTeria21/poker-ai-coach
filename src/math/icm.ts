import { nonnegative, chipAmount } from './pokerMath';

function validate(stacks: number[], payouts: number[]): number[] {
  if (stacks.length < 1 || stacks.length > 6 || payouts.length > stacks.length) throw new Error('ICM needs 1..6 seats and at most one payout per seat');
  stacks.forEach(s => chipAmount(s, 'Stack'));
  chipAmount(stacks.reduce((a,b) => a+b, 0), 'Total stack');
  payouts.forEach((p, i) => {
    nonnegative(p, 'Payout');
    if (i && p > payouts[i - 1]) throw new Error('Payouts must be nonincreasing');
  });
  if (!Number.isFinite(stacks.reduce((a,b) => a+b, 0)) || !Number.isFinite(payouts.reduce((a,b) => a+b, 0))) throw new Error('Totals must be finite');
  return Array.from({ length: stacks.length }, (_, i) => payouts[i] ?? 0);
}

/** Exact independent chip model. Zero-stack groups rank best to worst among bottom places and split their occupied prizes. */
export function icmEquities(stacks: number[], payouts: number[], eliminationGroups?: number[][]): number[] {
  const prizes = validate(stacks, payouts);
  const alive = stacks.map((s,i) => s > 0 ? i : -1).filter(i => i >= 0);
  const zeros = stacks.map((s,i) => s === 0 ? i : -1).filter(i => i >= 0);
  if (!alive.length && !eliminationGroups) throw new Error('No live stacks; explicit finishing groups required');
  if (zeros.length > 1 && !eliminationGroups) throw new Error('Multiple zero stacks require finishing groups');
  const groups = eliminationGroups ?? zeros.map(i => [i]);
  const placements = groups.flat();
  if (groups.some(g => !g.length) || placements.length !== zeros.length || new Set(placements).size !== zeros.length || placements.some(i => !Number.isInteger(i) || !zeros.includes(i))) throw new Error('Finishing groups must cover exactly the zero stacks');
  const result = stacks.map(() => 0);
  let place = alive.length;
  for (const group of groups) {
    const share = prizes.slice(place, place + group.length).reduce((a,b) => a+b, 0) / group.length;
    group.forEach(i => { result[i] = share; });
    place += group.length;
  }
  const recurse = (remaining: number[], position: number, chance: number) => {
    if (!remaining.length) return;
    const total = remaining.reduce((sum,i) => sum + stacks[i], 0);
    for (const i of remaining) {
      const probability = chance * stacks[i] / total;
      result[i] += probability * prizes[position];
      recurse(remaining.filter(j => j !== i), position + 1, probability);
    }
  };
  recurse(alive, 0, 1);
  return result;
}

export interface SettledOutcome { probability: number; stacks: number[]; eliminationGroups?: number[][] }
/** Explicit settled chip outcomes (wins, losses and ties separately), with conserved chips. */
export function icmOutcomeEV(stacks: number[], payouts: number[], hero: number, outcomes: SettledOutcome[]) {
  const baseline = icmEquities(stacks, payouts);
  if (!Number.isInteger(hero) || hero < 0 || hero >= stacks.length || !outcomes.length) throw new Error('Invalid hero or empty outcomes');
  const total = stacks.reduce((a,b) => a+b, 0);
  let probabilitySum = 0, expectedEquity = 0;
  for (const outcome of outcomes) {
    nonnegative(outcome.probability, 'Outcome probability');
    if (outcome.probability > 1 || outcome.stacks.length !== stacks.length || outcome.stacks.reduce((a,b) => a+b, 0) !== total) throw new Error('Outcome must conserve chips and have a valid probability');
    expectedEquity += outcome.probability * icmEquities(outcome.stacks, payouts, outcome.eliminationGroups)[hero];
    probabilitySum += outcome.probability;
  }
  if (Math.abs(probabilitySum - 1) > 1e-9) throw new Error('Outcome probabilities must sum to one');
  return { expectedEquity, delta: expectedEquity - baseline[hero] };
}

/** Symmetric chip transfer against one opponent, no dead pot. Risk premium is relative to 50% chip break-even. */
export function bubbleFactor(stacks: number[], payouts: number[], hero: number, opponent: number, risk: number): { status: 'finite' | 'precision-limit' | 'undefined'; factor: number | null; riskPremium: number | null; loss: number; gain: number } {
  const baseline = icmEquities(stacks, payouts);
  if (stacks.some(s => s <= 0) || !Number.isInteger(hero) || !Number.isInteger(opponent) || hero < 0 || opponent < 0 || hero >= stacks.length || opponent >= stacks.length || hero === opponent) throw new Error('Bubble factor needs distinct live players');
  if (!Number.isSafeInteger(risk) || risk <= 0 || risk > Math.min(stacks[hero], stacks[opponent])) throw new Error('Risk must be positive and covered by both stacks');
  if (stacks.every((_, i) => (payouts[i] ?? 0) === (payouts[0] ?? 0))) return { status: 'undefined', factor: null, riskPremium: null, loss: 0, gain: 0 };
  const win = stacks.slice(), lose = stacks.slice();
  win[hero] += risk; win[opponent] -= risk;
  lose[hero] -= risk; lose[opponent] += risk;
  const loss = baseline[hero] - icmEquities(lose, payouts)[hero];
  const gain = icmEquities(win, payouts)[hero] - baseline[hero];
  // Six-player ICM sums up to 720 placements; subtraction below this roundoff scale is unreliable.
  const precisionFloor = 1024 * Number.EPSILON * payouts.reduce((sum, prize) => sum + prize, 0);
  if (loss <= precisionFloor || gain <= precisionFloor || !Number.isFinite(loss / gain)) return { status: 'precision-limit', factor: null, riskPremium: null, loss, gain };
  return { status: 'finite', factor: loss / gain, riskPremium: loss / (loss + gain) - 0.5, loss, gain };
}
