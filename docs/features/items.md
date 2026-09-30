# Items and the inventory

Status: Live. The affix engine and sigils since the first build (M3, 2026-09-28); gear, the grid inventory, the trader and bound items since 2026-09-28 and 2026-09-29; rune items and the v1 to v2 conversion pushed to `main` on 2026-09-30.

## What it does

- **Four item kinds:** gear, sigils, vessels and runes.
  - **Gear** fills nine slots: weapon, helmet, body, gloves, boots, belt, amulet and two rings. 27 bases, each with a minimum level, implicit stats and sometimes a class restriction.
  - **Sigils** hold runes and cast the spell they spell out; they are the wands of the rune system ([runes.md](runes.md)).
  - **Vessels** hold one minion ([minions.md](minions.md)).
  - **Runes** are the parts of a spell, inscribed at the forge ([forge.md](forge.md)). Plain runes stack 20 to a cell; rolled runes carry rune affixes and never stack.
- **Tiers:** common, magic, rare, relic. Rares and relics get random two-word names; common and magic items are named from their affixes.
- **A grid inventory, D2 style:** the bag is 12x8, the account stash 12x10 ([stash.md](stash.md)). Items have footprints: body armour and weapons 2x3, helmets, gloves and boots 2x2, belts 2x1, vessels 1x2, jewellery, sigils and runes 1x1.
- **Pending items** show under the bag ("Pending: N") when something you own fits nowhere. They move in by themselves when room frees up.
- **New items** (picked up, bought, a rune stack that grew) get an ember mark until hovered.
- **Sort** packs the bag on the server: gear by slot, then sigils, vessels, runes; within each, tier, item level and name.
- **The trader** at the stall nearest the town spawn buys anything unbound for gold and sells from one shelf shared by the whole server.
- **Controls:** right-click equips or moves between bag and stash; drag to place; Delete drops the hovered item (rares and relics ask first). A dropped item lands as a bag at your feet that you cannot click back up until you step away; others can take it ([loot.md](loot.md)).

## Why

### Affixes and rolls

- **One affix engine** serves gear, sigils, vessels, runes and rare monsters, with tiers, weights, allowed item kinds and prefix or suffix (SPEC).
- **Affix counts:** common 0, magic 1 to 2, rare 3 to 4, relic 4 to 5, with at most 3 prefixes and 3 suffixes. Affixes in the same group are mutually exclusive, so a vessel has at most one behaviour and a rune at most one release.
- **Item level** is the monster level an item dropped from, and it gates affix tiers: T2 from item level 3, T3 from 5. The tier's own cap also applies, so magic items never get T3.
- **Level requirement:** item level minus 2, checked on the server when equipping ([characters.md](characters.md)).
- **Corruption:** magic or better sigil drops have an 8% chance. A corrupted sigil gets +1 rune slot and 1.5x misfire chance.
- **Gear drops pick a slot first, then a base,** so drops spread evenly over slots rather than over bases.

### Grid inventory

- **Grids are flat cell arrays** (one uid per covered cell), so saves barely changed when the grid came in. A save of another size is repacked on load.
- **Nothing is ever dropped to make room.** Anything that fits nowhere stays *pending* with the character. On load, pending items go to the stash first (never bound ones), then the bag. After an inventory action (inscribe, equip, sort, drop, move, sell) they are placed in the bag. Placing tops up matching rune stacks first.
- **Adding to the bag is all or nothing:** a purchase that does not fit tops up no stacks. Ground pickups may take part of a rune stack, since they shrink the real ground item.
- **Inventory edits are commands.** The server resends the whole inventory after every command, so a rejected edit snaps back.
- **Item ids are unique across the server:** each room takes its own block of 2^32 ids, and items coming from a save, the stash or the shelf get fresh uids. A command carrying an id from the room a player just left cannot touch a different item.

### Bound items

- **Bound items** are the starter kit, items given with the dev tools (runes inside dev sigils included), and runes made on the builders' bench. A sigil holding any bound rune counts as bound.
- **Bound items cannot be sold, dropped or put in the account stash,** so a new character cannot farm them for another. They sell for 0, bound runes only stack with bound runes, and they cost nothing to insert at the forge.
- **Starter kit:** the class weapon, up to four class starter sigils (one that would go over spirit goes to the bag), and for Binders a Zombie Brute vessel. All bound.

### Trader

- **Location:** the market stall nearest the town spawn (170 units reach, checked on the server). It opens on a click after the hero walks into reach, and closes when you walk away, as in D2.
- **Sell price:** `max(1, round(TIER_VALUE * (1 + 0.12 * (ilvl - 1))))` with common 4, magic 12, rare 40, relic 150. A rune adds 4, 10 or 25 per affix by affix tier; a rune stack sells for its count; a sigil sells for its own value plus its runes.
- **Buy at 3x,** priced when bought.
- **One shelf for the whole server,** 50 items; the oldest is destroyed when a 51st is sold. If someone else bought an item first, the buyer is told so.
- **Only relics ask before selling** (an in-game prompt, not a browser dialog: "Anyone can buy it off the shelf"). Everything else sells on the right-click.
- **One transaction per trade:** the shelf, the character and the stash are saved together, and the new shelf goes to everyone in a room with a trader.

### Conversion from v1

v2 replaced v1 runes outright, with no switch and no fallback, because only a handful of characters existed and the conversion is one-way either way.

- **Conversion runs once,** when a character, an account stash or the trader shelf first loads, and marks the data `runeFormat: 2`. Unreadable fields throw, so a row is never half converted.
- **A character that fails to convert keeps its row and cannot join; a stash that fails refuses the join; a shelf that fails stops the server,** so nothing overwrites v1 data.
- Built-in skill sigils become starter sigils with the same uid, tier, affixes, name and binding. Their v1 runes are replaced, not refunded.
- Loose runes map one to one, Link becomes Bond. Linger and Pierce have no v2 rune and are paid at their v1 sell value (12 gold at item level 1, more at higher levels), bound ones too, since this happens once.
- Hand-inscribed sigils keep their runes in their slots even when the result fizzles; runes past the new capacity go to the bag, else pending. Old Test Sigils are taken apart.
- Gold owed for runes in a stash goes to the character that joins, in the same transaction as the converted stash, so it is paid once.
- `pnpm runes:convert-check <db>` copies the database, converts everything in memory and checks every rune, gold coin and uid. On a copy of the live database (2026-09-29): 7 characters, 2 stashes and a 50-item shelf, 95 starter sigils, 3 runes to 36 gold, all checks passed.

## How

Code:

- Items: `packages/shared/src/items/items.ts` (the `Item` union, `TIER_ROLLS`, `rollAffixes`, `createGear`, `createVessel`, `createRune`, `createRolledRune`, `sigilCapacity`, `isBound`, `holdsBoundRunes`, `reissueUids`, `STARTER_VESSELS`). Gear bases in `data/gear.ts`, affixes in `data/affixes.ts`. Prices in `items/prices.ts`.
- Grid: `packages/shared/src/items/grid.ts` (`BAG`, `STASH`, footprints, `findSpot`).
- Inventory rules: `packages/shared/src/sim/inventory.ts` (`addItem`, `takeFromGround`, `addOrPend`, `layOut`, `placePending`, `settlePending`, `sortInventory`, `discard`, `moveItem`, `sellItem`, `buyItem`, equip functions, the starter kit).
- Trader shelf: `Market` in `apps/server/src/accounts.ts`, trades in `apps/server/src/manager.ts` (`saveTrade`).
- Conversion: `packages/shared/src/items/convertV2.ts`, `scripts/runes-convert-check.ts`.
- Client: `apps/client/src/ui/Inventory.tsx` (bag, stash window, `PendingStrip`, drop and sell prompts), `ui/itemActions.ts`, `ui/parts.tsx` (tooltips), 3D item icons in `ui/itemIconRenderer.ts`.

```ts
type Item = SigilItem | VesselItem | GearItem | RuneItem;
// all: uid, kind, tier, name, ilvl, affixes: AffixRoll[] ({ id, tier, value }), bound?
// SigilItem:  slots: RuneItem[]; corrupted: boolean; starter?: string
// VesselItem: minion: MinionTypeId; level: number
// GearItem:   base: string; category: GearCategory
// RuneItem:   rune: RuneId; count: number; bench?: boolean
```

Invariants:

- An item is in exactly one place: one grid, one equipment slot, one sigil slot, or pending.
- A refused command changes nothing.
- No bound item, and no sigil holding a bound rune, ever reaches the stash or the shelf.
- A character, its stash and (for trades) the shelf are written in one transaction.

Admin tunables: the loot rate ([loot.md](loot.md)). Prices, stack size and grid sizes are code constants.

Tests:

- `packages/shared/test/itemSafety.test.ts`: all-or-nothing purchases, rune stack prices, bound items stay with the character, bound pending items never reach the stash, no pickup through walls, room uid ranges, fresh uids for stash and shelf, and the forge rules.
- `packages/shared/test/grid.test.ts`: footprints, column fill, partial pickup, swap in place, old 20-slot saves repacked with spill to the stash, the stash needs the chest, items never lost when bag and stash are full.
- `packages/shared/test/gear.test.ts`: starter weapon, bases respect item level and slot, even spread over slots, gear survives room moves.
- `packages/shared/test/sortInventory.test.ts`, `trader.test.ts`: sort order; selling to the shared shelf, starter items refused, stall reach, buying a fresh copy at 3x.
- `packages/shared/test/convertV2.test.ts`, `apps/server/test/convertV2.test.ts`: every conversion case, idempotency, unreadable data refused, refunds paid once.
- `apps/client/test/itemActions.test.ts`, `itemView.test.ts`: right-click equip, drop fit, foreign drag data rejected, tooltips.

## Limits and open questions

- If the SQLite write in a trade throws after a buy and a later save succeeds, the item can exist twice after a restart (older than the rune rework).
- Uniques (fixed, hand-made affixes that bend the rules) are planned; see [runes.md](runes.md), "Planned".
- `LOOT.inventorySize` (20) is left over from the old 20-slot bag and unused.
- Stash tabs are being built; see [stash.md](stash.md).
