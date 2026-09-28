import { HEAT } from '../config/sim.js';
import { emptyStatus } from './ecs.js';
import type { Simulation } from './simulation.js';

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
        sim.portalRequests.push({ playerId: id, target: portal.target });
        p.portalCooldown = PORTAL_RETRY_SECONDS;
        break;
      }
    }
    if (p.primaryCooldown > 0) p.primaryCooldown = Math.max(0, p.primaryCooldown - dt);
    if (p.castCooldown > 0) p.castCooldown = Math.max(0, p.castCooldown - dt);
    if (p.heatPause > 0) p.heatPause = Math.max(0, p.heatPause - dt);
    else if (p.heat > 0) p.heat = Math.max(0, p.heat - HEAT.coolPerSecond * p.stats.heatCooling * dt);
    if (p.respawnIn === null && p.stats.lifeRegen > 0 && h.life < h.maxLife) h.life = Math.min(h.maxLife, h.life + p.stats.lifeRegen * dt);

    if (p.respawnIn === null) continue;
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
