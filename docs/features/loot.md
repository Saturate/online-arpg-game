# Loot

Status: Live (ground bags, click pickup and gold since 2026-09-29). Loot piles are planned.

## What it does

- **Monsters drop bags.** A bag lies on the ground for 90 s. Rare and relic item names always show over it; hold Alt to show every label.
- **Click a bag or its label to pick it up.** The hero walks there first. Any other click cancels the walk, and so do movement keys or a bag with no path to it.
- **Gold** drops as its own pile and is picked up by walking over it.
- **Your own drop stays down until you step away.** A bag you drop from the inventory cannot be clicked back up by you until you have walked `LOOT.dropStepAway` (70 units, about two strides) from where you stood; the click answers "Step away before taking back your own drop". Anyone else can take it at once. Leaving the room or dying lifts the rule too.
- **Bosses drop 4 items, rares 1 or 2, normal monsters one item 8% of the time.**
- **Clearing a dungeon** (killing its boss) opens a cache of 3 rare-or-better items one level up, on top of the boss's own drops.
- **Nothing drops in the Arena** ([arena.md](arena.md)).
- **The loot simulator** in the dev tools rolls thousands of kills and shows the tier and kind mix ([dev-tools.md](dev-tools.md)).

## Why

- **Items wait on the ground until clicked,** instead of being picked up on walk-over, so the bag does not fill with things you did not want. Gold still goes on walk-over, since it takes no room.
- **The dropper rule** makes a drop mean "leave it here": without it, a stray click on the bag you just dropped (it lands at your feet) put the item straight back. It is measured from where the dropper stood, not from the bag, because a crowded floor scatters a drop up to a few bag widths away, which would lift a bag-distance rule at once.
- **Loot pace:** normal monsters drop 8% of the time (slowed from 14%, so drops feel like an event and gear lasts a while). Tier weights lean common and magic: a relic is about 1 in 300 normal drops.

| Source | Items | common | magic | rare | relic |
|---|---|---|---|---|---|
| normal | 1 at 8% | 72 | 24 | 3.7 | 0.3 |
| rare | 1 to 2 | 0 | 55 | 38 | 7 |
| boss | 4 | 0 | 30 | 60 | 10 |
| dungeon cache | 3 | 0 | 0 | 70 | 30 |

- **Kind mix:** 25% of drops are runes (the forge's currency), and 20% of those are rolled; their rune affixes roll six tiers gated by item level (T6 from 1 up to T1 from 12, T1 about one number affix in 90 at the top), and common and magic runes stop at T4 ([runes.md](runes.md), "Rolled runes"). Gear, sigil and vessel affixes keep three tiers. A Concentrated rune is always rolled, whichever way it drops, since its amount is its roll ([runes.md](runes.md), "Concentrated rune"). The rest split gear 50%, sigils 35%, vessels 15%, which makes gear 37.5%, sigils 26.25% and vessels 11.25% of all drops. 30% of sigil drops carry a random kit's runes, unbound, with the kit's in-table rolls.
- **The dungeon cache** is richer per item than a boss drop (30% relic against 10%) because clearing the whole run earns it; 70% of it is gear, the rest sigils.
- **Gold** drops from 35% of normal kills and always from rares and bosses: 2 to 6 gold per monster level, times 4 for rares and 15 for bosses.
- **Summons, raised corpses and dev-spawned monsters drop nothing,** so they cannot be farmed ([monsters.md](monsters.md)).
- **`rollDrops` is the only drop roll.** Both the simulation's `dropLoot` and the loot simulator call it, so the simulator shows what the game does.
- **Pickup needs a clear line:** walls, rocks, trees and pillars block it, water does not. The server allows 20 units (two input frames of walking) of extra reach for a request that overtakes its inputs.
- **Bags never land in walls:** a new bag starts from open ground, and when another bag is within 2.2 radii it tries rings of spots around the fall point with a clear line from it.

## How

- Drops: `packages/shared/src/items/drops.ts` (`rollDrops`, `DROP_TIER_WEIGHTS`, `BOSS_DROPS`, `MAX_DROP_ITEMS` 24, `dropSigil`).
- Ground loot: `packages/shared/src/sim/inventory.ts` (`dropLoot`, `freeBagSpot`, `pickupLoot`, `updateLoot`, `discard`). The dungeon cache: `sim/dungeon.ts`.
- Numbers: `LOOT` in `packages/shared/src/config/sim.ts` (`bagLifetimeSeconds` 90, `bagRadius` 16, `normalDropChance` 0.08, shares, `goldChance` 0.35, `goldPerLevel` 2 to 6, `pickupReach` 50, `pickupLagSlack` 20), `DUNGEON.cacheItems` and `cacheTierWeights`, `FORGE.rolledRuneShare`.
- Client: labels and click pickup in `apps/client/src/game/game.ts`; bags drawn as sacks with a tier-coloured tie, coin stacks for rare and relic or gold piles, and a beam, in `apps/client/src/render/entities.ts`; minimap dots in `render/minimap.ts`.
- Snapshot: a bag is `k: 'loot'` with its best tier, item count, names with tiers, and gold.
- Loot simulator: `apps/client/src/dev/LootTab.tsx`, `dev/loot/lootStats.ts`.

```ts
interface LootComp { items: Item[]; gold: number; lifetime: number; dropper: { id: number; x: number; y: number } | null }
```

Admin tunable: `lootRate` (0 to 20, default 1) multiplies the normal drop chance and the gold chance, and scales rare and boss item counts, up to 24 items a bag. It does not scale gold amounts or the dungeon cache.

Tests:

- `packages/shared/test/drops.test.ts`: `rollDrops` matches the simulation item for item, is deterministic, and handles loot rates of 1, 0, scaled and capped.
- `packages/shared/test/progression.test.ts`: dropped bags scatter so they never stack on one spot.
- `packages/shared/test/itemSafety.test.ts`: no pickup through walls; dev monsters, splitter children and raised monsters pay nothing; the dropper cannot click their own drop back until they step away, another player can take it at once, and gold still goes on walk-over.
- `packages/shared/test/systems.test.ts`: rare enemies drop items to click up and gold to walk over.
- `packages/shared/test/dungeon.test.ts`: the boss clears the run once and opens the cache.
- `apps/client/test/loot.test.ts`: the loot simulator is deterministic and respects share overrides and item-level affix caps. Its affix table lines tiers up from the weakest to T1, so three-tier and six-tier affixes share the T1 column.

## Planned: loot piles

Owner decisions from 2026-09-30. Not built.

- **Nearby drops merge into one pile** on the ground: one label with the best tier colour and a count, like gold.
- **Merge radius** defaults to about 1.5 player body widths and is an admin setting (ServerSettings, like the other tunables), applied without a deploy; 0 turns merging off.
- **A new drop inside the radius of an existing pile joins it.** A boss's drop is one pile; two monsters dying apart stay two piles.
- **Clicking a pile** walks the hero there (same rules as today: clear line, walk first) and opens a small loot window listing its items with tooltips: take one with a click, or "Take all". Alt labels stay. Adding to the bag stays all or nothing per item; plain rune stacks may be partly taken as today.
- **Hovering a pile** (its label or its model) shows a minimal preview: a compact list of tier-coloured names, rune stack counts, maybe small icons; no buttons and no full tooltips. It follows the cursor or sits above the label, never blocks aiming for long, and disappears when the cursor leaves. It comes from data the client already has (no request per hover). Piles are free for all, so their contents are public and the preview leaks nothing.
- **Free for all:** everyone sees every pile, first come first served, as today. No personal loot.
- **Item safety cases to cover:** two players taking from the same pile in the same tick; a pile emptied while the window is open; a pile despawning; the dropper's own drop rule; gold still picked up by walking over it. A fresh-eyes loss and duplication review before it ships.
- **Build order:** after stash tabs merge, in parallel with guilds with separate files. Loot owns ground loot, pickup, the loot window and ground rendering; guilds own guild data, the guild stash and the guild window ([guilds.md](guilds.md)).

## Limits and open questions

- **Loot piles and the dropper rule:** when drops merge into piles, the rule has to hold per item (your own drop inside a shared pile), not per bag.
- `lootRate` does not scale gold amounts, which an admin raising loot for an event might expect.
- The loot simulator does not simulate gold or the dungeon cache.
