import type { EquityOptions, EquityResult } from './monteCarlo';

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (r: EquityResult) => void; reject: (e: Error) => void }>();

function failWorker(): void {
  worker?.terminate();
  worker = null;
  for (const request of pending.values()) request.reject(new Error('Equity worker failed'));
  pending.clear();
}

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./equity.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ requestId: number; result?: EquityResult; error?: string }>) => {
      const { requestId, result, error } = e.data;
      const request = pending.get(requestId);
      pending.delete(requestId);
      if (error !== undefined) request?.reject(new Error(error));
      else if (result) request?.resolve(result);
      else request?.reject(new Error('Invalid equity worker response'));
    };
    worker.onerror = failWorker;
    worker.onmessageerror = failWorker;
  }
  return worker;
}

/** Runs a Monte Carlo equity simulation off the main thread. */
export function getEquity(opts: EquityOptions): Promise<EquityResult> {
  const requestId = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    try {
      getWorker().postMessage({ requestId, opts });
    } catch (error) {
      pending.delete(requestId);
      reject(error);
    }
  });
}
