# Loot

Status: Live (ground bags, click pickup and gold since 2026-09-29). Loot piles built on `feat/loot-piles` (2026-10-02), not yet deployed.

## What it does

- **Drops lie on the ground in piles.** A new drop within the merge radius of an item pile joins it, so one kill's drops, a boss's drop and drops made on one spot are one pile; two monsters dying apart leave two. A pile lies for 90 s, and the clock starts again when something joins it.
- **One label per pile:** a single item shows its name, a pile shows a count ("5 items") in its best item's tier colour, like gold. Piles holding a rare, relic or unique are always labelled; hold Alt to label every pile.
- **Hovering a pile** (its label or its model) shows a short list of its best eight items in tier colours, with rune stack counts and "and N more", above and right of the cursor, clear of the pile's own label. A single item shows none, since its label names it. It lets every click through and hides while a mouse button is held, so it never covers what you aim at.
- **Click a pile or its label** and the hero walks there. A single item goes straight into the bag, as before. A pile opens a small loot window left of the hero: click an item to take it, or Take all. Each item has its tooltip, placed left of the window so it never covers the hero. The window closes when you walk away, press Esc or the close button, when the pile empties or despawns, or on a room change. Any other click cancels the walk, and so do movement keys or a pile with no path to it.
- **Gold** drops as its own pile and is picked up by walking over it.
- **Your own drop stays down until you step away.** An item you drop from the inventory cannot be taken back by you until you have walked `LOOT.dropStepAway` (70 units, about two strides) from where you stood; the click answers "Step away before taking back your own drop". The rule is per item: in a pile with a monster's drops, you can take the rest at once, and Take all leaves your own. In the loot window your own drop shows dimmed with that hint. Anyone else can take it at once. Leaving the room or dying lifts the rule too.
- **Free for all:** everyone sees every pile, first come first served. Two players taking the same item in the same tick: the first gets it, the second is told "Someone else took it".
- **Bosses drop 4 items, rares 1 or 2, normal monsters one item 8% of the time.**
- **Clearing a dungeon** (killing its boss) opens a cache of 3 rare-or-better items one level up, on top of the boss's own drops.
- **Nothing drops in the Arena** ([arena.md](arena.md)).
- **The loot simulator** in the dev tools rolls thousands of kills and shows the tier and kind mix ([dev-tools.md](dev-tools.md)).

## Why

- **Piles** (owner, 2026-09-30) keep a fight's floor readable: a boss used to spill four stacked labels, a crowded floor dozens. One label and a list on hover show the same with less noise.
- **A single item is taken on the click,** without a window: a window for one item would cost every pickup an extra click. Merging off (radius 0) still gives one window for a multi-item drop such as a boss's.
- **The merge radius** defaults to 42 units, 1.5 player body widths (a body is 28 wide), so drops on one spot join and monsters a few strides apart stay apart. A hero standing at a pile to loot it is further than that from its centre (pickup reach is about 68), so dropping an item there starts its own pile. It is measured from the drop's fall point to the pile's centre, a pile never moves, so piles cannot creep across a room. A pile behind a wall from the fall point is not joined. Gold piles never take items (they go on walk-over).
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
- **A pile holds at most `LOOT.pileMaxItems` (40);** the next drop starts a new pile, so the window and the hover list stay short.
- **Snapshots carry a pile's best eight names** (`LOOT.pilePreviewNames`) and its count, not its items: every nearby client gets every pile every tick. Full items go only to the player with the window open, in a `lootPile` message sent when it opens and again only when the pile changes (an item taken, a drop joining, a dropper's mark lifting). So the hover preview needs no request, and a 40-item pile costs the same in a snapshot as an 8-item one.
- **Bags never land in walls:** a new bag starts from open ground, and when another bag is within 2.2 radii it tries rings of spots around the fall point with a clear line from it.

## How

- Drops: `packages/shared/src/items/drops.ts` (`rollDrops`, `DROP_TIER_WEIGHTS`, `BOSS_DROPS`, `MAX_DROP_ITEMS` 24, `dropSigil`).
- Ground loot: `packages/shared/src/sim/inventory.ts` (`dropLoot`, `spawnBag` and `pileFor` for merging, `freeBagSpot`, `takeLoot` for one item or all, `pickupLoot`, `lootView` for the window, `updateLoot`, `discard`). The dungeon cache: `sim/dungeon.ts`.
- Numbers: `LOOT` in `packages/shared/src/config/sim.ts` (`bagLifetimeSeconds` 90, `bagRadius` 16, `normalDropChance` 0.08, shares, `goldChance` 0.35, `goldPerLevel` 2 to 6, `pickupReach` 50, `pickupLagSlack` 20, `mergeRadius` 42, `pileMaxItems` 40, `pilePreviewNames` 8, `pileWindowSlack` 40), `DUNGEON.cacheItems` and `cacheTierWeights`, `FORGE.rolledRuneShare`.
- Server: the open window per member (`openLoot`) in `apps/server/src/room.ts`: `lootOpen` answers at once, `sendLoot` resends on a new `rev` and closes the window (`items: null`) once `lootView` says the pile is gone or out of reach (pickup reach plus 40), and leaving the room closes it, a town rebuild under the same room id too (entity ids belong to the room's world). Another player joining the room does not.
- Client: labels, hover and click pickup in `apps/client/src/game/game.ts`; the window, the preview and their stores in `ui/LootWindow.tsx`, `ui/lootPiles.ts` and `ui/loot.css`; piles drawn as sacks with a tier-coloured tie, coin stacks for rare and relic or gold piles, and a beam, in `apps/client/src/render/entities.ts` (the view is rebuilt when a better drop changes the pile's best tier); minimap dots in `render/minimap.ts`.
- Protocol: `{ t: 'pickup', id, uid? }` takes one item or, without `uid`, everything that fits; `{ t: 'lootOpen', id }` and `{ t: 'lootClose' }`; the server's `{ t: 'lootPile', id, items, own }` (`items` null closes). A pile in a snapshot is `k: 'loot'` with its best tier, item count, its best names (`LootName`: name, tier, `u` for a unique, `c` for a rune stack's count) and gold.
- Loot simulator: `apps/client/src/dev/LootTab.tsx`, `dev/loot/lootStats.ts`.

```ts
interface LootComp { items: Item[]; gold: number; lifetime: number; droppers: Map<ItemUid, DropMark>; rev: number }
interface DropMark { id: EntityId; x: number; y: number } // who dropped the item and where they stood
```

Admin tunables: `lootMergeRadius` (ServerSettings, 0 to 200 world units, default 42; 0 keeps every drop apart) is read at each drop, so a change applies to drops from then on without a deploy; Settings tab, "Loot pile radius". `lootRate` (0 to 20, default 1) multiplies the normal drop chance and the gold chance, and scales rare and boss item counts, up to 24 items a bag. It does not scale gold amounts or the dungeon cache.

Tests:

- `packages/shared/test/drops.test.ts`: `rollDrops` matches the simulation item for item, is deterministic, and handles loot rates of 1, 0, scaled and capped.
- `packages/shared/test/progression.test.ts`: dropped bags scatter so they never stack on one spot.
- `packages/shared/test/itemSafety.test.ts`: no pickup through walls; dev monsters, splitter children and raised monsters pay nothing; the dropper cannot click their own drop back until they step away, another player can take it at once, and gold still goes on walk-over.
- `packages/shared/test/systems.test.ts`: rare enemies drop items to click up and gold to walk over.
- `packages/shared/test/dungeon.test.ts`: the boss clears the run once and opens the cache.
- `packages/shared/test/lootPiles.test.ts`: drops merge inside the radius and stay apart outside it, radius 0 keeps them apart, a live radius change applies, a full pile starts a new one, a join refreshes the clock and an untouched pile despawns, gold stays its own pile and still goes on walk-over; take one then Take all; out of reach refused; two players on the same item and both pressing Take all in the same tick (each item ends in exactly one bag); a pile emptied by someone else or despawned closes the window and refuses takes; the dropper rule per item inside a shared pile; a full bag takes nothing and leaves the item untouched; a partial plain rune take leaves exactly the rest; a 32-item pile sends 8 names best first in under 600 bytes and full items only through the window; a pile out of interest range is not in the snapshot; a save never holds a pile's items.
- `apps/server/test/lootPiles.test.ts`: over the room, the open pile goes only to its viewer, is resent when another player takes from it (and not otherwise), closes when emptied, when the hero walks away and when it despawns; a take from a closed window is refused; opening out of reach is refused.
- `apps/client/test/lootPiles.test.ts`: pile labels (name, count, best colour, Alt and uniques), single items skip the window, the window store ignores answers for another pile, and the hover store writes only when the preview changes.
- `apps/client/test/loot.test.ts`: the loot simulator is deterministic and respects share overrides and item-level affix caps. Its affix table lines tiers up from the weakest to T1, so three-tier and six-tier affixes share the T1 column.

## Limits and open questions

- **A pile's clock** starts again whenever something joins it, so a busy spot keeps its pile longer than 90 s; the alternative was a clock per item.
- **The hover preview** sits beside the cursor rather than anchored to the label, so it can still cover a nearby pile's label while it is up.
- **No icons in the hover preview** yet; the spec allowed them ("maybe small icons").
- `lootRate` does not scale gold amounts, which an admin raising loot for an event might expect.
- The loot simulator does not simulate gold or the dungeon cache.
