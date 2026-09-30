import type { EntityId, GameEvent } from '@rune/shared';
import { Color } from 'three';
import { COLORS, ELEMENT_COLORS, VIEW } from './config.js';
import type { EntityRenderer } from './entities.js';
import type { Effects } from './fx.js';

const tmp = new Color();

export interface FxEventContext {
  fx: Effects;
  entities: EntityRenderer;
  /** The local player, whose own damage shows red and shakes the camera. */
  selfId: EntityId | null;
  damageNumbers: boolean;
  /** Name the broken rule on a dud, for the Spell Studio. */
  dudReasons?: boolean;
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
      fx.hit(ev.id, ev.x, ev.y, ev.el, ev.amt);
      break;
    }
    case 'heal':
      fx.text(ev.x, ev.y, `+${ev.amt}`, COLORS.heal);
      fx.vfx.heal(ev.x, ev.y);
      break;
    case 'levelUp':
      fx.shockwave(ev.x, ev.y, 160, 'restore', 0.8);
      fx.burst(ev.x, ev.y, 0xffd76a, 40, 220, { up: 260, size: 5, life: 1 });
      break;
    case 'raise':
      entities.removeCorpseNear(ev.x, ev.y);
      break;
    case 'death':
      fx.clearTelegraphs(ev.id);
      if (ev.k === 'enemy') entities.markDying(ev.id);
      fx.death(ev.id, ev.x, ev.y, ev.color, ev.big);
      if (ev.big) ctx.shake(5);
      break;
    case 'fizzle':
      fx.vfx.fizzle(ev.x, ev.y, ev.why === 'misfire');
      fx.text(ev.x, ev.y - 20, ev.why === 'misfire' ? 'misfire' : ctx.dudReasons ? `dud: ${ev.reason ?? '?'}` : 'fizzle', ev.why === 'misfire' ? 0xff5030 : 0xaaaaaa);
      break;
    case 'explode':
      fx.vfx.explosion(ev.x, ev.y, ev.r);
      ctx.shake(4);
      break;
    case 'pickup':
      fx.vfx.glints(ev.x, ev.y, tmp.setHex(COLORS.selfRing), 16);
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
      // A monster's cast gets a neutral puff: the element flash and its light are the player's
      // spell look, and a shaman's fire cast read as an ally's fireball.
      if (entities.kindOf(`s${ev.id}`) === 'enemy') fx.vfx.enemyCast(ev.x, ev.y);
      else fx.vfx.cast(ev.el ?? 'plain', ev.x, ev.y);
      break;
    case 'waypoint':
      break;
  }
}
