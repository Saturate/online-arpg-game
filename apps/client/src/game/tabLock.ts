/**
 * One game per browser. The server already allows one session per account, but two tabs would keep
 * taking the game from each other (a stale tab resumes after every deploy). So a tab entering the
 * game tells the others, and any tab that is playing steps aside and offers to take it back.
 */

const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('rune.game') : null;
const tabId = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : String(Math.random());

function isClaim(v: unknown): v is { claim: string } {
  return typeof v === 'object' && v !== null && 'claim' in v && typeof v.claim === 'string';
}

/** Takes the game for this tab; `onLost` runs if another tab takes it later. Returns the cleanup. */
export function claimGame(onLost: () => void): () => void {
  if (!channel) return () => undefined;
  const onMessage = (e: MessageEvent<unknown>) => {
    if (isClaim(e.data) && e.data.claim !== tabId) onLost();
  };
  channel.addEventListener('message', onMessage);
  channel.postMessage({ claim: tabId });
  return () => channel.removeEventListener('message', onMessage);
}
