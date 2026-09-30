import type { EntityId, GameEvent } from '@rune/shared';
import { COLORS, ELEMENT_COLORS, FX, VIEW } from './config.js';
import type { EntityRenderer } from './entities.js';
import type { Effects } from './fx.js';

export interface FxEventContext {
  fx: Effects;
  entities: EntityRenderer;
  /** The local player, whose own damage shows red and shakes the camera. */
  selfId: EntityId | null;
  damageNumbers: boolean;
  shake: (amount: number) => void;
}

/**
 * The visual side of a game event, shared by the game, the Spell Studio and the VFX bench so all
 * three draw a fight the same way. Anything that is not a picture (banners, notices) stays with the
 * caller.
 */
export function playFxEvent(ev: GameEvent, ctx: FxEventContext): void {
  const { fx, entities } = ctx;
  switch (ev.e) {
    case 'dmg': {
      entities.flash(`s${ev.id}`);
      if (ev.amt < 1) break;
      const own = ev.id === ctx.selfId;
      if (own) ctx.shake(VIEW.shakeOnHit);
      if (ctx.damageNumbers) fx.text(ev.x, ev.y, String(ev.amt), own ? 0xff4040 : ev.el ? ELEMENT_COLORS[ev.el] : 0xffffff, ev.amt >= 30);
      fx.burst(ev.x, ev.y, ev.el ? ELEMENT_COLORS[ev.el] : 0xffe0c0, 4, 90, { up: 120, size: 3, life: 0.3 });
      break;
    }
    case 'heal':
      fx.text(ev.x, ev.y, `+${ev.amt}`, COLORS.heal);
      fx.burst(ev.x, ev.y, COLORS.heal, 6, 40, { up: 90, size: 3, gravity: -60 });
      break;
    case 'levelUp':
      fx.shockwave(ev.x, ev.y, 160, 0xffd76a, 0.8);
      fx.burst(ev.x, ev.y, 0xffd76a, 40, 220, { up: 260, size: 5, life: 1 });
      break;
    case 'raise':
      entities.removeCorpseNear(ev.x, ev.y);
      break;
    case 'death':
      fx.clearTelegraphs(ev.id);
      if (ev.k === 'enemy') entities.markDying(ev.id);
      fx.burst(ev.x, ev.y, ev.color, ev.big ? FX.deathParticles * 2 : FX.deathParticles, ev.big ? 260 : 180, { size: ev.big ? 8 : 6 });
      fx.shockwave(ev.x, ev.y, ev.big ? 140 : 70, ev.big ? COLORS.rareOutline : ev.color);
      if (ev.big) ctx.shake(5);
      break;
    case 'fizzle':
      fx.burst(ev.x, ev.y, ev.why === 'misfire' ? 0xff5030 : 0x999999, 14, 80, { up: 60, size: 6, gravity: -30, life: 0.7 });
      fx.text(ev.x, ev.y - 20, ev.why === 'misfire' ? 'misfire' : 'fizzle', ev.why === 'misfire' ? 0xff5030 : 0xaaaaaa);
      break;
    case 'explode':
      fx.shockwave(ev.x, ev.y, ev.r, 0xff8a3a, 0.4);
      fx.burst(ev.x, ev.y, 0xff8a3a, 30, 260);
      ctx.shake(4);
      break;
    case 'pickup':
      fx.burst(ev.x, ev.y, COLORS.selfRing, 16, 60, { up: 200, size: 4, gravity: 200 });
      break;
    case 'attack':
      entities.attack(`s${ev.id}`);
      break;
    case 'tele':
      fx.telegraph(ev);
      entities.windup(`s${ev.id}`, ev.t);
      break;
    case 'hazard':
      fx.hazard(ev);
      break;
    case 'cast':
      entities.attack(`s${ev.id}`);
      fx.burst(ev.x, ev.y, ev.el ? ELEMENT_COLORS[ev.el] : 0xd0d8ff, 8, 70, { up: 140, size: 3, life: 0.35 });
      break;
    case 'waypoint':
      break;
  }
}
