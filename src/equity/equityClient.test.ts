import { afterEach, expect, it, vi } from 'vitest';

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage?: (event: { data: unknown }) => void;
  onerror?: () => void;
  onmessageerror?: () => void;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() { FakeWorker.instances.push(this); }
}
const opts = { hero: ['As', 'Kh'] as [string, string], board: [], opponents: 1, iterations: 10 };
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); FakeWorker.instances = []; });

it('rejects validation errors and keeps the worker available', async () => {
  vi.stubGlobal('Worker', FakeWorker);
  const { getEquity } = await import('./equityClient');
  const promise = getEquity(opts);
  const worker = FakeWorker.instances[0];
  const { requestId } = worker.postMessage.mock.calls[0][0];
  worker.onmessage!({ data: { requestId, error: 'Invalid card' } });
  await expect(promise).rejects.toThrow('Invalid card');
});
it.each(['onerror', 'onmessageerror'] as const)('rejects all pending requests on %s and recreates the worker', async event => {
  vi.stubGlobal('Worker', FakeWorker);
  const { getEquity } = await import('./equityClient');
  const a = getEquity(opts), b = getEquity(opts);
  const checks = [expect(a).rejects.toThrow('worker failed'), expect(b).rejects.toThrow('worker failed')];
  FakeWorker.instances[0][event]!();
  await Promise.all(checks);
  const c = getEquity(opts);
  expect(FakeWorker.instances).toHaveLength(2);
  const worker = FakeWorker.instances[1];
  worker.onmessage!({ data: { requestId: worker.postMessage.mock.calls[0][0].requestId, result: { equity: 0.5 } } });
  await expect(c).resolves.toEqual({ equity: 0.5 });
});
it('rejects synchronous worker construction failure', async () => {
  vi.stubGlobal('Worker', class { constructor() { throw new Error('Unavailable'); } });
  const { getEquity } = await import('./equityClient');
  await expect(getEquity(opts)).rejects.toThrow('Unavailable');
});
