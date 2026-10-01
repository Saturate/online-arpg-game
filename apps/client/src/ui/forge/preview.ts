import { AURA, SIM, SKILL_BUTTONS, Simulation, spellFx, type ClassId, type ElementId, type EntityId, type SigilCompile, type SpellInst } from '@rune/shared';
import { cssColor, COLORS, ELEMENT_COLORS, fxColor } from '../../render/config.js';
import { useCastTiming } from '../../game/castTiming.js';

/** Where the dummy stands from the caster: inside every shape's reach, far enough to see a bolt fly. */
const DUMMY_DISTANCE = 260;
/** World units across the canvas: the bolt's full range plus a margin on both sides. */
const VIEW_WIDTH = 820;
const DUMMY_LIFE = 1e9;
/** Seconds between casts: slower than any cast delay, so each cast reads on its own. */
export const CAST_EVERY = 1.4;
/** Damage per second is averaged over this many seconds. */
const DPS_WINDOW = 4;

function colorOf(elements: readonly ElementId[]): string {
  const el = elements[0];
  return cssColor(el ? ELEMENT_COLORS[el] : COLORS.playerProjectile);
}

/** Heals and wards read green and teal, as in the game; the rest by element. */
function spellColor(spell: SpellInst): string {
  return cssColor(fxColor(spellFx(spell.node), spell.node.elements[0] ?? null));
}

/**
 * A training dummy for the forge: a local copy of the shared simulation with one god-mode caster
 * and one pinned dummy that never dies, drawn top-down on a 2D canvas. It runs the same engine as
 * the server, so what it shows is what the spell does.
 */
export class ForgePreview {
  private readonly sim: Simulation;
  private readonly playerId: EntityId;
  private readonly dummy: { id: EntityId; x: number; y: number };
  private readonly home: { x: number; y: number };
  private compiled: SigilCompile | null = null;
  private seq = 0;
  private sinceCast = Infinity;
  private flash = 0;
  private hits: { t: number; amt: number }[] = [];
  private time = 0;

  constructor(classId: ClassId) {
    this.sim = new Simulation(7, { kind: 'flat' });
    this.playerId = this.sim.addPlayer('forge-preview', classId, 'Preview');
    const p = this.sim.world.player.get(this.playerId);
    const pos = this.sim.world.position.get(this.playerId);
    if (!p || !pos) throw new Error('preview player missing');
    p.god = true;
    p.warband = p.warband.map(() => null);
    p.sigils = [null, null, null, null];
    this.home = { x: pos.x, y: pos.y };
    const id = this.sim.spawnEnemy('chaser', pos.x + DUMMY_DISTANCE, pos.y);
    const h = this.sim.world.health.get(id);
    if (h) {
      h.maxLife = DUMMY_LIFE;
      h.life = DUMMY_LIFE;
    }
    const at = this.sim.world.position.get(id);
    this.dummy = { id, x: at?.x ?? pos.x + DUMMY_DISTANCE, y: at?.y ?? pos.y };
  }

  /** Swaps the spell; the next cast comes right away so a change shows at once. */
  setSpell(compiled: SigilCompile | null, castDelayShare: number): void {
    this.compiled = compiled;
    const p = this.sim.world.player.get(this.playerId);
    if (!p) return;
    this.sim.setRates({ ...this.sim.rates, castCooldown: useCastTiming.getState().globalSeconds });
    p.sigils[0] = compiled ? { uid: -1, compiled, misfireMultiplier: 1, castDelayShare } : null;
    this.sinceCast = Infinity;
    this.hits = [];
  }

  get dps(): number {
    const since = this.time - DPS_WINDOW;
    let sum = 0;
    for (const h of this.hits) if (h.t >= since) sum += h.amt;
    return sum / Math.min(DPS_WINDOW, Math.max(1, this.time));
  }

  step(): void {
    const sim = this.sim;
    const p = sim.world.player.get(this.playerId);
    if (!p) return;
    p.heat = 0;
    this.time += SIM.dt;
    this.sinceCast += SIM.dt;
    const ok = this.compiled?.ok === true;
    let buttons = 0;
    if (ok && this.sinceCast >= CAST_EVERY) {
      buttons = SKILL_BUTTONS[0];
      this.sinceCast = 0;
    }
    const aim = Math.atan2(this.dummy.y - this.home.y, this.dummy.x - this.home.x);
    this.seq++;
    sim.applyInput(this.playerId, { seq: this.seq, moveDir: { x: 0, y: 0 }, aimAngle: aim, buttons });
    // The flat map runs arena waves; the dummy alone should be on the field.
    sim.waveTimer = Infinity;
    sim.step();
    this.pin();
    for (const { ev } of sim.takeEvents()) {
      if (ev.e === 'dmg' && ev.id === this.dummy.id) {
        this.flash = 0.15;
        this.hits.push({ t: this.time, amt: ev.amt });
      }
    }
    this.flash = Math.max(0, this.flash - SIM.dt);
    if (this.hits.length > 400) this.hits = this.hits.filter((h) => h.t >= this.time - DPS_WINDOW);
  }

  private pin(): void {
    const w = this.sim.world;
    const pos = w.position.get(this.dummy.id);
    if (pos) {
      pos.x = this.dummy.x;
      pos.y = this.dummy.y;
    }
    const h = w.health.get(this.dummy.id);
    if (h) h.life = h.maxLife;
    const e = w.enemy.get(this.dummy.id);
    if (e) {
      e.knockX = 0;
      e.knockY = 0;
    }
    const p = w.player.get(this.playerId);
    const me = w.position.get(this.playerId);
    if (p && me && p.dash === null && p.dashSpell === null) {
      me.x = this.home.x;
      me.y = this.home.y;
    }
  }

  draw(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    const w = this.sim.world;
    const scale = width / VIEW_WIDTH;
    const cx = this.home.x + DUMMY_DISTANCE / 2;
    const cy = this.home.y;
    const sx = (x: number) => (x - cx) * scale + width / 2;
    const sy = (y: number) => (y - cy) * scale + height / 2;

    ctx.fillStyle = '#0d0b09';
    ctx.fillRect(0, 0, width, height);
    // Flagstones, so movement reads against something.
    ctx.strokeStyle = 'rgba(120, 100, 70, 0.08)';
    ctx.lineWidth = 1;
    const step = 60 * scale;
    for (let x = ((sx(0) % step) + step) % step; x < width; x += step) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    for (let y = ((sy(0) % step) + step) % step; y < height; y += step) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    const circle = (x: number, y: number, r: number) => {
      ctx.beginPath();
      ctx.arc(sx(x), sy(y), Math.max(1, r * scale), 0, Math.PI * 2);
    };

    for (const [id, z] of w.zone) {
      const pos = w.position.get(id);
      if (!pos) continue;
      circle(pos.x, pos.y, w.radius.get(id) ?? 0);
      ctx.fillStyle = `${spellColor(z.spell)}26`;
      ctx.fill();
      ctx.strokeStyle = `${spellColor(z.spell)}66`;
      ctx.stroke();
    }

    const root = this.compiled?.ok ? this.compiled.tree.roots[0] : undefined;
    const me = w.position.get(this.playerId);
    if (me && root?.shape === 'aura') {
      circle(me.x, me.y, AURA.radius);
      ctx.strokeStyle = 'rgba(217, 181, 106, 0.35)';
      ctx.setLineDash([4, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    const d = w.position.get(this.dummy.id);
    if (d) {
      circle(d.x, d.y, w.radius.get(this.dummy.id) ?? 18);
      ctx.fillStyle = this.flash > 0 ? '#c9553a' : '#5a3a28';
      ctx.fill();
      ctx.strokeStyle = '#1a0f08';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.lineWidth = 1;
    }
    if (me) {
      circle(me.x, me.y, w.radius.get(this.playerId) ?? 16);
      ctx.fillStyle = '#2b2418';
      ctx.fill();
      ctx.strokeStyle = cssColor(COLORS.selfRing);
      ctx.stroke();
    }

    for (const [id, n] of w.nova) {
      const pos = w.position.get(id);
      if (!pos) continue;
      circle(pos.x, pos.y, w.radius.get(id) ?? 0);
      ctx.strokeStyle = spellColor(n.spell);
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.lineWidth = 1;
    }
    for (const [id, pr] of w.projectile) {
      if (pr.ownerId !== this.playerId) continue;
      const pos = w.position.get(id);
      if (!pos) continue;
      circle(pos.x, pos.y, Math.max(4, w.radius.get(id) ?? 6));
      ctx.fillStyle = pr.spell ? spellColor(pr.spell) : colorOf(pr.elements);
      ctx.shadowColor = ctx.fillStyle;
      ctx.shadowBlur = 8;
      ctx.fill();
      ctx.shadowBlur = 0;
    }
  }
}
