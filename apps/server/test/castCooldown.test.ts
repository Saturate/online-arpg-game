import { DEFAULT_SERVER_SETTINGS, HEAT, parseSettingsPatch, SETTINGS_LIMITS, SKILL_BUTTONS, type ServerMessage } from '@rune/shared';
import { describe, expect, it } from 'vitest';
import { AccountStore } from '../src/accounts.js';
import { RoomManager } from '../src/manager.js';
import { FakeSocket } from './fakeSocket.js';

type Welcome = Extract<ServerMessage, { t: 'welcome' }>;

async function setup() {
  const store = new AccountStore(':memory:');
  const rooms = new RoomManager(1, store, new Set(['player0']));
  const acc = await store.register('player0', 'password123');
  if (acc === 'taken') throw new Error('taken');
  const ch = store.createCharacter(acc.id, 'Hero0', 'mage');
  if (typeof ch === 'string') throw new Error(ch);
  const socket = new FakeSocket();
  rooms.connect(socket);
  socket.emit({ t: 'join', token: store.createSession(acc.id), characterId: ch.id });
  socket.emit({ t: 'dev', cmd: { c: 'god', on: true } });
  rooms.tick();
  return { store, rooms, socket };
}

function welcome(s: FakeSocket): Welcome {
  const w = s.last('welcome');
  if (!w) throw new Error('no welcome');
  return w;
}

function player(rooms: RoomManager, s: FakeSocket) {
  const room = rooms.roomById(welcome(s).roomId);
  const p = room?.sim.world.player.get(welcome(s).playerId);
  if (!p) throw new Error('no player');
  return p;
}

let seq = 0;

/** Holds the first skill for one tick and returns the cooldown left after it. */
function holdSkill(rooms: RoomManager, s: FakeSocket): number {
  const p = player(rooms, s);
  p.heat = 0;
  s.emit({ t: 'input', seq: ++seq, moveDir: { x: 0, y: 0 }, aimAngle: 0, buttons: SKILL_BUTTONS[0] });
  rooms.tick();
  return p.castCooldown;
}

describe('cast cooldown setting', () => {
  it('defaults to 0.5 s and accepts only 0.1 to 3 s', () => {
    expect(DEFAULT_SERVER_SETTINGS.castCooldownSeconds).toBe(0.5);
    expect(DEFAULT_SERVER_SETTINGS.castCooldownSeconds).toBe(HEAT.castCooldownSeconds);
    expect(parseSettingsPatch({ castCooldownSeconds: 0.8 })).toEqual({ castCooldownSeconds: 0.8 });
    expect(parseSettingsPatch({ castCooldownSeconds: SETTINGS_LIMITS.castCooldownMin })).toEqual({ castCooldownSeconds: 0.1 });
    expect(parseSettingsPatch({ castCooldownSeconds: SETTINGS_LIMITS.castCooldownMax })).toEqual({ castCooldownSeconds: 3 });
    for (const bad of [0.05, 0, -1, 3.5, Number.NaN, '0.5', null]) expect(parseSettingsPatch({ castCooldownSeconds: bad }), String(bad)).toMatch(/castCooldownSeconds/);
  });

  it('survives a restart and a bad stored value falls back to the default', async () => {
    const store = new AccountStore(':memory:');
    store.saveSettings({ ...DEFAULT_SERVER_SETTINGS, castCooldownSeconds: 1.2 });
    expect(store.loadSettings().castCooldownSeconds).toBe(1.2);
    store.saveSettings({ ...DEFAULT_SERVER_SETTINGS, castCooldownSeconds: 99 });
    expect(store.loadSettings().castCooldownSeconds).toBe(DEFAULT_SERVER_SETTINGS.castCooldownSeconds);
  });

  it('reaches the client in the welcome and again when an admin changes it', async () => {
    const { rooms, socket } = await setup();
    expect(welcome(socket).castCooldown).toBe(DEFAULT_SERVER_SETTINGS.castCooldownSeconds);
    rooms.updateSettings({ castCooldownSeconds: 0.9 });
    expect(socket.last('castCooldown')?.seconds).toBe(0.9);
  });

  it('is enforced live: the next cast after a change waits the new time', async () => {
    const { rooms, socket } = await setup();
    const p = player(rooms, socket);
    // The starter sigil in slot 0 has no cast delay roll and a fresh mage has cast speed 1.
    expect(holdSkill(rooms, socket)).toBeCloseTo(DEFAULT_SERVER_SETTINGS.castCooldownSeconds - 0.05, 5);
    rooms.updateSettings({ castCooldownSeconds: 1.5 });
    // The running cooldown keeps its length; held through it, the next cast starts the new one.
    while (p.castCooldown > 0) holdSkill(rooms, socket);
    expect(holdSkill(rooms, socket)).toBeCloseTo(1.5 - 0.05, 5);
    let held = 0;
    while (p.castCooldown > 0) {
      holdSkill(rooms, socket);
      held++;
    }
    // 1.5 s at 20 ticks a second: 29 more ticks of waiting after the tick that cast.
    expect(held).toBe(29);
  });
});
