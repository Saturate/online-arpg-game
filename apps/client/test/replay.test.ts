import { describe, expect, it } from 'vitest';
import type { ServerMessage } from '@rune/shared';
import { decodeReplay, encodeReplay, parseReplay, Recorder, seekIndex, withoutEvents, type ReplayFrame } from '../src/game/replay.js';

const welcome = (roomId: string): ServerMessage => ({
  t: 'welcome',
  playerId: 1,
  tick: 0,
  tickMs: 50,
  roomId,
  map: { kind: 'flat' },
  canPause: false,
  editor: false,
  townEditor: false,
  devTools: false,
});

describe('replay files', () => {
  it('seeds a mid-room recording with the room state and skips pongs', () => {
    const rec = new Recorder('mage', 'Ember', [welcome('town')]);
    rec.record({ t: 'pong', clientTime: 1 });
    rec.record({ t: 'notice', text: 'hi' });
    const file = rec.finish();
    expect(file.frames.map((f) => f.msg.t)).toEqual(['welcome', 'notice']);
    expect(parseReplay(JSON.parse(JSON.stringify(file)))).toMatchObject({ name: 'Ember', classId: 'mage' });
  });

  it('rejects malformed files', () => {
    expect(parseReplay({ version: 2 })).toBe('Unsupported replay version');
    expect(parseReplay({ version: 1, recordedAt: 0, classId: 'mage', name: 'x', durationMs: 1, frames: [{ at: 0, msg: { t: 'bogus' } }] })).toBe('Replay frames are malformed');
    expect(parseReplay({ version: 1, recordedAt: 0, classId: 'mage', name: 'x', durationMs: 1, frames: [{ at: 0, msg: { t: 'notice', text: 'x' } }] })).toBe('Replay has no room to show');
  });

  it('seeks from the last room entry before the target', () => {
    const frames: ReplayFrame[] = [
      { at: 0, msg: welcome('town') },
      { at: 100, msg: { t: 'notice', text: 'a' } },
      { at: 200, msg: welcome('wilds') },
      { at: 300, msg: { t: 'notice', text: 'b' } },
    ];
    expect(seekIndex(frames, 150)).toBe(0);
    expect(seekIndex(frames, 250)).toBe(2);
    expect(seekIndex(frames, 10_000)).toBe(2);
  });

  it('strips events only from snapshots', () => {
    const notice: ServerMessage = { t: 'notice', text: 'x' };
    expect(withoutEvents(notice)).toBe(notice);
  });

  it('round-trips through gzip', async () => {
    const rec = new Recorder('warrior', 'Brakk', [welcome('town')]);
    const decoded = await decodeReplay(await encodeReplay(rec.finish()));
    expect(typeof decoded === 'string' ? decoded : decoded.name).toBe('Brakk');
  });
});
