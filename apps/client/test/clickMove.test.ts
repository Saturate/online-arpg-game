import { describe, expect, it } from 'vitest';
import { CLASSES, loadMap, SIM, stepPlayer, type MoveState } from '@rune/shared';
import { ClickMover, findPath } from '../src/game/clickMove.js';

describe('click to move', () => {
  const { def, game } = loadMap({ kind: 'arena' });
  const rock = def.obstacles.find((o) => o.kind === 'rock' && o.shape.type === 'circle' && o.shape.r > 30);

  it('paths around an obstacle without stepping through anything solid', () => {
    if (!rock || rock.shape.type !== 'circle') throw new Error('no rock');
    const from = game.findOpen(rock.shape.x - rock.shape.r - 80, rock.shape.y, SIM.playerRadius);
    const to = game.findOpen(rock.shape.x + rock.shape.r + 80, rock.shape.y, SIM.playerRadius);
    const path = findPath(game, from, to);
    expect(path).not.toBeNull();
    for (const p of path ?? []) expect(game.pointBlocked(p.x, p.y, SIM.playerRadius - 2, 'move')).toBe(false);
    const last = path?.[path.length - 1];
    expect(Math.hypot((last?.x ?? 0) - to.x, (last?.y ?? 0) - to.y)).toBeLessThan(1);
  });

  it('walks up to a click on a blocked spot instead of refusing', () => {
    if (!rock || rock.shape.type !== 'circle') throw new Error('no rock');
    const path = findPath(game, { x: rock.shape.x - rock.shape.r - 120, y: rock.shape.y }, { x: rock.shape.x, y: rock.shape.y });
    expect(path).not.toBeNull();
  });

  it('actually arrives when its directions drive the real movement code', () => {
    if (!rock || rock.shape.type !== 'circle') throw new Error('no rock');
    const mover = new ClickMover(game);
    const start = game.findOpen(rock.shape.x - rock.shape.r - 80, rock.shape.y, SIM.playerRadius);
    let s: MoveState = { ...start, dash: null };
    const to = game.findOpen(rock.shape.x + rock.shape.r + 80, rock.shape.y + 10, SIM.playerRadius);
    mover.moveTo(s, to, 0);
    for (let i = 0; i < 200 && mover.moving; i++) s = stepPlayer(game, s, mover.direction(s), CLASSES.warrior.moveSpeed, SIM.dt, SIM.playerRadius);
    expect(Math.hypot(s.x - to.x, s.y - to.y)).toBeLessThan(20);
    expect(mover.moving).toBe(false);
  });
});
