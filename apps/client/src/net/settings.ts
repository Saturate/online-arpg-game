import { NET } from '@rune/shared';

const params = new URLSearchParams(location.search);

function numberParam(name: string, fallback: number): number {
  const raw = params.get(name);
  if (raw === null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** `?lag=150` adds 150 ms of round-trip latency, split evenly between the two directions. */
export const netSettings = {
  serverUrl: params.get('server') ?? `ws://${location.hostname}:${NET.defaultPort}`,
  addedRttMs: numberParam('lag', 0),
};
