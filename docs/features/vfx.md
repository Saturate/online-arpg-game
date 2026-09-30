# Spell effects (VFX)

Status: Built 2026-09-30, not pushed. Replaces the flat spell shapes with shaders, particles, trails and spell light. Low quality keeps the flat shapes.

## What it does

Spells and ground effects look like a dark, gritty ARPG: embers, smoke and grime rather than neon, and every area keeps a crisp edge ring so its size reads at a glance.

- **Bolts:** a hot core (white centre, element colour falloff), a faint halo, a ribbon trail and the element's trail particles. Fire sheds embers and smoke, cold sheds frost mist and a few ice glints, lightning throws short stretched sparks, restore, ward and mixed shed motes, plain bolts leave dust.
- **Orbs:** a solid, shaded ball that rolls with the ground it covers. Fire is a black crust split by molten cracks, cold is clouded ice with pale facets, lightning is a dark storm core with arcs racing over it, and the rest are dark swirls. Each has a halo, a wide smoky ribbon and a heavier trail.
- **Novas:** a shockwave ring with a bright, broken leading edge and a dark band behind it (it stands in for refraction), throwing debris off the front: embers, ice shards, sparks, motes, or dust and stones for impact and plain novas.
- **Zones:** a ground shader per style, always with the same crisp edge ring.
  - Fire: scrolling noise flames, glowing embers blinking out in the ash, faint heat shimmer, scorched ground with a charred band inside the edge, rising embers, flame tongues and smoke.
  - Cold: frost veins creeping in from the rim over darkened rime, crystal spikes around the edge with glints, low mist.
  - Lightning: jagged arcs that jump every few frames over scorched ground, sparks.
  - Restore, ward and mixed: a slow runic circle (two thin rings, a band of glyph strokes, a soft inner light) and rising motes.
  - Plain: stirred dust.
- **Auras:** a faint runic circle the size of the aura around the caster, turning slowly, and motes of the aura's type (embers, shards, sparks or motes).
- **Bond tethers:** a cord with pulses running from the caster to the bonded ally, and motes along it.
- **Dash:** a pale ribbon at the hero's height, dust at the feet and a few motes.
- **Hits:** fire sprays embers and a smoke puff, cold chips shards and a breath of mist, lightning throws sparks with a flash, other elements shed motes, and physical hits spray dark blood and dust.
- **Deaths** show the element of the last hit on the monster: ash, embers and a scorch mark for fire, a shatter of falling ice for cold, sparks and a scorch for lightning, gore chunks in the monster's colour and dust otherwise. Each also has a small shockwave.
- **Explosions** (volatile monsters, minions, dungeon traps): a flash, a fireball of embers and sparks, rising smoke, a shockwave and a scorch mark.
- **Statuses on monsters** (from the `st` bits every entity snapshot already carries: burn, chill, shock): burning bodies carry flickering flame tongues, embers and smoke and give off light; chilled bodies have frost mist at their feet and falling glints; shocked bodies throw sparks with the odd flash. The old emissive tint stays, much weaker on Medium and High, so a burning pack no longer turns into orange silhouettes.
- **Enemy bullets and telegraphs** are unchanged: the solid magenta bullet with a white outline and its puff trail, and the flat wind-up outline and fill, so they can never be mistaken for a player's spell.
- **Light:** spells light the world through the shared light budget (`render/lights.ts`): bolts and orbs carry a light, burning ground is a campfire, a storm zone flickers, runic zones glow softly, hits, casts, deaths and explosions flash. Enemy bullets have none.

## Why

- **Readability first.** Every zone, nova and aura keeps a crisp edge ring in its body colour, the colours stay close to the old flat ones, and enemy bullets and telegraphs keep their own look.
- **Embers, not neon.** The world is drawn with ACES tone mapping at an exposure of about 1.5 and a canvas grade; a body colour at full strength clips to yellow white by day. Effect shaders run the same tone mapping and output colour space as the lit world, and their glow is scaled to roughly half, rising at night. Palettes (`vfx/palette.ts`) have a core, a body, a deep tone for falloff and charred edges, and a smoke colour.
- **Day and night.** A shared `uNight` uniform (the night factor outdoors, always 1 underground) lifts glow at night, where effects are the light, and eases scorch and rime darkening; spell light keeps a third of its strength by day (`SPELL_DAY_LIGHT`).
- **Stacked zones share one glow.** A caster recasting a zone in place stacks about ten copies on one spot; ten additive glows burned to white. `Vfx.zoneShare` gives copies of one style on nearly the same spot one zone's worth of glow between them, oldest first, so a fading copy hands over smoothly, and fully covered copies do not draw.
- **Premultiplied alpha** in the ground and nova shaders: one pass both darkens the ground (scorch, rime, dust) and adds light (flames, arcs).
- **No real refraction or soft particles.** Both need a copy of the scene or its depth as a texture, an extra full-screen pass. The nova's dark band stands in for refraction and sprites fade near the ground instead of depth fading.
- **Ground effects draw above roads.** Roads and plazas are transparent meshes at render order 0; three sorts transparent meshes by render order before distance, so ground effects use `RENDER_ORDER` in `render/config.ts` (marks 1, effects 2, light pools 3, ribbons 4, smoke 5, glow 6) instead of a larger height, which would float on slopes. This also fixes zones vanishing under roads and aura rings under rivers.

## How

Code is in `apps/client/src/render/vfx/`:

- `quality.ts`: `VfxQuality` (`low`, `medium`, `high`) and `QUALITY`, the numbers per level.
- `pool.ts`: `ParticlePool`, pure (no three.js): particles in one flat `Float32Array`, packed at the front (a dead particle is replaced by the last live one), stepped with velocity, gravity, drag and ground settling, written to the GPU layout with size and colour blended over life. A full pool drops new spawns rather than stealing live ones.
- `budget.ts`: `ParticleBudget`, pure: how many of the particles an emitter asks for spawn this frame (see Budget).
- `particleLayer.ts`: one instanced draw per blend mode. Pooled particles go first, then one-frame sprites (bolt cores, halos, flashes) in the same buffer. Shapes are drawn in the fragment shader: glow, smoke, spark (stretched along screen velocity), shard, flame, mote, core, chunk, ring and disc. A `FLAT` variant lies on the ground for scorch marks.
- `ribbons.ts`: `RibbonBatch`, every trail ribbon in one geometry and one draw; camera-facing strips built from a short point history, thinning and fading to the tail, with a noise-broken or jittering filament shader by style.
- `materials.ts`: shader materials for zones, novas, orbs, auras, tethers, and the Low one-quad area. Each returns `{ material, u }` with typed uniforms; copies of one kind and style share a compiled program.
- `palette.ts`: styles (`styleOf(el, fx)`) and their colours.
- `vfx.ts`: `Vfx`, the system: the layers, ribbons, shockwave pool, flash lights, budget and quality, and the emitters.
- `spellViews.ts`: the drawn view of every projectile, nova and zone, by quality.

Wiring:

- `Effects` (`render/fx.ts`) owns a `Vfx`, follows the `vfxQuality` setting and keeps telegraphs, hazards and the DOM text. `EntityRenderer` takes the `Vfx` as its third argument and builds spell views, auras, tethers, dash trails and status particles through it.
- A frame: `EntityRenderer.render` calls `vfx.begin(dt)` (clock, night factor, budget, pool steps), views and events emit, `Effects.update` calls `vfx.commit()` (buffer uploads, ribbons). Spell light is read by the light budget in `WorldScene.follow`.
- `render/fxEvents.ts`: `playFxEvent` draws every game event the same way in the game, the Spell Studio and the VFX bench.
- The setting is Esc, Settings, Spell effects, stored with the other client options (`ui/settings.ts`, default High). Changing it rebuilds the pools and every spell view on the next frame.

The API emitters and views use:

```ts
vfx.trail(style, x, y, height, radius, dt, orb)   // per frame, per projectile
vfx.impact(style | null, x, y, strong)            // one hit
vfx.death(style | null, x, y, bodyColor, big)
vfx.explosion(x, y, r); vfx.cast(style, x, y); vfx.heal(x, y); vfx.fizzle(x, y, misfire)
vfx.zone(style, x, y, r, dt, fade); vfx.novaFront(style, x, y, r, dt, life)
vfx.aura(style, x, y, r, dt); vfx.tether(ax, ay, bx, by, h, dt); vfx.dash(x, y, dt)
vfx.status(id, x, y, r, height, burn, chill, shock, dt)
vfx.shockwave(x, y, radius, style, duration)      // pooled ring mesh
vfx.glowSprite(...); vfx.solidSprite(...)         // one frame, no draw call of its own
vfx.light(key, x, y, h, color, intensity, radius) // this frame, via the light budget
vfx.flash(x, y, h, color, intensity, radius, seconds)
vfx.ribbons.acquire(r, g, b, width, lifetime, style) / push(h, x, y, z, now) / release(h)
```

### Quality levels

| | Low | Medium | High |
|---|---|---|---|
| Spell shapes | the old flat shapes (a zone or nova is one quad, a bolt two sprites) | shaders | shaders |
| Glow / smoke particles alive | 400 / 120 | 1600 / 500 | 3200 / 1000 |
| Spawn scale | 0.35 | 0.6 | 1 |
| Most spawned per frame | 40 | 120 | 240 |
| Ribbons, status particles, spell light, scorch marks | no | yes | yes |

### Budget

Every emitter asks for a number (rates are per second at High, times `dt`), and `ParticleBudget.take(n, important)` decides:

- Everything is scaled by the level's spawn scale; fractions round up or down at random, so a trickle of 0.3 a frame still spawns about one particle every three frames.
- Ambient requests (trails, burning ground, statuses, motes) fade out as the pools pass half full, so hits, deaths and explosions (important requests) always find room.
- When the smoothed frame time goes over 21 ms (about 48 fps, so a 60 Hz display never throttles), ambient spawning backs off to as little as 30% and recovers slowly; a single hitch is ignored.
- A per-frame cap stops a burst of deaths from filling the pool in one frame.
- Emitters skip positions far from the camera.

### Adding an effect

1. Pick or add a style in `palette.ts` if it needs new colours.
2. For something tied to a spell entity, add a view class in `spellViews.ts` (a shader material from `materials.ts` if it has an area, sprites and emitters otherwise) and route it in `makeSpellView`. Keep an edge ring on anything with an area, and keep enemy looks out of player styles.
3. For a one-off (an event), add an emitter on `Vfx` built from `spray`, `puff`, `scorch`, `shockwave` and `flash`, and call it from `playFxEvent`.
4. Ask the budget for every particle (`take`), mark hits and deaths important, and emit per-frame things with `dt` so the rate does not follow the refresh rate. Allocate nothing per frame: fill the shared spec, reuse arrays.
5. Check it in the VFX bench at Low and High, day and night.

### Measured

The dev tools VFX tab (`/admin/dev/#vfx/crowd/high`): 8 god-mode casters (3 Frozen Orb, 3 Fireball, Frost Mire, a fire zone) holding their skills into 120 pinned monsters on the wilds map. The fight is recorded once and looped through the game's renderer, so the simulation costs nothing per frame. The numbers are 600-frame averages in headless Chrome on the development Mac at 60 Hz, by day. Before is the same bench on the code without this work. Render CPU varies a few ms from run to run because the machine was shared; the table gives typical runs.

| Crowd, 84 live spells | Before | Low | Medium | High |
|---|---|---|---|---|
| Draw calls (monsters and world alone: about 700) | 1230 | 1007 | 947 | 945 |
| EntityRenderer CPU per frame | 1.3 ms | 1.4 to 1.6 ms | 1.45 ms | 1.5 ms |
| Effects CPU per frame | 0.10 ms | 0.06 ms | 0.09 ms | 0.10 ms |
| Render CPU per frame | 8.7 to 9.4 ms | 7.7 to 8.6 ms | 7.2 ms | 7.1 ms |
| JS heap growth per frame | 1.85 MB | 1.40 MB | 1.26 MB | 1.26 MB |
| Live particles | up to 900 boxes | 350 | 1060 | 1970 |

Spell views emit their particles inside `EntityRenderer.render`, which is why it gains about 0.2 ms: that work used to be in the game's draw loop, outside the measurement. GPU time was not measured (headless Chrome has no timer query here); the fragment cost is the zone and nova shaders (three octaves of value noise over each area) and additive sprite overdraw in a crowd.

## Limits and open questions

- Zones and novas show only their first element: that is all the snapshot carries, so Frostfire looks like fire.
- The bond tether is always the ward colour: the snapshot lists linked ids without the bond's effect.
- Monster hazards (poison, fire and frost puddles) keep their flat look; they are enemy ground effects and could get a light polish of their own that stays distinct from player zones.
- Hit flashes: zones tick often, and the full flash left monsters in a zone white; on Medium and High the flash is softer. Whether hits need a different cue is open.
- Stacked zones share glow by style and position only; two casters' zones of one style on one spot also share.
- Real point lights go to the brightest sources near the camera through the shared budget (8 lights); everything else gets a ground pool from it.
