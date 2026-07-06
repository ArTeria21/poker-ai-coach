import { listHands, saveHand, type StoredHand } from '../stats/db';
import { useProgressStore, type LessonResult } from '../store/progressStore';

/**
 * Cross-device sync against the tiny storage API in server.js. When the app
 * is served by that server, lesson progress and hand history flow both ways
 * on startup and stream up as you play. When it isn't (npm run dev, or the
 * server is unreachable), everything silently stays local-only.
 */

let syncEnabled = false;

async function api<T>(path: string, init?: RequestInit): Promise<T | undefined> {
  try {
    const res = await fetch(`/api/${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) return undefined;
    // Vite's dev SPA fallback answers unknown paths with index.html — treat as no server
    const type = res.headers.get('content-type') ?? '';
    if (!type.includes('application/json')) return undefined;
    return (await res.json()) as T;
  } catch {
    return undefined;
  }
}

/** Best attempt wins: passed > score > recency. Pure — unit tested. */
export function mergeLessonResults(
  a: Record<string, LessonResult>,
  b: Record<string, LessonResult>,
): Record<string, LessonResult> {
  const better = (x: LessonResult, y: LessonResult): LessonResult => {
    if (x.passed !== y.passed) return x.passed ? x : y;
    if (x.score !== y.score) return x.score > y.score ? x : y;
    return x.at >= y.at ? x : y;
  };
  const out: Record<string, LessonResult> = { ...a };
  for (const [id, r] of Object.entries(b)) {
    out[id] = out[id] ? better(out[id], r) : r;
  }
  return out;
}

/** Two-way sync at app start; then subscribes to keep progress flowing up. */
export async function syncOnStartup(): Promise<void> {
  const health = await api<{ ok: boolean }>('health');
  if (!health?.ok) return;
  syncEnabled = true;

  // lesson progress: merge both directions
  const remote = (await api<Record<string, LessonResult> | null>('state/progress')) ?? {};
  const local = useProgressStore.getState().results;
  const merged = mergeLessonResults(local, remote ?? {});
  useProgressStore.setState({ results: merged });
  void api('state/progress', { method: 'PUT', body: JSON.stringify(merged) });

  // hands: push what the server lacks, pull what we lack
  const remoteIds = new Set((await api<string[]>('hands/ids')) ?? []);
  const localHands = await listHands(10_000);
  const localIds = new Set(localHands.map((h) => h.handId));
  for (const h of localHands) {
    if (!remoteIds.has(h.handId)) pushHandToServer(h);
  }
  if ([...remoteIds].some((id) => !localIds.has(id))) {
    const all = (await api<StoredHand[]>('hands')) ?? [];
    for (const h of all) {
      if (!localIds.has(h.handId)) await saveHand(h);
    }
  }

  // future lesson results stream up as they happen
  useProgressStore.subscribe((state, prev) => {
    if (state.results !== prev.results) {
      void api('state/progress', { method: 'PUT', body: JSON.stringify(state.results) });
    }
  });
}

/** Fire-and-forget upload of a freshly played hand. */
export function pushHandToServer(hand: StoredHand): void {
  if (!syncEnabled) return;
  void api(`hands/${encodeURIComponent(hand.handId)}`, {
    method: 'PUT',
    body: JSON.stringify(hand),
  });
}
