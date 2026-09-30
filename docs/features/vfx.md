# Spell effects (VFX)

Status: Built 2026-09-30, not pushed. Replaces the flat spell shapes with shaders, particles, trails and spell light. Low quality keeps the flat shapes. World fires (torches, lamps, candles, camp fires, the forge) built 2026-09-30 on the same pools, not pushed.

## What it does

Spells and ground effects look like a dark, gritty ARPG: embers, smoke and grime rather than neon, and every area keeps a crisp edge ring so its size reads at a glance.

- **Bolts:** a hot core (white centre, element colour falloff), a faint halo, a ribbon trail and the element's trail particles. Fire sheds embers and smoke, cold sheds frost mist and a few ice glints, lightning throws short stretched sparks, restore, ward and mixed shed motes, plain bolts leave dust.
- **Orbs:** a solid, shaded ball that rolls with the ground it covers. Fire is a black crust split by molten cracks, cold is clouded ice with pale facets, lightning is a dark storm core with arcs racing over it, and the rest are dark swirls. Each has a halo, a wide smoky ribbon and a heavier trail.
- **Novas:** a shockwave ring with a bright, broken leading edge and a dark band behind it (it stands in for refraction), throwing debris off the front: embers, ice shards, sparks, motes, or dust and stones for impact and plain novas.
- **Zones:** a ground shader per style, always with the same crisp edge ring.
  - Fire: scrolling noise flames, glowing embers blinking out in the ash, faint heat shimmer, scorched ground with a charred band inside the edge, rising embers, flame tongues and smoke.
  - Cold: feathery rime (veins broken into short barbs, at half the brightness of the first version) creeping in from the rim over darkened rime, crystal spikes around the edge in the body colour 0x5ab4e0, low mist. Its night glow lifts to only 0.7 of the other styles', so a frost patch does not go neon.
  - Lightning: jagged arcs that jump every few frames over scorched ground, sparks. Fewer arcs by day.
  - Restore, ward and mixed: a slow runic circle (two thin rings, a band of glyph strokes, a soft inner light) and rising motes. The rim dims to 0.8 at night.
  - Plain: stirred dust.
- **Auras:** a faint runic circle the size of the aura around the caster, turning slowly, and motes of the aura's type (embers, shards, sparks or motes).
- **Bond tethers:** a cord with pulses running from the caster to the bonded ally, and motes along it.
- **Dash:** a pale ribbon at the hero's height, dust at the feet and a few motes.
- **Hits:** fire sprays embers and a smoke puff, cold chips shards and a breath of mist, lightning throws sparks with a flash, other elements shed motes, and physical hits spray dark blood and dust.
- **Deaths** show the element of the last hit on the monster: ash, embers and a scorch mark for fire, a shatter of falling ice for cold, sparks and a scorch for lightning, gore chunks in the monster's colour and dust otherwise. Each also has a small shockwave.
- **Explosions** (volatile monsters, minions, dungeon traps): a flash, a fireball of embers and sparks, rising smoke, a shockwave and a scorch mark.
- **Statuses on monsters** (from the `st` bits every entity snapshot already carries: burn, chill, shock, poison; poisoned bodies drip bile green drops and trail a low murky mist, [monsters.md](monsters.md), "Poison"): burning bodies carry flickering flame tongues, embers and smoke and give off light; chilled bodies have frost mist at their feet and a few pale falling glints (0xbfd8e8); shocked bodies throw sparks with the odd flash. The old emissive tint stays, much weaker on Medium and High, and at 0.4 on Low, where it is the only cue. The shock tint's flicker holds each random value for 0.1 s.
- **Hit flash:** the model brightens in its own colours for 0.08 s, at most once every 0.3 s per entity (zones tick every few frames). Textured (KayKit) models get their texture as the emissive map the first time their materials are copied, so a white emissive lights the texture instead of turning the model white; rigs brighten their main colour. Strength 0.25 on Medium and High, 0.35 on Low.
- **Enemy bullets** are unchanged: the solid magenta bullet with a white outline and its puff trail.
- **Enemy telegraphs and hazards** share one hostile look (`hostileMaterial` in `materials.ts`), one draw each: a blood-red ring (0xb81c14 at 0.9) broken into 24 segments inside a dark border (0x1a0806 at 0.8), with the element only as a thin inner tick, and a red fill that grows to the edge over the wind-up. Line telegraphs have dashed edges and fill along their length. Player areas have solid rings in their element colour, so the two never read alike. Enemy casts get a small grey puff, not the player's element flash and light.
- **Light:** spells light the world through the shared light budget (`render/lights.ts`): bolts and orbs carry a light, burning ground is a campfire, a storm zone crackles, runic zones glow softly, hits, casts, deaths and explosions flash. A zone's light reaches 1.2x its radius and no further. Random flicker (bolts, orbs, fire and storm zones) holds each value 0.1 s within 15% (`vfx/jitter.ts`); a fresh random every frame strobed. Enemy bullets and casts have none.

## Why

- **Readability first.** Every zone, nova and aura keeps a crisp edge ring in its body colour, the colours stay close to the old flat ones, and enemy bullets and telegraphs keep their own look.
- **Embers, not neon.** The world is drawn with ACES tone mapping at an exposure of about 1.5 and a canvas grade; a body colour at full strength clips to yellow white by day. Effect shaders run the same tone mapping and output colour space as the lit world, and their glow is scaled to roughly half, rising at night. Palettes (`vfx/palette.ts`) have a core, a body, a deep tone for falloff and charred edges, and a smoke colour.
- **Day and night.** A shared `uNight` uniform (the night factor outdoors, always 1 underground) lifts glow at night, where effects are the light, and eases scorch and rime darkening; spell light keeps 0.35 of its strength by day (`SPELL_DAY_LIGHT`), lightning 0.2. Whether a map has night comes from its theme (`nightModeOf` in `daylight.ts`): town and wilds follow the clock, dungeon, staging and arena are always night, flat test maps never are. `Effects` reads it from the world scene, so the game, the Spell Studio and the bench agree.
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
- `jitter.ts`: `HeldJitter`, the held random flicker.
- `vfx.ts`: `Vfx`, the system: the layers, ribbons, shockwave pool, flash lights, budget and quality, and the emitters.
- `spellViews.ts`: the drawn view of every projectile, nova and zone, by quality.

Wiring:

- `Effects` (`render/fx.ts`) owns a `Vfx`, follows the `vfxQuality` setting and keeps telegraphs, hazards and the DOM text. `EntityRenderer` takes the `Vfx` as its third argument and builds spell views, auras, tethers, dash trails and status particles through it.
- A frame: `EntityRenderer.render` calls `vfx.begin(dt)` (clock, night factor, budget, pool steps), views and events emit, `Effects.update` calls `vfx.commit()` (buffer uploads, ribbons). Spell light is read by the light budget in `WorldScene.follow`.
- `render/fxEvents.ts`: `playFxEvent` draws every game event the same way in the game, the Spell Studio and the VFX bench.
- The setting is Esc, Settings, Spell effects, stored with the other client options (`ui/settings.ts`, default High). Changing it rebuilds the pools and every spell view on the next frame.
- **Shader warm-up:** when a room is built and after a quality change, `Vfx.warm` adds a throwaway mesh per material and style the level can draw (zone, nova, orb and aura for each of the 7 styles, the tether and the hostile markers; the one-quad area on Low), runs `renderer.compileAsync` and removes them. The warm materials stay alive: three frees a program when its last material is disposed. Before this, the first cast of each (kind, style) stalled a frame on its compile.

The API emitters and views use:

```ts
vfx.trail(style, x, y, height, radius, dt, orb)   // per frame, per projectile
vfx.impact(style | null, x, y, strong)            // one hit
vfx.death(style | null, x, y, bodyColor, big)
vfx.explosion(x, y, r); vfx.cast(style, x, y); vfx.heal(x, y); vfx.fizzle(x, y, misfire)
vfx.zone(style, x, y, r, dt, fade); vfx.novaFront(style, x, y, r, dt, life)
vfx.aura(style, x, y, r, dt); vfx.tether(ax, ay, bx, by, h, dt); vfx.dash(x, y, dt)
vfx.status(id, x, y, r, height, burn, chill, shock, poison, dt)
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

### World fires

Every flame that belongs to the world, not to a spell: dungeon and Arena torches, the Arena building's post torches, candles, standing and post lanterns (the town's lamp posts and the zone gates), shrine candles, the forge fire, the wilds camp fire and the camp fires of generated zone camps ([town.md](town.md#zone-content)), plus the town editor's lit decor: camp fires and braziers anywhere in town, the Halloween candles, skull candle and plaque of candles (the pack models them unlit; the world fires light their wicks) and the thin dungeon candle ([town.md](town.md#the-town-editor-palette)). Code: `vfx/worldFires.ts`; the spots are built in `props.ts` (`FLAMES`, `flamesOf`, `campfire`) and reach the system through `BuiltWorld.fires`, `WorldScene.fires` and `Effects.update`.

- **Flames** are noise-shader quads that stand upright and turn about the vertical to face the camera, so their base stays on the torch and they foreshorten like the world. Each is two layers of the same shape (a teardrop eaten from the top by rising value noise): an outer body and a narrower, hotter inner one. The colour runs from a near-white core through deep orange to dull red tips; the cool upper edge also darkens what is behind it a little (soot), so a flame reads as burning pitch rather than a clean glow. Flames lean with a slow shared wind (toward the camera's right) and waver.
- **Torches** get one flame, a soft glow, a thin dark smoke wisp off the tip and the odd spark. **Candles** and **lanterns** get a small steady flame and a glow and no particles; a lantern's flame and glow are drawn toward the camera (`pull`) so the lantern's own glass does not hide them.
- **Camp fires and the forge** get five tongues around the centre, a bed of coals on the ground (emissive fbm cells breathing on their own beat, over a ring of dark ash), a heat shimmer band above (faint noise bands a touch lighter and darker than what is behind: a stand-in for refraction with no screen copy), a large glow, embers that ride the heat on a slow turbulence and fade, sparks that pop and fall, and dark smoke that rises and spreads. The logs are crossed charred cylinders whose emissive map is a crack pattern; their emissive intensity follows the fire's light flicker.
- **The forge flares** when a sigil is inscribed: the client's own `inscribed` reply with `ok: true` (`game.ts`) calls `fires.flareForge()`. The tongues grow by up to 70%, brighten by up to 45%, a burst of 36 sparks is spawned as important particles, and a light at priority 1 flashes from 3.2 down over 0.9 s. Other players at the forge do not see it: no event reaches them.
- **Dungeon torches:** the light hangs at 100, well above the flame on the bowl rim (40). At 56 it sat 16 units over the iron prongs, which then got about 4.5 times the floor's light and burned white up close; at 100 they get about 1.9 times. The floor under the torch gets the same light as before (intensity is scaled by height).
- **Their lights** are still the static lights in `lights.ts`. `staticFlicker` (exported from there) is the flicker the light budget applies; a flame reads it with the budget's clock (`LightBudget.time`) and its light's position, so the flame and its light pulse together. The flame moves 1.6 times the light's flicker.
- **The models' own flames are cut out:** the KayKit dungeon torch and candle paint their flame from the atlas's fire gradient (u 0.9 to 0.96, v 0.5 to 0.7). `PropBatch` drops the triangles whose UV centre falls there (`withoutUvRect`), only for those two assets, when it batches them; the asset viewer and town editor keep the untouched model. Where each asset's flame sits (torch bowl rim, candle wicks, lantern glass) was measured from the meshes and is in `FLAMES`.

**Detail by distance** (`fireDetail`, `nearestFirst`): each frame every fire's flame is projected to the screen. Off screen (outside 1.15 of the viewport sideways and at the top, 1.25 below, so a flame whose base is under the edge still shows its tip) nothing is drawn. On screen the flame, glow and coals are drawn. Within 650 units of the camera focus a torch or camp fire also gets particles and the shimmer, at most 8 fires at once, nearest first (the Arena ring has 14 torches). Low quality (`QualityLevel.fireParticles` false) keeps the flames, glows and coals and drops particles and shimmer.

**Cost:** every quad of every fire goes into one instanced mesh with its own shader (one draw call in total, `RENDER_ORDER.worldFire`, under smoke and embers), premultiplied blending so the additive flame and glow and the darkening soot, ash and shimmer share it. Embers, sparks and smoke go into the spell glow and smoke pools, so they add no draw calls, and ask the particle budget like every ambient emitter. Per frame the fires write a few floats per quad into a fixed buffer (640 quads) and allocate nothing. Particles use a new `wobble` field in the pool (a sideways swirl from two sines phased by the particle's seed; 0, what every spell particle has, skips it).

The VFX bench has three scenes for them: `town-fires` (the live town square from `/api/town` with its six lamps, the forge and the Arena torches), `camp-fire` (the wilds camp) and `dungeon-fires` (a dungeon room with two torches and candles). `window.vfxBench.fx.vfx.fires.stats` gives the fires drawn, the ones with particles and the quads.

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
| Draw calls (monsters and world alone: about 700) | 1230 | 1007 (988 after the review fixes) | 947 | 945 (926) |
| EntityRenderer CPU per frame | 1.3 ms | 1.4 to 1.6 ms | 1.45 ms | 1.5 ms |
| Effects CPU per frame | 0.10 ms | 0.06 ms | 0.09 ms | 0.10 ms |
| Render CPU per frame | 8.7 to 9.4 ms | 7.7 to 8.6 ms | 7.2 ms | 7.1 ms |
| JS heap growth per frame | 1.85 MB | 1.40 MB | 1.26 MB | 1.26 MB |
| Live particles | up to 900 boxes | 350 | 1060 | 1970 |

Spell views emit their particles inside `EntityRenderer.render`, which is why it gains about 0.2 ms: that work used to be in the game's draw loop, outside the measurement. After the review fixes (hostile markers, texture flash, pool spreading, shader warm-up) the same bench was run against the previous commit in one browser, alternating, three 600-frame runs each once the machine settled: High 926 against 950 draw calls, EntityRenderer 1.21 to 1.24 against 1.19 to 1.2 ms, Effects 0.07 to 0.08 against 0.07 ms, render 5.5 to 5.8 against 5.6 to 5.8 ms, heap 1.19 to 1.22 against 1.29 to 1.31 MB per frame; Low 988 against 1011 draw calls, 1.15 to 1.2 against 1.14 ms, 0.05 against 0.04 ms, 5.8 to 5.9 against 5.75 to 5.9 ms, 1.33 to 1.37 against 1.41 MB. The telegraphs are one draw instead of two.

GPU time was not measured (headless Chrome has no timer query here); the fragment cost is the zone and nova shaders (three octaves of value noise over each area) and additive sprite overdraw in a crowd.

World fires, measured with the same bench (600 frames each, 1280x720 page on the development Mac at 120 Hz, visible Chrome, no spells), before the change and after. Render is `WorldScene.render` CPU; heap is JS heap growth per frame.

| Scene | Draw calls | Render CPU | Heap per frame | Live particles |
|---|---|---|---|---|
| Town square at night (`?time=0.9`), High | 289 to 291 | 1.13 to 1.23 ms | 93.7 to 97.4 KB | 0 to 63 |
| Town square at night, Low | 289 to 289 | 1.25 to 1.11 ms | 93.7 to 95.2 KB | 0 to 0 |
| Camp fire at night, High | 129 to 131 | 0.99 to 0.97 ms | 66.5 to 68.0 KB | 0 to 52 |
| Dungeon room with two torches, High | 27 to 30 | 0.62 to 0.41 ms | 19.3 to 23.1 KB | 0 to 15 |

The fires' own draw is one call; the rest is the spell glow and smoke layers, which drew nothing before in scenes without spells, and the camp fire's log mesh in place of its two cones (the Arena building swapped its two flame cones for two iron cups). Render CPU is within run-to-run noise. The heap rise of 2 to 4 KB a frame appears once the particle layers have something to upload (three.js records an update range object per upload); the fires' own update allocates nothing. GPU time was not measured.

## Limits and open questions

- Zones and novas show only their first element: that is all the snapshot carries, so Frostfire looks like fire.
- The bond tether is always the ward colour: the snapshot lists linked ids without the bond's effect.
- Status tints on procedural rigs are a flat colour: the rig shader's emissive does not use the vertex colours, so on Low a chilled or burning rig monster reads as a tinted silhouette (textured models keep their texture under the tint). Multiplying the rig emissive by the vertex colour in `rigs/compile.ts` would fix it.
- The texture-flash program variant (KayKit materials with the emissive map) compiles on the first hit of each material program; it is not in the warm-up.
- Changing the `heroLight` and `heroLightRadius` defaults only reaches a server whose stored settings lack them; a server that saved its settings keeps its values until an admin changes them.
- Stacked zones share glow by style and position only; two casters' zones of one style on one spot also share.
- Real point lights go to the brightest sources near the camera through the shared budget (8 lights); everything else gets a ground pool from it.
- World fires: zones outside the town have no camp fires of their own; in town, builders place camp fires and braziers from the editor's palette (decor `campfire` and `brazier`, built in code in `props.ts`, drawn as `bonfire` spots).
- World fires: the dungeon torch's bowl is lit hard by its own real light (height 56, just above the bowl), which reads as a bright blob up close; the light's height is unchanged.
- World fires: the forge flare shows only for the player who inscribed, since the server sends the reply to them alone.
- World fires: there are no wall sconces in the asset list (the KayKit mounted torch only works on a wall); the brazier is built in code. A new lit asset needs an entry in `LIT_DECOR` (its light) and `FLAMES` (where its flame sits), and `BAKED_FLAMES` in `propBatch.ts` if it models its own flame.
