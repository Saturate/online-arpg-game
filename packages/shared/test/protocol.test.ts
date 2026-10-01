import { describe, expect, it } from 'vitest';
import { parseClientMessage, cleanChat, CHAT_MAX_LENGTH, isPartyStatus, isServerMessage, isTeleportChannel } from '../src/index.js';

describe('parseClientMessage', () => {
  it('accepts a valid input and strips unknown button bits', () => {
    const msg = parseClientMessage({ t: 'input', seq: 1, moveDir: { x: 1, y: 0 }, aimAngle: 0.5, buttons: 0xff });
    expect(msg).toEqual({ t: 'input', seq: 1, moveDir: { x: 1, y: 0 }, aimAngle: 0.5, buttons: 0b11111 });
  });

  it.each([
    null,
    'input',
    { t: 'input', seq: -1, moveDir: { x: 0, y: 0 }, aimAngle: 0, buttons: 0 },
    { t: 'input', seq: 1.5, moveDir: { x: 0, y: 0 }, aimAngle: 0, buttons: 0 },
    { t: 'input', seq: 1, moveDir: { x: 'a', y: 0 }, aimAngle: 0, buttons: 0 },
    { t: 'input', seq: 1, moveDir: { x: 0, y: 0 }, aimAngle: null, buttons: 0 },
    { t: 'join', classId: 'necromancer' },
    { t: 'ping', clientTime: 'now' },
    { t: 'admin' },
    { t: 'planMismatch', roomId: 'i1-world', server: 'deadbeef', client: 'not hex!' },
    { t: 'planMismatch', roomId: 'i1-world', server: 'deadbeef0', client: '01234567' },
    { t: 'planMismatch', roomId: 'I1 world\n', server: 'deadbeef', client: '01234567' },
    { t: 'planMismatch', roomId: 'x'.repeat(65), server: 'deadbeef', client: '01234567' },
  ])('rejects %j', (value) => {
    expect(parseClientMessage(value)).toBeNull();
  });

  it('accepts a plan mismatch report of two hashes and a room id, and nothing else from it', () => {
    expect(parseClientMessage({ t: 'planMismatch', roomId: 'i1-world', server: 'deadbeef', client: '01234567', extra: 'x' })).toEqual({ t: 'planMismatch', roomId: 'i1-world', server: 'deadbeef', client: '01234567' });
  });
});

describe('chat', () => {
  it('strips control and zero-width characters, collapses space and caps length', () => {
    expect(cleanChat('  hi​ there\u0007  ')).toBe('hi there');
    expect(cleanChat('a\n\nb')).toBe('a b');
    expect(cleanChat('x'.repeat(500))?.length).toBe(CHAT_MAX_LENGTH);
    expect(cleanChat('   ')).toBeNull();
    expect(cleanChat(42)).toBeNull();
    expect(parseClientMessage({ t: 'chat', text: '<b>hi</b>' })).toEqual({ t: 'chat', text: '<b>hi</b>' });
  });
});

describe('party frames messages', () => {
  const member = { name: 'Ada', cls: 'warrior', level: 7, life: 40, maxLife: 90, dead: false, place: 'wilds', zone: 'Blood Moor' };

  it('accepts a party status, with or without a position and a refusal', () => {
    expect(isPartyStatus({ t: 'partyStatus', members: [] })).toBe(true);
    expect(isPartyStatus({ t: 'partyStatus', members: [member, { ...member, x: 10, y: 20, no: 'Ada is in an Arena run' }] })).toBe(true);
    expect(isPartyStatus({ t: 'partyStatus', members: [{ ...member, cls: null, place: 'offline', zone: '' }] })).toBe(true);
    expect(isServerMessage({ t: 'partyStatus', members: [member] })).toBe(true);
  });

  it.each([
    { t: 'partyStatus' },
    { t: 'partyStatus', members: {} },
    { t: 'partyStatus', members: [{ ...member, cls: 'bard' }] },
    { t: 'partyStatus', members: [{ ...member, place: 'moon' }] },
    { t: 'partyStatus', members: [{ ...member, life: 'lots' }] },
    { t: 'partyStatus', members: [{ ...member, level: -1 }] },
    { t: 'partyStatus', members: [{ ...member, x: 10 }] },
    { t: 'partyStatus', members: [{ ...member, x: 10, y: Number.NaN }] },
    { t: 'partyStatus', members: [{ ...member, no: 4 }] },
    { t: 'partyStatus', members: Array.from({ length: 64 }, () => member) },
  ])('refuses a malformed party status %#', (bad) => {
    expect(isPartyStatus(bad)).toBe(false);
    expect(isServerMessage(bad)).toBe(false);
  });

  it('checks the teleport channel message', () => {
    expect(isTeleportChannel({ t: 'teleportChannel', to: 'Ada', seconds: 3 })).toBe(true);
    expect(isTeleportChannel({ t: 'teleportChannel', to: null, reason: null })).toBe(true);
    expect(isTeleportChannel({ t: 'teleportChannel', to: null, reason: 'Teleport cancelled: you moved' })).toBe(true);
    expect(isTeleportChannel({ t: 'teleportChannel', to: 'Ada', seconds: 0 })).toBe(false);
    expect(isTeleportChannel({ t: 'teleportChannel', to: null })).toBe(false);
  });

  it('parses a teleport request by name only', () => {
    expect(parseClientMessage({ t: 'partyTeleport', name: 'Ada' })).toEqual({ t: 'partyTeleport', name: 'Ada' });
    expect(parseClientMessage({ t: 'partyTeleport', name: '' })).toBeNull();
    expect(parseClientMessage({ t: 'partyTeleport', name: 'x'.repeat(25) })).toBeNull();
    expect(parseClientMessage({ t: 'partyTeleport', name: 3 })).toBeNull();
  });
});
