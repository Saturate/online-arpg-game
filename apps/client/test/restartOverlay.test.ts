import { describe, expect, it } from 'vitest';
import { countdownLeft, initialRestart, nextRestart, RESTART_WAIT_MS, restartRetryMs, SERVICE_RESTART, waitingForServer, type RestartEvent, type RestartState } from '../src/game/restart.js';

function run(start: RestartState, events: readonly RestartEvent[]): RestartState {
  return events.reduce(nextRestart, start);
}

const hidden = initialRestart(false, 0);

describe('restart overlay states', () => {
  it('a deploy: countdown, the server goes down, it comes back on a new build, the tab reloads and resumes', () => {
    const counting = nextRestart(hidden, { e: 'notice', seconds: 60, now: 1000 });
    expect(counting.overlay).toBe('hidden');
    expect(countdownLeft(counting, 1000)).toBe(60);
    expect(countdownLeft(counting, 31_200)).toBe(30);

    const down = nextRestart(counting, { e: 'notice', seconds: 0, now: 61_000 });
    expect(down.overlay).toBe('waiting');
    // The countdown pill gives way to the overlay.
    expect(countdownLeft(down, 61_000)).toBeNull();
    // The close frame that follows changes nothing.
    expect(nextRestart(down, { e: 'closed', code: SERVICE_RESTART, now: 61_010 })).toEqual(down);

    const back = nextRestart(down, { e: 'welcome', outdated: true, now: 120_000 });
    expect(back.overlay).toBe('reloading');

    // The new page starts with the overlay up and drops it on the game's welcome.
    const resumed = initialRestart(true, 0);
    expect(resumed.overlay).toBe('resuming');
    expect(nextRestart(resumed, { e: 'welcome', outdated: false, now: 900 })).toEqual({ overlay: 'hidden', countdownEndsAt: null, since: 900 });
  });

  it('a restart onto the same build hides the overlay as soon as the game is back', () => {
    const s = run(hidden, [
      { e: 'closed', code: SERVICE_RESTART, now: 10 },
      { e: 'welcome', outdated: false, now: 5000 },
    ]);
    expect(s.overlay).toBe('hidden');
  });

  it('an ordinary drop keeps the small reconnect banner, unless the countdown has run out', () => {
    expect(nextRestart(hidden, { e: 'closed', code: 1006, now: 10 }).overlay).toBe('hidden');
    const counting = nextRestart(hidden, { e: 'notice', seconds: 60, now: 0 });
    expect(nextRestart(counting, { e: 'closed', code: 1006, now: 20_000 }).overlay).toBe('hidden');
    // A proxy can swallow the server's last word; a drop at the end of the countdown is the restart.
    expect(nextRestart(counting, { e: 'closed', code: 1006, now: 58_000 }).overlay).toBe('waiting');    // A minute after the countdown ran out with no deploy, a wifi blip is a blip again.
    expect(nextRestart(counting, { e: 'closed', code: 1006, now: 60_000 + 59_000 }).overlay).toBe('waiting');
    expect(nextRestart(counting, { e: 'closed', code: 1006, now: 60_000 + 61_000 }).overlay).toBe('hidden');
  });

  it('spreads the retries between 1.5 and 3 seconds', () => {
    expect(restartRetryMs(0)).toBe(1500);
    expect(restartRetryMs(0.5)).toBe(2250);
    expect(restartRetryMs(1)).toBe(3000);
  });

  it('waits for the server for a few minutes, then gives up', () => {
    const down = nextRestart(hidden, { e: 'notice', seconds: 0, now: 0 });
    expect(waitingForServer(down, 1000)).toBe(true);
    expect(waitingForServer(down, RESTART_WAIT_MS - 1)).toBe(true);
    expect(waitingForServer(down, RESTART_WAIT_MS)).toBe(false);
    expect(waitingForServer(hidden, 0)).toBe(false);
    expect(nextRestart(down, { e: 'done', now: RESTART_WAIT_MS }).overlay).toBe('hidden');
  });
});
