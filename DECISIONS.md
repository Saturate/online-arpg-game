# Decisions

Choices made where the spec was ambiguous or silent. Each can be revisited; the tuning values all live in `packages/shared/src/config/` or `packages/shared/src/data/`.

## M1

**Input rate limiting uses tick credits.** Each input is one tick of movement. A player earns one credit per server tick, capped at `SIM.inputCreditCap` (3), and spends one per applied input. Network jitter can catch up by at most 2 ticks, but a client sending faster than 20 Hz gains nothing. The queue is capped at `SIM.inputQueueMax` (10), dropping oldest, which bounds how much latency a client can build up.

**`?lag=N` adds N ms of round-trip time**, split as N/2 each way, applied on the client to both send and receive. The acceptance test "150 ms of artificial latency" was run as `?lag=150`, which shows as about 152 ms RTT on localhost.

**Own movement ignores other entities.** Players pass through enemies and each other, and only arena walls block them. This keeps prediction exact, because the predicted step depends only on input and bounds. Tested: 0 px correction at 150 ms RTT. Revisit if body-blocking is wanted.

**The cosmetic local projectile is on.** Without it, at 150 ms your own bolt appears about 250 ms after the click and behind the player. Local bolts pair one-to-one with the next server projectile you own. A paired bolt disappears when the server one does, and it also disappears when it visually overlaps a rendered enemy. An unpaired bolt is dropped after RTT + 2 ticks + 250 ms. The warrior's swing arc is drawn locally, and the server's copy of your own swing is hidden. Damage is always server-side.

**Melee resolves instantly** on the tick the swing is applied. The `swing` entity exists only so other clients can see it.

**Armor is a flat divisor:** `damage * 100 / (100 + armor)`, with heavy 60, light 25 and robe 10. These are placeholders until items can add armor.

**Class stats beyond the table** (life, move speed, primary attack numbers, colours) are invented starting values in `data/classes.ts`.

**Waves** start 2 s after the first player joins. Wave n has `4 + 2(n-1)` chasers, capped at 30. The next wave spawns 3 s after the last enemy dies. Enemies spawn at least 350 px from every player. Waves do not reset when all players leave.

**Player spawn** is the best of 12 random points, picked by distance from the nearest enemy. It started at arena centre, which caused a respawn-death loop when chasers camped the corpse.

**Death** keeps the player entity, drawn faded, for 3 s. Enemies ignore it and inputs are acknowledged but not applied. The player then respawns with full life.

**Snapshots are full, not delta-compressed.** Positions are rounded to 0.1 px and angles to 0.01 rad on the wire.

**The codec is generic over its wire type** (`Codec<string>` for JSON). `packages/shared` has no DOM or Node libs, so `TextDecoder` is unavailable there. A msgpack codec would be `Codec<Uint8Array>`.

**Server hygiene:** 4 KB max frame and 60 messages per second per client, after which the socket closes. Client messages are validated structurally in `parseClientMessage`, and unknown button bits are masked off. There are no origin checks or auth; accounts are out of scope.

**Stack additions:** `tsx` runs the server in dev. Node 26's built-in type stripping would need `.ts` import extensions throughout. pnpm 12 blocks install scripts by default, and esbuild's is allowed in `pnpm-workspace.yaml`.

## Architecture changes after M1 (approved)

**Renderer is Three.js, not Pixi.** You asked for this after M1. The camera is orthographic and locked: it follows the player, never rotates, and sits at yaw 45 and pitch 52 for a Diablo 2 framing. Both angles and the zoom live in `apps/client/src/render/config.ts`; yaw 0 with a steeper pitch gives a RotMG style view. The simulation stays 2D on the ground plane, sim (x, y) maps to three (x, 0, y), and the server does not know about 3D at all.

**Screen-relative movement.** WASD is converted through the camera's ground basis on the client, so W always moves up the screen. The server still receives a world-space `moveDir`, so it needs no camera knowledge.

**The ECS stays hand-rolled but is formalised** (`packages/shared/src/sim/ecs.ts`, `systems.ts`):
- Component stores are registered, and destroying an entity clears it from every store.
- `world.query(a, b, c)` iterates entities that have all the listed components, with typed tuples.
- One ordered `SYSTEMS` pipeline runs per tick.

Libraries (miniplex, bitECS) were considered and not chosen. The spec asks for a lightweight ECS, and the components hold rich data (sets, items, spell trees) that fits typed-array ECS libraries poorly.

## M2: Runes

- **Orphan forms are duds.** A Form that does not follow a Trigger (for example `Bolt Nova`) is a dud (`orphan_form`). This also covers "Aura and Link must be the only Form".
- **Split on Dash is a dud** (`split_dash`). The caster cannot dash three ways.
- **Timer** fires once, after 0.5 s or when the form ends, whichever comes first. So Nova (0.3 s) plus Timer fires as the nova finishes, and a bolt that hits before its timer splits at the hit point.
- **OnExpire** fires whenever the form ends, unless a triggered Split replaced it.
- **OnHit** on a piercing bolt can fire on every hit, and the entity cap counts `1 + pierce hits` firings. OnHit on Dash fires on the first enemy only.
- **Split copies** of a bolt fan out 15 degrees apart. Copies of Nova and Zone are placed in a ring 70 units out. Copies inherit the parent's hit list, so they do not re-hit the same target at once.
- **Heat depth.** Trigger and Split runes are charged at the parent's depth, and a Form after a Trigger at the child's depth. Affinity applies per rune.
- **Dud cost.** `CompileResult.heat` on a dud is the full computed heat, and casting charges `HEAT.dudHeatFraction` (50%) of it. A dud only fizzles on a fresh key press, not while the key is held.
- **Misfire** uses heat before the cast: linear from 0% at 100 heat to 50% at 130, times 1.5 on corrupted sigils. A misfire still costs the heat and deals 10% of max life, ignoring armor.
- **Casts are blocked** if `heat + cost > 130`. There is also a 0.3 s global cast cooldown, so holding a key at 20 Hz input is not 20 casts per second.
- **Persistent skills cost no heat.** They reserve the summed `spiritCost` of their runes.
- **Support vs offensive.** A node is offensive if it has an element or Force, or has neither Restore nor Ward. So `Nova Restore` only heals, and `Nova Ward Fire` damages enemies and shields allies. Heals and shields hit allies, including the caster for areas.
- **Frostfire** gets +25% damage on top of carrying both elements. **Burning Ward** shields deal 8 fire damage to enemies that make contact.
- **Dash prediction.** Dash is not predicted at cast time. The server starts it and sends the dash state with the snapshot, and the client replays unacknowledged inputs through the same `stepPlayer`, so the rest of the dash is exact. The cost is that the dash visibly starts one RTT late. Corrections are blended out over a few frames instead of popping.
- **Debug fixtures.** Every class starts with a corrupted Relic "Test Sigil" (7 slots), so the 7-rune fixture can be tried in play. With F1 on, the sigil editor has a fixture loader.

## M3: Items

- **Affix counts.** Common 0, Magic 1 to 2, Rare 3 to 4, Relic 4 to 5, with at most 3 prefixes and 3 suffixes. Affixes in the same group are mutually exclusive, so a vessel can have at most one behaviour.
- **Drops.** Normal enemies drop a bag 14% of the time. Rares always drop 1 or 2 items with better tier weights. 25% of drops are vessels. Magic or better sigils have an 8% chance to be corrupted.
- **Rare enemies** have 3x life, 1.45x size, and 1 to 3 affixes: hasted, extra projectiles, reflects projectiles, armored, regenerating. Reflected projectiles are capped at 12 damage.
- **Editor preview.** The editor compiles locally with the shared compiler for instant feedback, and the server recompiles and validates on save. The editor says "Unstable" without a reason; the debug overlay and debug view show the reason. Known gap: a curious player can read the reason off the network or the client code.
- **Inventory edits** are sent as commands, and the server resends the whole inventory after every command, so a rejected edit snaps back.

## M4: Spirit

- **Aura strength** is the node's damage scale, so sigil damage affixes strengthen auras. The strongest aura per type applies per target, where the type is Restore, Ward, Fire, Cold, Lightning or Force.
- **Elemental auras** damage enemies in range each tick. Cold also chills and Lightning also shocks.
- **The regen cap** (8 per second) covers aura and link regeneration combined. Burst heals from Nova and Zone are not capped.
- **Link targeting.** A Link targets the nearest ally player or own minion within 380 units and a 45 degree cone of the aim. It retargets on key press and when equipped, breaks beyond 480, and reconnects inside 380. A link whose target dies is cleared, because a respawned minion is a new entity.
- **Link effects.** Links add to an ally's buffs rather than following the aura stacking rule: Ward gives 30% damage reduction and Restore gives regen. Each element on the link gives the target +15% spell damage.
- **Damage reduction cap.** Total damage reduction from wards and links is capped at 60%.

## M5: Binder

- **Army cap.** The cap (6) is per player. With 4 warband slots and one minion per vessel it does not bind yet, but it is enforced.
- **Stances.** Aggressive engages within 520 of the minion, with a 900 leash. Defensive engages within 260 of the master, with a 320 leash. Follow never engages.
- **Behaviour affixes.** Bodyguard stays within 60 units of the master and gets a +14 hitbox against enemy bullets, and minions are checked before players, so it intercepts. Hunter multiplies its engage radius by 1.6 and scores rares as 10x closer. Coward retreats below 30% life and returns at 80%.
- **Vessel spirit.** Vessels reserve 15, 20, 25 or 30 spirit by tier, plus 5 per affix. The Binder starts with a common Zombie Brute and a common Skeleton Archer.

## M6: Multiplayer

- **Interest radius.** A player receives entities and events within 1100 units, plus their own minions and link targets wherever they are. The arena grew to 2800x2000 so this matters.
- **Party frames.** The snapshot's `players` list sends every player's name and life regardless of distance, for the party frames.
- **Scaling.** Waves scale by +50% enemies per extra player.

## Deferred from M1

- Server-side latency simulation. Only the client can add lag today.
- Interpolation of the own player's server-side attributes. Life shows the latest snapshot value without interpolation, which is fine.

## World mode, town editor and prebaked skills (after M6, approved)

**Modes.** The title screen picks World or Arena. World starts in the town (Emberwatch), a shared safe room with no damage and no monsters. Arena is the endless-wave test room and the only place the sigil editor works.

**Rooms.** The server's `RoomManager` hosts the town, the arena, and any number of Wilds instances. Portals and the Esc menu move a character (class, name, items, equipment, stance) between rooms, in memory only. Each Wilds instance has its own seed and therefore its own layout. Empty instances close after 5 minutes. The town portal takes you back to your last instance if it is still open. The Esc menu can open a random instance, open a typed seed, or join any open instance.

**Maps travel as descriptors, not geometry.** The welcome message carries `{ kind, seed }` for the Wilds and the full layout for the town. The client regenerates the identical map with the shared generator, so collision prediction stays exact.

**Collision.** Collision is static per map: circles, capsules and rotated boxes in a spatial hash. Water blocks walking but not shots. Movement is sub-stepped (at most 20 units per step), so dashes cannot tunnel. When a step makes less than 30% of its intended progress, the mover tries the direction turned 45 degrees each way, which stops head-on sticking against round obstacles.

**Pathing.** Enemies walk straight at a target they can see. Otherwise they follow a flow field, a multi-source BFS from every player and minion, rebuilt every 5 ticks. Minions have no pathfinding; one stuck more than 700 units from its master is pulled back.

**Wilds content.** Rivers with bridges, rock ridges with gaps, forests, ruins, loose rocks and a road. 30 packs are placed only on cells reachable from the camp, and never within 750 units of it. Monster level rises with distance, and a boss pack sits at the farthest point. Packs idle until a target is within 460 units in line of sight, or one of them is hit. Enemies dragged more than 1300 units from home give up and return, healing fully.

**Pause.** Esc pauses the room only when you are alone in it and it is not the town. With others present, the menu opens and the world keeps running.

**Prebaked skills.** Each class has four fixed skills (`data/skills.ts`), still compiled by the rune engine. Hand tuning (speed, range, damage, radius, pass-through) applies to the root node only. A skill can set its heat cost by hand, because the depth formula makes deep programs expensive (Fireball was 96). Sigil drops carry a random skill from the pool. Hand-inscribing a sigil clears its skill.

**Pulse** is a new trigger for Bolt and Zone. It fires every 0.18 s while the form lives, and never replaces its node. Pulse plus Split sprays copies in a rotating ring; this is Frozen Orb. The entity cap counts every pulse. Prebaked skills may raise the cap (Frozen Orb allows 48).

**Force.** The resource is shown to players as "Force". It keeps its internal name, heat, to match the spec's types. The knockback rune was renamed from Force to Impact to avoid the clash. The cap is 1000, with misfires above that up to 1300, so it effectively never limits play while skills are tuned.

**Paths** (roads) give +10% movement speed to players, minions and monsters. It is computed in shared movement, so prediction stays exact.

**Random streams.** Each simulation derives independent streams for loot, combat and world/spawns from its seed (`Rng.stream`). Adding a roll in one system no longer shifts outcomes in another for the same seed.

**Items.** Sigils and vessels have an item level, which is the monster level they dropped from. It gates affix tiers: T2 from level 3, T3 from level 5. Rares and relics get random two-word names. "Drop" puts an item on the ground as a bag that the dropper does not re-pick until they step away. Rare and relic ground labels always show; Alt shows all of them.

**Town editor.** F2 in town opens it, and only when the server runs with `TOWN_EDITOR=1`; the dev script sets that. Tools: select/move, place prop, path brush, plaza brush and erase. Keys: Q/E rotate, [ ] scale or length, G snap, Ctrl+Z undo. Save sends the layout to the server. The server validates every field, writes `apps/server/data/town-layout.json` (commit it to keep a designed town), and rebuilds the town room with everyone in it carried over. Portals and the spawn point can be moved but not deleted, and a layout without a Wilds portal is rejected.

## Accounts and persistence

- **HTTP for accounts, WebSocket for play:** register, login and character CRUD are plain JSON endpoints on the game server's port (`apps/server/src/http.ts`). The socket's `join` carries only a session token and a character id. Vite proxies `/api` in dev so everything stays same-origin and no CORS is served.
- **Storage:** SQLite via Node's built-in `node:sqlite`, so there is no new dependency. The file is `apps/server/data/rune.db` (override with `DB_PATH`) and is gitignored.
- **Passwords:** scrypt (N=2^15, r=8, 16-byte salt) with a timing-safe compare. Unknown usernames still run a hash, and login failures return one message, so usernames can't be probed that way. Passwords are capped at 128 characters because scrypt cost grows with input length.
- **Sessions:** 32 random bytes, stored only as a SHA-256 hash, valid for 30 days, and revoked on logout. They are bearer tokens in localStorage rather than cookies, so cross-site requests carry nothing.
- **Rate limits:** per IP over one minute; 10 for register and login, 120 for everything else.
- **Characters:** 12 per account, with names unique server-wide (case-insensitive). Every query is scoped by account id.
- **One character online per account:** a second login ends the first session after saving it, which stops item duplication across two windows.
- **Save points:** first entry, every room change, disconnect, a 30 s autosave, and shutdown.
- **Arena progress is saved:** it used to be a throwaway sandbox, which cost players their levels without warning. It is saved like the world now, free sigil inscriptions included; that makes inscribing a real feature for now rather than a test bench. Revisit if runes should cost something.
- **Not built yet:** TLS (passwords travel in the clear over plain http/ws until the deploy terminates TLS), password reset, account deletion, save versioning and migration (an unreadable save starts the character fresh and logs a warning), and trusting `X-Forwarded-For` behind a proxy.

## Dungeons and the antechamber

- **Entrances:** each Wilds map places 2 entrances on reachable ground at least 1400 units from camp. The dungeon seed comes from the Wilds seed, so everyone in one instance shares the same antechamber. Monster level comes from the entrance's distance from camp, plus 1.
- **Antechamber (`staging` map):** a small safe hall that shows up in the Esc menu instance list, so friends elsewhere can join and wait there, PoE side-area style. A ready check (R or the panel button) starts a 3 s countdown once everyone inside is ready. Anyone arriving or un-readying cancels it. When it ends, everyone inside moves into a new run together.
- **Runs:** each run is its own room, seeded from `seed + run`, so every attempt has a fresh layout. While a run is live the gate lets latecomers straight in. An empty run closes after the usual idle timeout, and the antechamber only closes once no run is live.
- **Generation:** rooms sit in a 4 by 3 slot grid, joined by a randomised DFS spanning tree plus 3 extra corridors, so there are loops without a maze. Carving uses the 40-unit nav cell, so walls line up exactly with pathfinding. Only rock cells touching floor become wall boxes, merged into rectangles, which keeps collision in the hundreds of shapes. Packs get harder with graph depth, and the boss room is the deepest room and holds the exit.
- **Rendering:** floors and walls are each one merged mesh with world-space UVs. Walls are 44 units tall rather than 70, so a south wall doesn't hide the hero. A pool of 6 point lights follows the torches nearest the player, because light count is part of every shader and one light per torch would force recompiles.
- **Underground lights:** these use windowed falloff (decay 0). Physical decay at these distances made a torch contribute almost nothing.

## Replays, loot simulator, dungeon clears

- **Replays:** a replay is every server message the client received, timestamped. Snapshots carry full state, so feeding them back through the normal `Game` reproduces the session from the recorder's point of view with no simulation on the client. `Game` takes a session that is either live (WebSocket) or replay (a virtual clock that sends nothing). Interpolation runs on that clock, so slow motion and fast forward work.
- **Recording:** F8 or the Esc menu. Files are gzipped JSON and capped at 10 minutes; a 5.7 s town clip was 5.9 KB. A recording started mid-room is seeded with the last welcome, inventory and staging state.
- **Seeking:** builds a fresh client at the target time from the last room entry before it. Combat events older than 0.5 s are stripped, so a seek doesn't burst every past hit.
- **Loot simulator:** `/dev.html` Loot tab. `rollDrops` in `items/drops.ts` is the only drop roll, and both `dropLoot` and the simulator call it.
- **Dungeon clear:** killing the boss marks the room cleared once. It opens a cache of 3 rare-or-better items, 70% gear, one level up. Everyone inside gets a banner, and the antechamber shows "Last run cleared".

## Instances, seamless town and waypoints

- **Worlds:** no global town, but no private games by default either. Everyone lands in a shared public copy of the world on the owner's world seed (admin Settings), up to 8 players (`INSTANCE_CAPACITY`); when all are full a new copy opens. Players never pick seeds. A party (invite by name, `/invite`) can open a party world with a random server-picked seed that only the party can enter.
- **Zones:** an instance is a chain of six zones with rising level bands, from Mossy Barrens (1 to 3) to The Hollows (20 to 25). Each zone room is created when someone first enters it and closed when abandoned. Seeds come from the instance seed, so a zone regenerates identically with fresh monsters, like re-entering a D2 area.
- **Seamless town:** the town layout sits at the origin of the home zone's map and is marked as a safe zone. Its fenced gates open straight onto the wilderness, so leaving town is a walk with no load. The layout stays at the origin so the town editor keeps working in town coordinates.
- **Safe zone rule:** it lives in `isTargetable`, the one check both monster aggro and damage go through. Monsters lose their target at the gate and leash home. Packs and dungeon entrances keep outside aggro range of the town.
- **Waypoints:** touching one activates it for that character (`PlayerSave.waypoints`), and everyone starts with the town's. The menu opens on contact and closes when you walk off. The server re-checks that you're standing on a waypoint and that the destination is unlocked. Saves from before waypoints existed are given the town's on load.
- **Zone transitions:** portals at the west and east edges land you just off the matching portal in the neighbouring zone, so arriving never triggers the way back.

## Character progression

- **XP curve:** XP to the next level is `60 * L^1.75`, with a cap of 50. Monsters are worth `6 * m^1.35`, times 4 for rares and 18 for bosses.
- **Low-level penalty:** monsters more than 5 levels below you lose 15% of their XP per extra level, down to a 5% floor, so farming the first zone at level 30 pays almost nothing, as in D2.
- **Party XP:** every living player within 1500 units shares a kill. The pool grows 35% per extra member, so a group levels faster than the same players alone.
- **Level growth:** per level, +6% of the class's base life, +12 Force, +1 spirit and +1.5% damage, added to gear's "increased damage" as in PoE. Level-up refills life and Force.
- **Item requirements:** an item needs item level minus 2, enforced on the server when equipping. Gear already worn from before levels existed stays on, but can't be re-equipped until the character reaches its level. Saves from before levels start at level 1.
- **Not built yet:** a real passive tree or attribute points. For now, levels only grow stats automatically.

## Monster roster and biome pools

- **Roster:** 33 new types in 16 families plus 4 phase bosses (Butcher, Lich, Broodmother, Infernal), built on the branch that was merged in. Every big attack is telegraphed: a circle or line fills up while the monster stands still, then lands, so it can always be dodged.
- **Pools:** zones draw packs from `monsterPool(biome, level)`, and harder families unlock deeper in. Pack size scales by family, and each zone's far end is its biome boss with an escort. Dungeons are crypts or caves, picked by seed.
- **Summoned adds:** necromancer and shaman raises drop no loot and give a quarter of the XP, so they can't be farmed.
- **Hero-model monsters:** monsters built on the adventurer models are drawn through a shader that desaturates the texture and repaints it in the monster's tint. A plain colour multiply kept the texture's hue, so a Pyromancer looked exactly like a player Mage.

## Controls and chat

- **Control schemes:** WASD plus mouse, or click-to-move (D2 style), set under Esc → Settings. Click-to-move plans A* over the nav grid, string-pulled along clear lines, and sends ordinary movement frames, so the server and prediction didn't change. Pressing on a monster locks onto it and attacks while held, walking into range first for melee. Shift attacks in place, and right-click casts skill 1.
- **Gamepad:** a standard-mapping pad works under either scheme and only takes over while in use, so a pad left plugged in doesn't fight the mouse.
- **Chat:** Enter chats to everyone in your game, `/w name` whispers anyone online, and `/who` lists your game. The server strips control and zero-width characters, caps messages at 200 characters and allows 6 per 5 s. Text is only ever set through React or `textContent`, never as HTML. A speaker's line also shows as a speech bubble over their head for 6 s.

## Parked ideas

- **Weapon-gated skills (not decided):** sigils could need a weapon family (arrows a bow, strikes an axe, spells a staff or wand) and minions a wand or sceptre, so the Binder trades weapon power for its army. Parked because it may make classes redundant: if weapons and sigils decide what you can do, classes could shrink to starting kits and stat leanings, all in config. Revisit alongside class balance.
