/** Chip counts as shown at the table, e.g. "12,000". */
export function formatChips(n: number): string {
  return n.toLocaleString('en-US');
}
