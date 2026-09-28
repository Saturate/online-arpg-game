import { BUTTON, SKILL_BUTTONS } from '@rune/shared';

/**
 * Standard-mapping gamepad (Xbox layout): left stick moves, right stick aims, right trigger is the
 * primary attack, the face buttons are skills 1 to 4. Start opens the menu, Back the inventory.
 */

const DEADZONE = 0.22;
/** Face buttons in the standard mapping: A, X, Y, B, so the most comfortable press is skill 1. */
const SKILL_PADS = [0, 2, 3, 1] as const;
const RT = 7;
const LT = 6;
const START = 9;
const BACK = 8;
const RB = 5;
const LB = 4;

export type PadAction = 'menu' | 'inventory' | 'stance' | 'minimap';

export interface PadState {
  /** Screen-space stick directions (x right, y down), already dead-zoned; zero when idle. */
  move: { x: number; y: number };
  aim: { x: number; y: number } | null;
  buttons: number;
  /** Menu-type buttons pressed since the last poll, edge-triggered. */
  pressed: PadAction[];
}

function stick(x: number, y: number): { x: number; y: number } | null {
  const m = Math.hypot(x, y);
  if (m < DEADZONE) return null;
  // Rescale past the dead zone so small tilts still give fine control.
  const k = Math.min(1, (m - DEADZONE) / (1 - DEADZONE)) / m;
  return { x: x * k, y: y * k };
}

export class GamepadInput {
  private held = new Set<number>();
  /** performance.now() of the last stick or button activity, so the pad only takes over while used. */
  lastActive = -Infinity;

  poll(now: number): PadState | null {
    const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
    const pad = [...pads].find((p) => p !== null && p.connected && p.mapping === 'standard');
    if (!pad) return null;
    const pressedNow = (i: number): boolean => pad.buttons[i]?.pressed === true;
    const move = stick(pad.axes[0] ?? 0, pad.axes[1] ?? 0);
    const aim = stick(pad.axes[2] ?? 0, pad.axes[3] ?? 0);
    let buttons = pressedNow(RT) || pressedNow(LT) ? BUTTON.primary : 0;
    SKILL_PADS.forEach((b, i) => {
      const bit = SKILL_BUTTONS[i];
      if (bit !== undefined && pressedNow(b)) buttons |= bit;
    });
    const pressed: PadAction[] = [];
    for (const [b, action] of [
      [START, 'menu'],
      [BACK, 'inventory'],
      [RB, 'stance'],
      [LB, 'minimap'],
    ] as const) {
      if (pressedNow(b) && !this.held.has(b)) pressed.push(action);
      if (pressedNow(b)) this.held.add(b);
      else this.held.delete(b);
    }
    if (move || aim || buttons !== 0 || pressed.length > 0) this.lastActive = now;
    return { move: move ?? { x: 0, y: 0 }, aim, buttons, pressed };
  }
}
