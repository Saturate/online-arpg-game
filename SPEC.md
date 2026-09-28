# Rune ARPG: Demo Handoff Spec

Working title TBD. This document is the handoff for building a first playable demo that we keep iterating on.

## Context

A browser ARPG with Path of Exile style depth in items and skill crafting, and Realm of the Mad God style simple, top-down, realtime action. The server is always authoritative. The long-term goal is a shippable game with multiplayer and trade. This spec covers only the demo.

Design pillars:

1. The action layer stays simple: WASD, mouse aim, one primary attack, a few skill keys. No input combos, no animation cancelling.
2. Depth lives in data: runes, sigils, affixes, minions.
3. The server decides everything. The client renders, predicts its own movement, and sends inputs.
4. Every tuning number lives in config or data files, never hardcoded in logic.

## How to work

- Build milestones in order. After each one, stop and summarise what was built, what was deferred, and any design questions that came up.
- Do not implement anything listed under Out of scope.
- If something in this spec is ambiguous, pick the simplest option, record it in `DECISIONS.md`, and continue.
- Ask before changing the stack or the architecture described below.

## Stack

- TypeScript everywhere, pnpm workspaces monorepo
- `packages/shared`: simulation, rune compiler, data definitions, protocol types. Pure code, no DOM and no Node APIs.
- `apps/server`: Node with `ws`, runs the simulation at a fixed 20 Hz tick
- `apps/client`: Vite, PixiJS v8 for the world, React for UI panels only, Zustand for UI state
- Vitest for tests
- Messages are JSON to start, behind a codec interface so msgpack can replace it later
- Placeholder art only: geometric shapes and colour. No asset pipeline yet.

## Architecture

### Simulation

- Fixed timestep of 50 ms. All simulation logic lives in `packages/shared` and is run by the server. The client imports the same code only to predict its own movement.
- Seeded RNG per instance. No `Math.random` or `Date.now` inside simulation code.
- A lightweight ECS style: entity ids plus typed component stores. Enough for players, enemies, projectiles, zones, minions and loot. Do not build a general-purpose engine.
- The server hosts rooms, one simulation per room. The demo uses one arena room, and must accept multiple connections from the start even though multiplayer features come in M6.

### Networking

- Client to server: input messages `{ seq, moveDir, aimAngle, buttons }`, sampled at the tick rate.
- Server to client: snapshots at 20 Hz containing entities relevant to that player, plus `lastProcessedInputSeq`.
- Own player: predicted locally and reconciled against snapshots.
- Other entities: interpolated with a buffer of about 100 ms.
- Projectiles are spawned by the server. A cosmetic local projectile for the player's own primary attack is allowed if it feels sluggish without, but it must be replaced by the server version.
- Hit leniency: enemy hitboxes against player projectiles can be slightly larger than their visuals (config value). Player hitboxes against enemy bullets stay accurate.
- The server validates all inputs: movement speed, cooldowns, heat, spirit, inventory and editor operations.

### Client boundary

- Pixi renders all world entities. React never renders anything per entity.
- The network layer writes snapshots into a plain store that Pixi reads each frame. Only UI-relevant slices (life, heat, spirit, inventory, equipped sigils) go into Zustand.

## Core systems

### Player and controls

- WASD move, mouse aim, left click primary attack, keys 1 to 4 for sigil skills, T cycles minion stance, I inventory, K sigil editor, F1 debug overlay.
- Core stats: life, armor, move speed, heat (max and cooling rate), spirit (max).

### Classes

Data-driven. The player picks a class on joining. Ascendancies are out of scope, but leave a field for them on the class definition.

| Class   | Armor | Primary attack   | Affinity runes           | Base spirit |
|---------|-------|------------------|--------------------------|-------------|
| Warrior | Heavy | Short melee arc  | Force                    | 100         |
| Ranger  | Light | Fast bolt        | Pierce, Swift            | 100         |
| Mage    | Robe  | Slow bolt        | Fire, Cold, Lightning    | 100         |
| Priest  | Robe  | Bolt             | Ward, Restore            | 150         |
| Binder  | Robe  | Bolt             | Link                     | 120         |

Affinity runes cost 20% less heat for that class, other runes cost 20% more. This is a demo stand-in for rune knowledge, which comes later.

### Heat

- Max heat 100, cools at 25 per second, cooling pauses for 0.5 s after a cast.
- Casting a skill adds its heat cost. Casting is allowed up to 130, which is the overheat zone.
- Each cast while above 100 has a misfire chance that scales with how far over 100 the player is. A misfire fizzles the skill and deals a percentage of max life to the caster.
- The primary attack costs no heat.

### Runes

Categories and the demo rune set:

- **Form**: Bolt, Nova, Zone, Dash, Aura (persistent), Link (persistent)
- **Element**: Fire, Cold, Lightning
- **Effect**: Force (knockback), Ward (damage reduction or shield), Restore (healing)
- **Modifier**: Swift, Large, Linger, Pierce
- **Trigger**: Timer, OnHit, OnExpire, OnLand
- **Action**: Split

Suggested shapes:

```ts
interface RuneDef {
  id: string;
  name: string;
  syllable: string;        // placeholder for the future rune language
  category: 'form' | 'element' | 'effect' | 'modifier' | 'trigger' | 'action';
  heatCost: number;
  spiritCost?: number;     // persistent forms only
  persistent?: boolean;
  params?: Record<string, number>;
  known?: boolean;         // always true in the demo, used by rune knowledge later
}

type CompileResult =
  | { ok: true; program: SpellNode; heat: number; spirit: number; worstCaseEntities: number; combos: string[] }
  | { ok: false; dud: DudReason; heat: number };
```

### Grammar

A skill is an ordered list of runes compiled by the server into a `SpellNode` tree. A node is one Form plus the runes attached to it.

1. The first rune must be a Form, otherwise the skill is a dud.
2. Element, Effect and Modifier runes attach to the current node.
3. A Trigger must be followed by an Action or a Form. A trailing Trigger is a dud.
4. When a Trigger fires, what follows it executes at the current node's position:
   - If it is Split, the node is replaced by N copies (default 3) in a spread. Runes after the Split attach to the copies.
   - If it is a Form, a sub-spell spawns there. Runes after it attach to the sub-spell. Sub-spells inherit the parent's element unless they have their own.
5. Split with no Trigger before it happens at the cast point, producing a spread shot.
6. Split conserves damage: each copy gets `total * splitEfficiency / N`, with `splitEfficiency` starting at 1.2.
7. Triggers must suit the Form: OnLand only for Dash, OnHit for Bolt and Dash, OnExpire for Bolt and Zone, Timer for any active Form. Otherwise dud.
8. Aura and Link cannot contain Triggers or Split, and must be the only Form in their sigil. Otherwise dud.
9. Maximum sub-spell depth is 3. Deeper is a dud.
10. The compiler computes the worst-case number of entities a cast can spawn, including recursion. Above 24 is a dud.

Heat cost: `sum(rune.heatCost * (1 + 0.5 * depthOf(rune))) * affinityMultiplier`.

Dud behaviour: casting a dud fizzles with a visual puff and costs 50% of its heat. The sigil editor shows the skill as unstable but does not say why. The debug overlay shows the reason.

### Hidden combos

Stored as data, matched when two runes attach to the same node:

- Ward + Fire: Burning Ward, the ward also burns enemies that touch it
- Fire + Cold: Frostfire, deals both damage types and applies both ailments

### Test fixtures for the compiler

| Sequence                       | Expected                                              |
|--------------------------------|-------------------------------------------------------|
| Bolt Fire                      | Fireball                                              |
| Bolt Fire Timer Split          | Travels, then splits into 3 after the timer           |
| Bolt Fire Split                | 3-way spread from the cast point                      |
| Bolt Fire Split Timer          | Dud, trailing trigger                                 |
| Dash Force OnLand Nova         | Dash, shockwave with knockback on landing             |
| Bolt Pierce Swift              | Fast piercing bolt                                    |
| Zone Restore Linger            | Longer-lasting heal field                             |
| Nova Restore                   | Burst heal for allies in radius                       |
| Aura Restore                   | Weak regeneration aura, persistent                    |
| Link Ward                      | Linked target takes less damage, persistent           |
| Aura Fire OnHit Nova           | Dud, trigger in a persistent skill                    |
| Split Bolt                     | Dud, does not start with a Form                       |
| Bolt Timer Split Timer Split Timer Split | Dud if it exceeds the entity cap or depth    |

### Sigils

- An item that holds one skill. Tier sets rune capacity: Common 3, Magic 4, Rare 5, Relic 6.
- The player has 4 sigil slots bound to keys 1 to 4. An active skill casts on its key. A persistent skill is always on while equipped and reserves spirit.
- Affixes roll from a pool by tier, for example: reduced heat cost, splits keep more damage, +1 max sub-spell depth, persistent skill reserves less spirit, increased area. A corrupted implicit can add +1 rune slot with increased misfire chance.
- Sigil editor (K): drag runes from a palette into the sigil's slots, showing heat or spirit cost and stable or unstable. All runes are unlocked in the demo.
- The server validates every edit.

### Spirit

- Persistent skills and minions reserve spirit. The player cannot equip beyond their maximum.
- Aura: a radius around the owner affecting the owner and allies. Only the strongest aura of each type applies to any one player.
- Link: a tether to an ally, or to the Binder's own minion. It targets the nearest valid target in the aim direction on activation, breaks beyond range, and reconnects automatically when back in range.
- Healing auras are regeneration only, with a hard cap per second (config). Burst healing comes from active skills like Nova Restore.

### Items, affixes and loot

- One generic affix engine shared by sigils, vessels and rare enemies: affix definitions with tiers, weights, allowed item kinds and prefix or suffix.
- Loot drops as bags. Walking over a bag picks up its contents if there is inventory space.
- Inventory has 20 slots and is a React panel.
- Weapons are fixed per class in the demo and have no affixes yet.

### Enemies

- Data-driven. Three types: Chaser (melee), Shooter (spread bullets), Spinner (radial bullet pattern).
- Rare variants roll 1 to 3 affixes from an enemy affix pool, for example hasted, extra projectiles, reflects projectiles. They are larger and drop better loot.
- Enemies spawn in waves in the arena.
- Readability: enemy bullets are bright and outlined. Player and minion projectiles are muted and semi-transparent.

### Binder and vessels

- A vessel is an item containing one minion: base type, level and affixes.
  - Zombie Brute: melee tank, defaults to guarding
  - Skeleton Archer: ranged, kites
  - Wraith: fast melee, hunts
- Behaviour affixes, at most one per vessel: Bodyguard (stays near the master and intercepts projectiles), Hunter (roams to engage rares), Coward (retreats at low life to heal).
- Other affixes, for example: increased attack speed, explodes on death, taunts nearby enemies, leeches life for the master.
- Binders have 4 warband slots, one minion per vessel. Each vessel reserves spirit based on tier and affix count. The global army cap is a config value, starting at 6.
- Stances on T: aggressive, defensive, follow.
- A dead minion respawns after a cooldown, starting at 10 s, which affixes can modify.
- Minion AI is simple server-side state machines.
- Where possible, vessel affixes reuse enemy affix definitions, so capturing rare enemies can be added later without a new affix system.

## Milestones and acceptance

**M1: Skeleton**
Monorepo, server tick, one player moving and using a primary attack, Chaser enemies, damage, death and respawn, prediction and reconciliation, debug overlay with tick, RTT and entity count.
Accepted when: with 150 ms of artificial latency, own movement still feels immediate, and enemies only die through server simulation.

**M2: Runes**
Compiler with tests covering every fixture above, heat, 4 sigil slots with hardcoded sigils, the forms Bolt, Nova, Zone and Dash, triggers, Split, duds and the entity cap.
Accepted when: every fixture behaves as described in play, and dud reasons show in the debug overlay.

**M3: Items**
Affix engine, sigil drops, inventory and sigil editor UI, rare enemies.
Accepted when: a player can find a Rare sigil, inscribe a 5-rune skill, and use it.

**M4: Spirit**
Aura and Link, spirit reservation, the aura stacking rule, and the healing regeneration cap.

**M5: Binder**
Vessels, minions, behaviour affixes, stances and respawn.

**M6: Multiplayer**
Several players in one arena, auras and links working between players, and basic interest management so each client only receives nearby entities.

## Out of scope

Accounts, persistence or a database (all state lives in memory and is lost on restart), trade, ladder, rune knowledge and learning, inscription materials, ascendancies, the rune language beyond the placeholder `syllable` field, capturing rare enemies, permadeath, real art, audio, mobile support.

## Config and balance

All numbers in this document are starting values. Keep them in `packages/shared/src/config/` so they can be tuned without touching logic.

## Open questions

Flag these if they block progress, but do not decide them:

- Final name for the sigil item and for the spirit resource
- One sigil slot type, or separate active and persistent slots
- Whether players should ever see why a skill is unstable
- Rune knowledge per character or per account
- Permadeath
- Trade model
- Phonetics and rules for the rune language
- Working title
