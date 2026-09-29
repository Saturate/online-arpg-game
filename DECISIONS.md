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

**Snapshots are full, except for spells.** Positions are rounded to 0.1 px and angles to 0.01 rad on the wire, and the socket uses permessage-deflate. Projectiles, novas and zones are sent once per client (with velocity, or age and duration), again only if their motion changes, then listed as gone; the client's `SpellTable` carries them forward and expands each snapshot back to full state before anything else reads it. Measured with 4 mages against 30 enemies: 3.1 KB to 1.5 KB per tick deflated.

**Live spell cap:** each player may have spell entities worth 40 alive, a projectile counting 1 and a zone or nova 0.35. Past that their oldest spent pieces end first, and pieces still carrying a payload last. Frozen Orb lost about 3% of its damage.

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
- **Zones don't stack per caster:** a target takes at most one tick per caster, per kind (elements and effects), per tick interval, however many of that caster's zones it stands in. Different casters still stack. Zone damage rose from 6 to 14 per tick to match, and Fireball was retuned (bolt damage x2, Force 24): about 430 DPS into 6 dummies, beside Frozen Orb's 400, down from about 1000.
- **Frostfire** gets +25% damage on top of carrying both elements. **Burning Ward** shields deal 8 fire damage to enemies that make contact.
- **Dash prediction.** Dash is not predicted at cast time. The server starts it and sends the dash state with the snapshot, and the client replays unacknowledged inputs through the same `stepPlayer`, so the rest of the dash is exact. The cost is that the dash visibly starts one RTT late. Corrections are blended out over a few frames instead of popping.
- **Debug fixtures.** With F1 on, the sigil editor has a fixture loader. The old "Test Sigil" every character started with is gone; saves that still hold one lose it on load and get its runes back, bound.

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

**One way in.** Everyone enters the world, in the town (Emberwatch), a shared safe area with no damage and no monsters. The title screen had a World/Arena choice until the Arena became a zone reached from town (see "The Arena" below).

**Rooms.** The server's `RoomManager` hosts every room, each inside a world instance: town and zones, dungeon and Arena antechambers and their runs, and builders' sandboxes. Portals and the Esc menu move a character (class, name, items, equipment, stance) between rooms, in memory only. Each Wilds instance has its own seed and therefore its own layout. Empty instances close after 5 minutes. The town portal takes you back to your last instance if it is still open. The Esc menu can open a random instance, open a typed seed, or join any open instance.

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

**Town editor.** F2 in town opens it for builders and up (the `townEdit` permission); the admin page points to it. Tools: select/move, place prop, path brush, plaza brush and erase. Keys: Q/E rotate, [ ] scale or length, G snap, Ctrl+Z undo. Save sends the layout to the server. The server validates every field, writes `apps/server/data/town-layout.json` (commit it to keep a designed town), and rebuilds the town room with everyone in it carried over. Portals and the spawn point can be moved but not deleted, and a layout without a Wilds portal is rejected.

## Accounts and persistence

- **HTTP for accounts, WebSocket for play:** register, login and character CRUD are plain JSON endpoints on the game server's port (`apps/server/src/http.ts`). The socket's `join` carries only a session token and a character id. Vite proxies `/api` in dev so everything stays same-origin and no CORS is served.
- **Storage:** SQLite via Node's built-in `node:sqlite`, so there is no new dependency. The file is `apps/server/data/rune.db` (override with `DB_PATH`) and is gitignored.
- **Passwords:** scrypt (N=2^15, r=8, 16-byte salt) with a timing-safe compare. Unknown usernames still run a hash, and login failures return one message, so usernames can't be probed that way. Passwords are capped at 128 characters because scrypt cost grows with input length.
- **Sessions:** 32 random bytes, stored only as a SHA-256 hash, valid for 30 days, and revoked on logout. They are bearer tokens in localStorage rather than cookies, so cross-site requests carry nothing.
- **Rate limits:** per IP over one minute; 10 for register and login, 120 for everything else.
- **Characters:** 12 per account, with names unique server-wide (case-insensitive). Every query is scoped by account id.
- **One character online per account:** a second login ends the first session after saving it, which stops item duplication across two windows.
- **Save points:** first entry, every room change, disconnect, a 30 s autosave, and shutdown.
- **Arena runs are saved like any room:** XP earned in a run is kept, and characters move in and out through the same save-on-move path as every other room change.
- **Not built yet:** TLS (passwords travel in the clear over plain http/ws until the deploy terminates TLS), password reset, account deletion, save versioning and migration (an unreadable save starts the character fresh and logs a warning), and trusting `X-Forwarded-For` behind a proxy.

## Dungeons and the antechamber

- **Entrances:** each Wilds map places 2 entrances on reachable ground at least 1400 units from camp. The dungeon seed comes from the Wilds seed, so everyone in one instance shares the same antechamber. Monster level comes from the entrance's distance from camp, plus 1.
- **Antechamber (`staging` map):** a small safe hall that shows up in the Esc menu instance list, so friends elsewhere can join and wait there, PoE side-area style. A ready check (R or the panel button) starts a 3 s countdown once everyone inside is ready. Anyone arriving or un-readying cancels it. When it ends, everyone inside moves into a new run together.
- **Runs:** each run is its own room, seeded from `seed + run`, so every attempt has a fresh layout. While a run is live the gate lets latecomers straight in. An empty run closes after the usual idle timeout, and the antechamber only closes once no run is live.
- **Generation:** rooms sit in a 4 by 3 slot grid, joined by a randomised DFS spanning tree plus 3 extra corridors, so there are loops without a maze. Carving uses the 40-unit nav cell, so walls line up exactly with pathfinding. Only rock cells touching floor become wall boxes, merged into rectangles, which keeps collision in the hundreds of shapes. Packs get harder with graph depth, and the boss room is the deepest room and holds the exit.
- **Rendering:** floors and walls are each one merged mesh with world-space UVs. Walls are 44 units tall rather than 70, so a south wall doesn't hide the hero. A pool of 6 point lights follows the torches nearest the player, because light count is part of every shader and one light per torch would force recompiles.
- **Underground lights:** these use windowed falloff (decay 0). Physical decay at these distances made a torch contribute almost nothing.

## Replays, loot simulator, dungeon clears

- **Replays:** a replay is every server message the client received, timestamped. Snapshots carry full state apart from spells (which the client rebuilds from the records in earlier snapshots), so feeding them back through the normal `Game` reproduces the session from the recorder's point of view with no simulation on the client. `Game` takes a session that is either live (WebSocket) or replay (a virtual clock that sends nothing). Interpolation runs on that clock, so slow motion and fast forward work.
- **Recording:** F8 or the Esc menu. Files are gzipped JSON and capped at 10 minutes; a 5.7 s town clip was 5.9 KB. A recording started mid-room is seeded with the last welcome, inventory and staging state.
- **Seeking:** builds a fresh client at the target time from the last room entry before it. Combat events older than 0.5 s are stripped, so a seek doesn't burst every past hit.
- **Replays started mid-room** miss spells already alive when recording began; spells cast after that show normally.
- **Spell Lab** (`/admin/dev/`): reads rune lists with the v2 grammar (PLAN-runes.md, Decisions) and hands castable spells to Spell Studio to cast at dummies; parts the engine cannot run yet are named, not dropped.
- **Loot simulator:** `/admin/dev/` Loot tab. `rollDrops` in `items/drops.ts` is the only drop roll, and both `dropLoot` and the simulator call it.
- **Dungeon clear:** killing the boss marks the room cleared once. It opens a cache of 3 rare-or-better items, 70% gear, one level up. Everyone inside gets a banner, and the antechamber shows "Last run cleared".

## Instances, seamless town and waypoints

- **Worlds:** no global town, but no private games by default either. Everyone lands in a shared public copy of the world on the owner's world seed (admin Settings), up to 8 players (`INSTANCE_CAPACITY`); when all are full a new copy opens. Players never pick seeds. A party (invite by name, `/invite`) can open a party world with a random server-picked seed that only the party can enter.
- **Zones:** an instance is a chain of six zones with rising level bands, from Mossy Barrens (1 to 3) to The Hollows (20 to 25). Each zone room is created when someone first enters it and closed when abandoned. Seeds come from the instance seed, so a zone regenerates identically with fresh monsters, like re-entering a D2 area.
- **Seamless town:** the town layout sits at the origin of the home zone's map and is marked as a safe zone. Its fenced gates open straight onto the wilderness, so leaving town is a walk with no load. The layout stays at the origin so the town editor keeps working in town coordinates.
- **Safe zone rule:** it lives in `isTargetable`, the one check both monster aggro and damage go through. Monsters lose their target at the gate and leash home. Packs and dungeon entrances keep outside aggro range of the town.
- **Waypoints:** touching one activates it for that character (`PlayerSave.waypoints`), and everyone starts with the town's. The menu opens when the waypoint is clicked and closes when you walk off. The server re-checks that you're standing on a waypoint and that the destination is unlocked. Saves from before waypoints existed are given the town's on load.
- **Zone transitions:** gates, not portals. Each exit is a stone arch on the map edge with lanterns and a dirt road that runs on into a gap in the border forest; walking through it changes zone, and you arrive just inside the matching gate of the neighbouring zone, so arriving never triggers the way back. The road into a gate is cleared of obstacles.
- **Waypoints** are drawn as a raised stone slab with four rune stones and a dim rune circle, not as a portal.

## Character progression

- **XP curve:** XP to the next level is `90 * L^1.9` (slowed from `60 * L^1.75` so gear requirements gate longer), with a cap of 50. Monsters are worth `6 * m^1.35`, times 4 for rares and 18 for bosses.
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

- **No basic attack:** every hit comes from a sigil; the server ignores the old primary button. Force is the limit: skills cost 75% of their listed Force, and cooling ramps up the longer you hold off (30/s, plus that again per second, up to 6x), so a full bar clears in about 8 s.
- **Mouse skills, D2 style:** left and right mouse each cast a picked skill slot. Left-click a skill slot to put it on the left button, right-click for the right, or scroll (Shift for the left). Picks are saved per character in localStorage; the default is the first two cast (not persistent) skills. Dragging a skill onto another slot swaps them, and the picks follow.
- **Control schemes:** WASD plus mouse, or click-to-move (D2 style), set under Esc → Settings. Click-to-move plans A* over the nav grid, string-pulled along clear lines, and sends ordinary movement frames, so the server and prediction didn't change. Pressing on a monster locks onto it and casts the left skill while held, walking into range first. Shift casts in place.
- **Browser safety:** Back, mouse side buttons and swipes don't leave the game; reload and close ask first (not in dev). One game tab at a time: a tab entering the game tells the others over a BroadcastChannel and they step aside. Stuck keys are cleared on Cmd release, when the tab hides or the window loses or regains focus, and when the leave prompt opens (macOS drops keyups while Cmd is held; native dialogs and menus swallow them). The browser context menu is blocked outside text fields, and bound keys block their default on release too, so releasing Alt on Windows cannot hand focus to the menu bar. F1 lists the keys the game thinks are held.
- **Gamepad:** a standard-mapping pad works under either scheme and only takes over while in use, so a pad left plugged in doesn't fight the mouse.
- **Chat:** Enter chats to everyone in your game, `/w name` whispers anyone online, and `/who` lists your game. The server strips control and zero-width characters, caps messages at 200 characters and allows 6 per 5 s. Text is only ever set through React or `textContent`, never as HTML. A speaker's line also shows as a speech bubble over their head for 6 s.

## Admin, roles and accounts

- **Roles:** owner (from `ADMIN_USERS`, never grantable), admin, moderator, builder, player, each a fixed permission set in `protocol/roles.ts`. Staff act only on accounts ranked below them. Builders get the town editor (F2) and the F3 dev tools; moderators and up kick, ban, announce and `/goto` players. Names in `ADMIN_USERS` can't be registered or claimed.
- **Admin page** (`/admin/`, with the dev tools at `/admin/dev/` for builders and up): online players, games and rooms, announcements, accounts with characters, roles, bans, and live settings (XP and loot rates, motd, registration, world seed, day length, night brightness, the in-game clock, which can be set or held, and Force: the level-1 bar, a cost multiplier, a cooling multiplier and the cooling ramp cap). Force changes apply to everyone at once; skill tooltips still show the base cost, not the multiplied one.
- **Guests:** "Play as guest" makes an account with a generated name and a one-year session; the character screen offers to claim it with a real name and password. Unclaimed guests are deleted after 90 days without play.

## Items, loot and economy

- **Grid inventory:** bag 12x8, stash 12x10, D2 footprints (armour and weapons 2x3, helmets, gloves and boots 2x2, belts 2x1, vessels 1x2, jewellery, sigils and runes 1x1). Grids are flat cell arrays (one uid per covered cell), so saves barely changed; a save of another size is repacked on load, and anything that fits nowhere stays *pending* with the character and is retried every load, never dropped.
- **Stash:** per account, shared by all its characters, at the town chest. Stored separately from characters and written in one transaction with them; an unreadable stash refuses the join instead of being saved over.
- **Pickup:** items wait on the ground until clicked (bag or label, Alt shows all); the hero walks there first. Any other click cancels the walk, and so does a bag with no path to it. Items that arrived in the bag since you last looked (picked up, bought, a rune stack that grew) get an ember mark until hovered. Gold drops (a third of kills, always from rares and bosses) and is picked up by walking over it.
- **Loot pace:** normal monsters drop 8% of the time; tier weights lean common and magic (relic about 1 in 300 normal drops). Starter items are bound and can't be sold.
- **Stations open on a click:** the stash, trader, forge and waypoints open when clicked, after the hero walks into reach, and close when you walk away, as in D2. Touching a waypoint still activates it; its menu waits for the click. The forge opens straight into the sigil editor.
- **Trader:** the stall nearest the town spawn. Only relics ask before selling (an in-game prompt, not a browser dialog); everything else sells on the right-click. Sell for gold (tier and item level), buy at 3x from one shelf shared by the whole server; 50 items, the oldest destroyed when a 51st is sold. The shelf, the character and the stash are saved in one transaction per trade.
- **Runes and the forge:** runes drop (a quarter of drops, forms and elements common, triggers rare) and stack 20 to a cell, and a stack sells for its count. The forge is the weapon rack nearest the spawn; there the sigil editor spends runes from the bag and returns ones taken out. Each sigil slot remembers whether its rune was bound, so a rune comes back out exactly as it went in. Builders keep a free test bench in their private sandbox (`/sandbox`); runes put in there are bound, and only unbound runes (paid for at the forge, or from a drop) come back out of it. A rune that does not fit back in the bag goes to pending, never lost.
- **Bound items** (starter kit, dev items, and sigils holding bound runes) cannot be sold, dropped or put in the account stash, so a new character cannot farm them for another.
- **Dev tools:** items given with them are bound, and monsters spawned with them drop nothing and give no XP. Monsters a shaman raised pay out nothing the second time.
- **Adding to the bag is all or nothing:** a purchase that does not fit tops up no stacks. Ground pickups still take part of a rune stack, since they shrink the real ground item.
- **Item ids** are unique across the server (each room takes its own range), so a command carrying an id from the room a player just left cannot touch a different item.
- **Pickup** needs a clear line (walls and rocks block, water does not) and allows two input frames of extra reach for a request that overtakes its inputs.
- **Warband:** 24 slots, a ceiling no build reaches; spirit is the real limit. Binders start with one minion (Zombie Brute).

## The Arena

- **A zone, reached from town:** the town's Arena portal leads to the Arena gate, one per world instance, an antechamber with the dungeon ready check (R). At the countdown everyone inside goes into a fresh run room. The staging code serves both kinds; dungeon gates still let latecomers walk into a live run.
- **No latecomers:** runs are scored, so nobody joins one after it starts: the gate's pit portal only says to ready up, `/goto` refuses, and a reconnect lands in town. A gate can start another run while one is live; each run is its own room, with an id from a server-wide counter (a gate closed and reopened during a long run must not reuse a live run's id).
- **Rules are room settings, not map checks:** the server calls `startArena` on a new run's simulation, and that state switches on the Arena waves, scoring, one life, no drops and reduced XP. Other rooms carry `RoomRules` (free bench, map waves).
- **Waves:** the first comes 3 s after the start. Each wave brings more monsters (6, plus 2 a wave, up to 40, plus 60% of that per extra living player), a growing chance of rares (5% to 45%) and of whole biome packs with a rare leader (0 to 40%), and monster level starting at the party's average level, rising half a level per wave. Every fifth wave adds the biome's boss. A 5 s breather follows each cleared wave. A wave still alive after 90 s is joined by the next one, without its clear bonus, so a party cannot stall a wave to farm a summoner's adds and a stuck monster cannot freeze a run. Numbers live in `ARENA` in `config/sim.ts`.
- **Score:** each kill scores the monster's XP value before the level-gap penalty (so outlevelling the waves does not shrink it), and clearing wave n adds 40 x n. Monsters that pay no rewards (raised corpses) score nothing. Live in the party frame, and on a score screen at the end.
- **Rewards:** no items and no gold drop in a run; kill XP is 50%.
- **One life:** the fallen stay down and watch from where they fell (spectating reaches as far as the interest radius, 1100 units). The run ends when everyone inside is down or has left; after 10 s on the score screen, everyone still there goes back to the gate on their feet. Runs never pause and refuse dev commands.
- **Leaderboard:** SQLite table `arena_runs`, one row per finished run that reached wave 1: season, names, classes, party size, score, wave, seconds, finish time. Names are copied in, so the board keeps its history. Seasons are calendar months in UTC (`YYYY-MM`). Solo is a party of one, party is two or more; ties go to whoever finished first. Runs with a builder or above in the party (who can give themselves gear) are marked [staff] rather than hidden, since the owner plays too. `GET /api/arena/leaderboard?season=` is public (it shows names and scores only) under the normal rate limit. The champions' stone in the gate hall, the Arena party panel and the admin page's Arena tab show the season's top 10 of each board and every earlier season's winners.
- **Builders' sandbox:** the free bench left the Arena, where it would be cheating. Builders open a private flat room with `/sandbox` (again, or the town portal, to leave), with the bench and F3 dev tools and no waves, so it is not a private farm. Saved like anywhere else; `/goto` will not follow a builder into it.

## Look and world

- **Dark and gritty (D2 Act 1 / PoE), not cute:** low overcast light, a vignette, a global canvas grade (desaturate, contrast, a little sepia) and a shared-shader grime pass (world-space blotches, soot near the ground) over the KayKit models. Dungeons are torch-lit dark.
- **Day and night:** visual only, from the wall clock so everyone sees the same sky; the admin sets day length, night brightness and the clock. `?time=0.75` pins the time locally for testing.
- **Weather:** a clear day is sunny; the gloom comes from the colour grade, the night and overcast spells. The sky's cloud cover also follows the wall clock (a new value every 9 minutes, blended), mostly clear; cloud dims and greys the sun and flattens the light rather than making it dark. `?weather=0..1` pins it for testing.
- **Map edges:** grass runs 1500 units past the edge under an instanced forest with rocks and mountain rings, so the camera never sees void.
- **Minimap:** fog of war, uncovered as you walk (remembered per map for the session); party members in the same map share their vision and always show.

## Operations

- **Deploys:** a push to `main` builds the image in GitHub Actions and Flux rolls it out to arpg.akj.io, restarting the server (everyone is saved first and reconnects). Hold pushes until the owner says deploy.
- **Town in git:** `GET /api/town` serves the live town; `pnpm town:pull` writes it to `apps/server/data/town-layout.json`, which is bundled as the starting town. The daily `town-sync` workflow pushes a `town/live` branch when the live town changed (Actions can't open PRs in this repo).

## Parked ideas

- **Weapon-gated skills (not decided):** sigils could need a weapon family (arrows a bow, strikes an axe, spells a staff or wand) and minions a wand or sceptre, so the Binder trades weapon power for its army. Parked because it may make classes redundant: if weapons and sigils decide what you can do, classes could shrink to starting kits and stat leanings, all in config. Revisit alongside class balance.
- **Restartless tuning (asked, not answered):** put the numbers tuned most often (minion strength, Force cost and cooling, drop chances) on the admin page, so balance changes need no deploy or restart.

Open items and the handoff for the next session are in the README.
