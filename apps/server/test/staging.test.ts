import { DUNGEON, SIM, type ServerMessage } from '@rune/shared';
import { describe, expect, it } from 'vitest';
import { Client, type ClientSocket } from '../src/client.js';
import { Room } from '../src/room.js';
import { Staging } from '../src/staging.js';

// A closed socket makes send a no-op.
function fakeClient(id: string): Client {
  const socket: ClientSocket = { readyState: 3, OPEN: 1, send: () => undefined, close: () => undefined };
  return new Client(id, socket);
}

describe('Staging ready check', () => {
  const ref = { seed: 5, level: 2 };

  it('counts down only once everyone is ready, and a newcomer stops it', () => {
    const room = new Room('staging-5-2', { kind: 'staging', ...ref }, 1);
    const staging = new Staging(room, { kind: 'dungeon', ref });
    const a = fakeClient('a');
    const b = fakeClient('b');
    room.add(a, 'mage', 'Ann');
    room.add(b, 'warrior', 'Bo');
    staging.setReady(a, true);
    expect(staging.countdown).toBeNull();
    staging.setReady(b, true);
    expect(staging.countdown).toBe(DUNGEON.countdownSeconds * SIM.tickRate);

    const c = fakeClient('c');
    room.add(c, 'priest', 'Cy');
    staging.recheck();
    expect(staging.countdown).toBeNull();

    room.remove(c);
    staging.recheck();
    let fired = 0;
    for (let i = 0; i < DUNGEON.countdownSeconds * SIM.tickRate; i++) if (staging.tick()) fired++;
    expect(fired).toBe(1);
    // Ready flags reset so the next run needs a fresh check.
    expect(staging.ready.size).toBe(0);
  });

  it('reports members and whether a run is live', () => {
    const room = new Room('staging-5-2', { kind: 'staging', ...ref }, 1);
    const staging = new Staging(room, { kind: 'dungeon', ref });
    room.add(fakeClient('a'), 'binder', 'Kay');
    staging.runRoomId = 'dungeon-5-2-0';
    const msg: ServerMessage = staging.message(3);
    expect(msg).toMatchObject({ t: 'staging', kind: 'dungeon', members: [{ name: 'Kay', cls: 'binder', ready: false }], open: true, inside: 3, level: 2 });
  });
});
