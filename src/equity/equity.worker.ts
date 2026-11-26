import { monteCarloEquity, type EquityOptions } from './monteCarlo';

interface EquityRequest {
  requestId: number;
  opts: EquityOptions;
}

self.onmessage = (e: MessageEvent<EquityRequest>) => {
  const { requestId, opts } = e.data;
  try {
    const result = monteCarloEquity(opts);
    self.postMessage({ requestId, result });
  } catch (error) {
    self.postMessage({ requestId, error: error instanceof Error ? error.message : String(error) });
  }
};
