import { HEAT } from '../config/sim.js';
import { emptyStatus } from './ecs.js';
import type { Simulation } from './simulation.js';

const COOLDOWN_EPS = 1e-6;

/** Seconds a request stays pending before the portal can fire again, in case the server ignores it. */
const PORTAL_RETRY_SECONDS = 3;

/** Cooldowns, heat cooling, respawning and portal use. */
export function updatePlayers(sim: Simulation, dt: number): void {
  const w = sim.world;
  for (const [id, p, h] of w.query(w.player, w.health)) {
    if (p.portalCooldown > 0) p.portalCooldown -= dt;
    const pos = w.position.get(id);
    if (pos && p.respawnIn === null && p.portalCooldown <= 0) {
      for (const portal of sim.mapDef.portals) {
        if ((pos.x - portal.x) ** 2 + (pos.y - portal.y) ** 2 > portal.r * portal.r) continue;
        // Touching a waypoint activates it for this character before the menu opens.
        if (portal.target === 'waypoint' && portal.zone && !p.waypoints.includes(portal.zone)) {
          p.waypoints.push(portal.zone);
          sim.emit({ e: 'waypoint', id, zone: portal.zone }, pos.x, pos.y);
        }
        sim.portalRequests.push({ playerId: id, target: portal.target, portal });
        p.portalCooldown = PORTAL_RETRY_SECONDS;
        break;
      }
    }
    if (p.primaryCooldown > 0) p.primaryCooldown = Math.max(0, p.primaryCooldown - dt);
    // Snapped to zero within a float's slack: 0.35 minus seven 0.05 s ticks leaves about 1e-17, which
    // used to cost a whole extra tick before the next cast.
    if (p.castCooldown > 0) p.castCooldown = p.castCooldown - dt > COOLDOWN_EPS ? p.castCooldown - dt : 0;
    if (p.heatPause > 0) {
      p.heatPause = Math.max(0, p.heatPause - dt);
      p.heatIdle = 0;
    } else if (p.heat > 0) {
      p.heatIdle += dt;
      const ramp = Math.min(sim.rates.forceRampMax, 1 + HEAT.coolRampPerSecond * p.heatIdle);
      p.heat = Math.max(0, p.heat - HEAT.coolPerSecond * sim.rates.forceCool * ramp * p.stats.heatCooling * dt);
    } else p.heatIdle = 0;
    if (p.respawnIn === null && p.stats.lifeRegen > 0 && h.life < h.maxLife) h.life = Math.min(h.maxLife, h.life + p.stats.lifeRegen * dt);

    // One life per Arena run: the fallen stay down and watch until the run ends.
    if (p.respawnIn === null || sim.arena) continue;
    p.respawnIn -= dt;
    if (p.respawnIn > 0) continue;
    p.respawnIn = null;
    p.heat = 0;
    p.dash = null;
    p.dashSpell = null;
    h.life = h.maxLife;
    w.status.set(id, emptyStatus());
    w.position.set(id, sim.playerSpawnPoint());
  }
}

/** Swings follow their owner and expire; the hit already resolved when the swing was created. */
export function updateSwings(sim: Simulation, dt: number): void {
  const w = sim.world;
  for (const [id, s, pos] of w.query(w.swing, w.position)) {
    s.lifetime -= dt;
    const owner = w.position.get(s.ownerId);
    if (owner) {
      pos.x = owner.x;
      pos.y = owner.y;
    }
    if (s.lifetime <= 0) w.destroy(id);
  }
}
