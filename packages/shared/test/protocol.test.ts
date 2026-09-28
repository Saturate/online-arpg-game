import { describe, expect, it } from 'vitest';
import { parseClientMessage, cleanChat, CHAT_MAX_LENGTH } from '../src/index.js';

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
  ])('rejects %j', (value) => {
    expect(parseClientMessage(value)).toBeNull();
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
