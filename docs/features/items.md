# Items and the inventory

Status: Live. The affix engine and sigils since the first build (M3, 2026-09-28); gear, the grid inventory, the trader and bound items since 2026-09-28 and 2026-09-29; rune items and the v1 to v2 conversion pushed to `main` on 2026-09-30. Implicits, ranged rolls and the implicit pass built on `feat/damage-phase2` (2026-10-02), not deployed.

## What it does

- **Four item kinds:** gear, sigils, vessels and runes.
  - **Gear** fills nine slots: weapon, helmet, body, gloves, boots, belt, amulet and two rings. 27 bases, each with a minimum level, implicit stats and sometimes a class restriction.
  - **Sigils** hold runes and cast the spell they spell out; they are the wands of the rune system ([runes.md](runes.md)).
  - **Vessels** hold one minion ([minions.md](minions.md)).
  - **Runes** are the parts of a spell, inscribed at the forge ([forge.md](forge.md)). Plain runes stack 20 to a cell, only with runes of the same implicit; rolled runes carry rune affixes and never stack. A Concentrated rune always drops rolled (its amount is its roll), so it never stacks. Every rune carries an implicit, and some rune affixes roll a range ([runes.md](runes.md), "Implicits and ranged rolls").
- **Tiers:** common, magic, rare, relic. Rares and relics get random two-word names; common and magic items are named from their affixes.
- **Named (unique) items:** an item with `fixedName` keeps a hand-given name and shows it in the unique colour, a worn bronze gold (0xc9a15c, `UNIQUE_COLOR` in `render/config.ts`) set apart from rare yellow and relic orange, in the bag, stash, trader, tooltips and ground labels (the loot snapshot marks it `u`). Its `lore` line shows in italics under the name. So far only vessels carry the fields, and only one item uses them:
  - **Brothers Creation**, the owner's brothers' Hound vessel: relic, the full pack (a Leader and 6 packmates, [minions.md](minions.md)), "Relic Unique Soul Vessel", lore "Made by the brothers.", fixed affixes at the top tier (50% movement speed, 100% life, 35% attack speed, respawns 40% faster; no behaviour affix), 50 spirit, vessel level = item level + 4. Unbound: it can be stashed, traded, dropped and sold like any relic. It exists only through the owner's Grant item tool ([accounts-admin.md](accounts-admin.md)); it never drops.
- **A grid inventory, D2 style:** the bag is 12x8, the account stash 12x10 ([stash.md](stash.md)). Items have footprints: body armour and weapons 2x3, helmets, gloves and boots 2x2, belts 2x1, vessels 1x2, jewellery, sigils and runes 1x1.
- **Pending items** show under the bag ("Pending: N") when something you own fits nowhere. They move in by themselves when room frees up.
- **New items** (picked up, bought, a rune stack that grew) get an ember mark until hovered.
- **Sort** packs the bag on the server: gear by slot, then sigils, vessels, runes; within each, tier, item level and name.
- **The trader** at the stall nearest the town spawn buys anything unbound for gold and sells from one shelf shared by the whole server.
- **Controls:** right-click equips or moves between bag and stash; drag to place; Delete drops the hovered item (rares and relics ask first when the prompt setting is on, see "Sell and drop prompt"). A dropped item lands at your feet, joining a pile there if one is close; you cannot take it back until you step away, others can take it at once ([loot.md](loot.md)).
- **The inventory and trader windows move** like the other framed panels: unlock panels on the HUD and drag them by the title bar; they snap to the screen edges and to each other, and Settings resets them. Positions are kept per browser (`ui/GamePanel.tsx`).

## Why

### Affixes and rolls

- **One affix engine** serves gear, sigils, vessels, runes and rare monsters, with tiers, weights, allowed item kinds and prefix or suffix (SPEC).
- **Affix counts:** common 0, magic 1 to 2, rare 3 to 4, relic 4 to 5, with at most 3 prefixes and 3 suffixes. Affixes in the same group are mutually exclusive, so a vessel has at most one behaviour and a rune at most one release. The one exception is Brothers Creation, a hand-made item only the owner's Grant item tool creates: its four fixed top-tier affixes are all prefixes, which no drop can roll.
- **Item level** is the monster level an item dropped from, and it gates affix tiers. Gear, sigil and vessel affixes have three tiers, numbered from the best (T1): the middle tier from item level 3, the best from 5, and magic items never get the best. Rune affixes have six (T6 to T1), each with its own least item level (1, 2, 3, 5, 8, 12), and common and magic runes stop at T4 ([runes.md](runes.md), "Rolled runes"). Tooltips show the tier from the best (`affixTierLabel`); stored rolls keep an index from the weakest.
- **Level requirement:** item level minus 2, checked on the server when equipping ([characters.md](characters.md)).
- **Corruption:** magic or better sigil drops have an 8% chance. A corrupted sigil gets +1 rune slot and 1.5x misfire chance.
- **Gear drops pick a slot first, then a base,** so drops spread evenly over slots rather than over bases.

### Added damage affixes (2026-10-02, `feat/damage-packets`, not deployed)

- Three rune affixes, "Adds X to 2X fire / cold / lightning damage" (`rune_added_fire`, `rune_added_cold`, `rune_added_lightning`), roll on orb, bolt, nova, zone and dash runes with the six rune tiers (low end 1 to 2 at T6 up to 7 to 9 at T1), the rune tier weights and item-level gates, and price like every rune affix by tier. Each is its own affix group, so a rune may carry a damage roll and any of the adds. Together with the damage roll they keep the damage roll's old drop share: the damage roll drops at half its tier weights and each add at a sixth (`dropShare`, [runes.md](runes.md), "Damage packets").
- **Saves do not change:** a roll still stores one value (the low end; the high end is twice it), so old items load as they are and the rune roll pass, `runes:convert-check` and the seamless-restart snapshot format are unchanged. `runes:convert-check` on a fresh copy of `rune.db.live-pre-restart-20261002` prints the same report before and after the change, all checks passed. A save holding one of the new affixes fails an older build's affix check, so roll back past it with the database copy.

### Implicits and ranged rolls (2026-10-02, `feat/damage-phase2`, not deployed)

- **Every castable rune carries an implicit** (`RuneItem.implicit`, one affix roll of target `implicit`), rolled at drop in six tiers and priced by tier: nothing up to T4, then 1, 2 and 8 gold of sell value for T3, T2 and T1 (`FORGE.runeImplicitValue`). What each one does, the tiers and why are in [runes.md](runes.md), "Implicits and ranged rolls".
- **Plain runes stack by implicit:** a stack holds runes of one rune, binding and implicit (`stacksWith`, `implicitKey`). Plain drops take their tier's middle value, so plain runes of one tier still stack.
- **Ranged rolls** store their low end as the value and their high end as `AffixRoll.max`; the roll prices at the tier it was rolled in, which is the tier of its average.
- **Kits and the builders' bench** carry the neutral roll (the middle of T4).

### Implicit pass (2026-10-02)

Runes stored before implicits carry none. Each row is converted once on load:

- **It runs once per row:** when a character (bag, equipment, sigils, pending items), an account stash (every tab) or the trader shelf loads without `runeImplicits: 1`, after the v1, stash tab and rune roll passes, and the row is written back with the marker. A row with the marker loads exactly as stored. Every write carries the marker (`runeImplicits` is required on `PlayerSave`, `StashSave` and `TraderShelfSave`; the `Stored*` types allow it missing). An admin grant into an offline save from before the marker writes the save as its load converts it, marked, with the new item untouched. Ground loot in a session snapshot goes through it by the snapshot's own marker ([seamless-restart.md](seamless-restart.md)).
- **Every castable rune, loose or in a sigil, gets the neutral roll** (the middle of T4, `neutralImplicit`): what it did before, so it casts, stacks and prices exactly as before. Plain stacks get it whole. Nothing else changes: uids, counts, rolls, names, binding, order, and no item is added or removed. A rune that already has an implicit (written by this build) is left alone, so a second pass changes nothing. Runes the engine cannot run (no implicit table) are left as they are.
- **No gold moves:** the neutral tier adds nothing to a price.
- **Any new kind of storage** (the guild stash being built) must run it on load too: `loadImplicits(raw, items)` from `items/convertImplicits.ts`, after `convertRuneRolls` when the row lacks `runeTiers: 6`, and write `runeImplicits: 1` back.
- `pnpm runes:convert-check <db>` runs the pass on every unmarked row after the earlier passes and checks it: the same items in the same order; every castable rune given the neutral roll and nothing but that field added; the uid multiset and rune counts kept; sell value unchanged; a second pass changing nothing; the server's own load path giving the same items; a marked row loading as stored. On a fresh copy of `rune.db.live-pre-damage-20261002` (no tuning stored): 10 rows, none marked; 228 runes given the neutral roll (184 in sigils, 44 loose items holding 53 runes), after which every rune carries it (counting each rune of a stack: 134 base, 51 conversion, 31 effect, 21 Split, 12 aura, 7 bond, 5 modifier, 2 payload, 1 fuse); sell value of every row 25194 gold before and after; the rune roll pass on the 6 rows not yet at six tiers as before (6 old kits rebuilt, 22 runes re-tiered); all checks passed.

### Grid inventory

- **Grids are flat cell arrays** (one uid per covered cell), so saves barely changed when the grid came in. A save of another size is repacked on load.
- **Nothing is ever dropped to make room.** Anything that fits nowhere stays *pending* with the character. On load, pending items go to the stash first (never bound ones), then the bag. After an inventory action (inscribe, equip, sort, drop, move, sell) they are placed in the bag. Placing tops up matching rune stacks first.
- **Adding to the bag is all or nothing:** a purchase that does not fit tops up no stacks. Ground pickups may take part of a plain rune stack, since they shrink the real ground item. Each item of a ground pile is its own all-or-nothing take, so Take all fills the bag with what fits and leaves the rest in the pile.
- **Inventory edits are commands.** The server resends the whole inventory after every command, so a rejected edit snaps back.
- **Item ids are unique across the server:** each room takes its own block of 2^32 ids, and items coming from a save, the stash or the shelf get fresh uids. A command carrying an id from the room a player just left cannot touch a different item.

### Bound items

- **Bound items** are the starter kit, items given with the dev tools (runes inside dev sigils included), and runes made on the builders' bench. A sigil holding any bound rune counts as bound.
- **Bound items cannot be sold, dropped or put in the account stash,** so a new character cannot farm them for another. They sell for 0, bound runes only stack with bound runes, and they cost nothing to insert at the forge.
- **Starter kit:** the class weapon, up to four of the class's kit sigils (one that would go over spirit goes to the bag), and for Binders a Zombie Brute vessel. All bound. Kit sigils are ordinary sigils with in-table rolls ([runes.md](runes.md), "Kit sigils").

### Trader

- **Location:** the market stall nearest the town spawn (170 units reach, checked on the server). It opens on a click after the hero walks into reach, and closes when you walk away, as in D2. Opening it closes the stash, the forge and the waypoint menu, and a right-click sells only while the trader is the open station ([stash.md](stash.md), "One station window at a time").
- **Sell price:** `max(1, round(TIER_VALUE * (1 + 0.12 * (ilvl - 1))))` with common 4, magic 12, rare 40, relic 150. A rune adds 4, 6, 9, 13, 20 or 60 per affix from T6 to T1 (release affixes 4; the old three tiers were 4, 10 and 25); a rune stack sells for its count; a sigil sells for its own value plus its runes.
- **Buy at 3x,** priced when bought.
- **One shelf for the whole server,** 50 items; the oldest is destroyed when a 51st is sold. If someone else bought an item first, the buyer is told so.
- **Sells on the right-click.** With the prompt setting on (below), a relic asks first (an in-game prompt, not a browser dialog: "Anyone can buy it off the shelf"); everything else always sells on the click.

### Sell and drop prompt

A client setting, Esc, Settings, Items, "Ask before dropping rares and relics, or selling relics", default **off**. The owner asked for it off by default: turned on for safety, off when it gets in the way. It is stored with the other client options in localStorage (`ui/settings.ts`, `confirmValuable`), so it belongs to the browser, not the account.

- **On:** dropping a rare or relic (Delete, the Drop button, dragging it out of the bag, shift+right-click) shows the in-game prompt first; shift+right-click drops on a second shift+right-click. Selling a relic at the trader shows the sell prompt. Commons and magics, and every other sale, go straight through.
- **Off:** every drop and sale happens on the first action.
- The rules are `asksBeforeDrop` and `asksBeforeSelling` in `ui/itemActions.ts`. Bound items never reach either prompt: they cannot be dropped or sold.
- Turning the setting off while a prompt is open leaves that prompt up until it is answered.
- **One transaction per trade:** the shelf, the character and the stash are saved together, and the new shelf goes to everyone in a room with a trader.
- **A trade that cannot be saved does not happen.** The shelf in memory changes only after that transaction commits. If the write throws, the player's bag, item stacks, stash layout and gold go back to exactly what they were before the click (`apps/server/src/tradeRollback.ts`), the shelf keeps the item, and the player sees "The trade could not be saved, so nothing changed". Memory and the database agree again, so a later autosave cannot store one side of the trade alone: after a restart every item is in one place and no gold is made or lost.

### Conversion from v1

v2 replaced v1 runes outright, with no switch and no fallback, because only a handful of characters existed and the conversion is one-way either way.

- **Conversion runs once,** when a character, an account stash or the trader shelf first loads, and marks the data `runeFormat: 2`. Unreadable fields throw, so a row is never half converted.
- **A character that fails to convert keeps its row and cannot join; a stash that fails refuses the join; a shelf that fails stops the server,** so nothing overwrites v1 data.
- Built-in skill sigils become starter sigils with the same uid, tier, affixes, name and binding. Their v1 runes are replaced, not refunded.
- Loose runes map one to one, Link becomes Bond. Linger and Pierce have no v2 rune and are paid at their v1 sell value (12 gold at item level 1, more at higher levels), bound ones too, since this happens once.
- Hand-inscribed sigils keep their runes in their slots even when the result fizzles; runes past the new capacity go to the bag, else pending. Old Test Sigils are taken apart.
- Gold owed for runes in a stash goes to the character that joins, in the same transaction as the converted stash, so it is paid once.
- `pnpm runes:convert-check <db>` copies the database, converts everything in memory and checks every rune, gold coin and uid. On a copy of the live database (2026-09-29): 7 characters, 2 stashes and a 50-item shelf, 95 starter sigils, 3 runes to 36 gold, all checks passed.

### Rune roll pass (2026-10-01)

Three owner decisions changed items players already own: "first rune is free" left the game ("nothing is free"), Multishot and Flame Cleave got new runes ([runes.md](runes.md), "Balance"), and rune affixes got six tiers ([runes.md](runes.md), "Rolled runes").

- **It runs once per row:** when a character (bag, equipment, pending items), an account stash (every tab) or the trader shelf loads without `runeTiers: 6`, after the v1 and stash tab conversions, and the row is written back with the marker. A row with the marker loads exactly as stored. Every write carries the marker (`runeTiers` is required on `PlayerSave`, `StashSave` and `TraderShelfSave`; data read from storage has `Stored*` types where it may be missing), the shelf a sale writes included. An admin grant into an offline save from before the marker writes the save as its load converts it, marked, with the new item, so old items convert once and the grant is never re-tiered by value. Before the six tiers the pass ran on every load with no marker, which was safe because a second pass found nothing; that still holds for its own output, so rows the earlier pass already touched are safe to pass once more. Ground items are not saved, so they never need it.
- **"First rune is free" is removed** from any sigil that has it. The sigil keeps its uid, tier, slots and every other affix. A name carrying its word "Primed" is built again from the remaining affixes (common and magic) or loses the word (rare and relic). The affix was T3 only, so only rares and relics could have it, and their names are rolled; the rename is there for completeness.
- **An old Multishot or Flame Cleave is rebuilt** only while its slots still hold the recipe from before 2026-10-01 exactly: the same runes with the same roll values in the same order, count 1, and no bench runes, on a sigil whose `starter` names it. It becomes today's kit (in-table rolls, [runes.md](runes.md), "Kit sigils"). The leading runes keep their uids and binding and take the new rolls (Flame Cleave's Bolt becomes the Nova; its Fire stays the same item).
- **The rune the new recipe has no room for** (Multishot's second Split, Flame Cleave's Split) goes back to the player when it is unbound, since a split(3) there can be the player's own find and a value match cannot tell: into the bag if it has room, else pending (a character), into the rune tab (a stash; past its cap it goes pending with the next character to join), or onto the shelf as its own entry (the trader). It leaves clamped like any rune leaving a sigil. A bound one is a starter-kit rune that cannot be sold or stashed, and it goes.
- **Anything changed at the forge is left alone,** even by one roll. Old recipe rolls cannot be rebuilt by hand (they are above every drop table and clamp when they leave a sigil), so an old recipe found on load is always an untouched kit.
- **Other kit sigils are not converted** (owner): a kit made before the kits moved into the tables (an old Fireball with +100% damage, a Multishot with +300%) keeps its rolls and casts them. Only their tiers move, as below.
- **Six tiers:** every rune affix roll, loose or in a sigil, moves to the tier its value falls in among the six (`sixTierRoll`, by the code's own table, so tuning on the day of the load cannot move it). Values never change, only the tier and with it the price. Rolls past every table (old kit rolls) land in T1. A value on an end two tiers share counts as the lower one. Sigil, gear and vessel affixes and the release flags keep their tiers.
- **Gold:** a drop's roll never comes out worth 3x what it sold for (the trader's buy multiplier), checked for every value of every old tier, so nothing bought before the deploy sells back for profit. Old kit rolls stored below their value's tier rise once, as the first version of this pass already did to the old T3; on a bound rune that is worth nothing.
- Each change is logged as a `conversion` line naming the sigil uids and the removed and returned rune uids.
- `pnpm runes:convert-check <db>` runs the pass on every unmarked row after the earlier conversions and checks it: same items in the same order; only sigils' names, affixes and slots and runes' roll tiers changed, each tier only to its value's tier among the six; rebuilt sigils hold the new kit and keep their leading uids and binding; the uid multiset loses exactly the reported bound runes, the returned ones come back loose, and no uid is held twice; loose rune counts grow by exactly the returned ones; a second pass changes nothing; no drop roll is worth 3x its old price after the re-tier; and the server's own load path (`AccountStore`) gives the same items. A row already marked must load exactly as stored. It prints the tier moves, the sell value of every row before and after, and how much the unbound old kit rolls rose. On a fresh copy of `rune.db.live-pre-adminui-20261001` (no tuning stored): 10 rows, 127 sigils, no "first rune is free" rolls, 6 Multishots and 4 Flame Cleaves rebuilt (1 bound Split removed, 9 unbound returned), 68 runes re-tiered (from the old low tier: 8 to T1, 15 to T2, 2 to T3, 2 to T4, 8 to T5; 1 from the old middle tier to T4; the old tiers were numbered T1 to T3 from the weakest, so the check prints them as low, middle and top), sell value of every row 22455 gold before and 24226 after, 28 unbound old kit rolls rising once by 690 gold of sell value, 259 items untouched; all checks passed.

## How

Code:

- Grants: `packages/shared/src/items/grants.ts` (`GRANT_TEMPLATES`, `parseGrantRequest`, `createGrantItem`); `createBrothersCreation` and `BROTHERS_CREATION` in `items.ts`.
- Items: `packages/shared/src/items/items.ts` (the `Item` union, `TIER_ROLLS`, `rollAffixes`, `createGear`, `createVessel`, `vesselPackmates`, `createRune`, `createRolledRune`, `sigilCapacity`, `isBound`, `holdsBoundRunes`, `reissueUids`, `STARTER_VESSELS`). Gear bases in `data/gear.ts`, affixes in `data/affixes.ts`. Prices in `items/prices.ts`.
- Grid: `packages/shared/src/items/grid.ts` (`BAG`, `STASH`, footprints, `findSpot`).
- Inventory rules: `packages/shared/src/sim/inventory.ts` (`addItem`, `takeFromGround`, `addOrPend`, `layOut`, `placePending`, `settlePending`, `sortInventory`, `discard`, `moveItem`, `sellItem`, `buyItem`, equip functions, the starter kit).
- Trader shelf: `Market` in `apps/server/src/accounts.ts`, trades in `apps/server/src/manager.ts` (`sell`, `buy`, `saveTrade`), the rollback of a failed trade in `apps/server/src/tradeRollback.ts`.
- Conversion: `packages/shared/src/items/convertV2.ts` (v1 to v2), `items/convertRuneRolls.ts` (the rune roll pass), `items/convertImplicits.ts` (the implicit pass), `scripts/runes-convert-check.ts` (all three).
- Client: `apps/client/src/ui/Inventory.tsx` (bag, stash window, `PendingStrip`, drop and sell prompts), `ui/itemActions.ts`, `ui/parts.tsx` (tooltips), 3D item icons in `ui/itemIconRenderer.ts`.

```ts
type Item = SigilItem | VesselItem | GearItem | RuneItem;
// all: uid, kind, tier, name, ilvl, affixes: AffixRoll[] ({ id, tier, value }), bound?
// SigilItem:  slots: RuneItem[]; corrupted: boolean; starter?: string
// VesselItem: minion: MinionTypeId; level: number; pack?: number (Hound packmates); fixedName?: boolean; lore?: string
// GearItem:   base: string; category: GearCategory
// RuneItem:   rune: RuneId; count: number; bench?: boolean; implicit?: AffixRoll (every castable rune once converted)
// AffixRoll:  max?: number (a ranged roll's high end; `value` is the low end)
```

The new vessel fields are optional, so every existing vessel, save, stash and shelf reads as before; a Hound vessel without `pack` counts as one packmate. The v1 conversion never meets them (v1 had no Hounds), and saves carry them through untouched since items are stored as written.

Invariants:

- An item is in exactly one place: one grid, one equipment slot, one sigil slot, or pending.
- A refused command changes nothing.
- No bound item, and no sigil holding a bound rune, ever reaches the stash or the shelf.
- A character, its stash and (for trades) the shelf are written in one transaction.
- A trade whose write fails changes nothing, in memory or on disk.

Admin tunables: the loot rate ([loot.md](loot.md)). Prices, stack size and grid sizes are code constants.

Tests:

- `packages/shared/test/itemSafety.test.ts`: all-or-nothing purchases, rune stack prices, bound items stay with the character, bound pending items never reach the stash, no pickup through walls, room uid ranges, fresh uids for stash and shelf, and the forge rules.
- `packages/shared/test/grid.test.ts`: footprints, column fill, partial pickup, swap in place, old 20-slot saves repacked with spill to the stash, the stash needs the chest, items never lost when bag and stash are full.
- `packages/shared/test/gear.test.ts`: starter weapon, bases respect item level and slot, even spread over slots, gear survives room moves.
- `packages/shared/test/sortInventory.test.ts`, `trader.test.ts`: sort order; selling to the shared shelf, starter items refused, stall reach, buying a fresh copy at 3x.
- `packages/shared/test/convertV2.test.ts`, `apps/server/test/convertV2.test.ts`: every conversion case, idempotency, unreadable data refused, refunds paid once.
- `packages/shared/test/convertRuneRolls.test.ts`, `apps/server/test/runeRolls.test.ts`: the rune roll pass: no drop rolls the retired affix, a "Primed" name is rebuilt, rebuilt sigils keep uids and binding and get honest tiers, an unbound extra rune (the player's own split(3) too) comes back and a bound one goes, edited sigils left alone, the uid multiset is kept except the bound removed runes, a second pass changes nothing, and characters (returned runes in the bag), pending items, stashes (rune tab) and the shelf (a new entry) convert on load and are written back converted; an old kit sigil keeps its values, uids, binding and order and only its tiers move, a range tuned before the load does not move them, and a save written back with `runeTiers: 6` loads byte-identical, even with tiers that disagree with their values.
- `packages/shared/test/convertImplicits.test.ts`, `apps/server/test/implicitsLoad.test.ts`: the implicit pass: every castable rune (loose, in sigils, plain stacks) gets the neutral roll and nothing else changes, no gold moves, a second pass and runes that have one are left alone, old kits are still rebuilt first; characters, stashes and the shelf convert on load and are written back marked, a marked row loads as stored, a grant into an old save writes it converted with the grant untouched. `packages/shared/test/implicits.test.ts`: implicit prices and stacks ([runes.md](runes.md)).
- `apps/server/test/addedDamageRunes.test.ts`: a save with old runes and runes with added damage loads, casts and saves back with every roll unchanged; `packages/shared/test/damagePackets.test.ts`: the affixes drop on shape runes, never beside a damage roll, and read back as the grammar sets them.
- `packages/shared/test/affixTuning.test.ts`: the six rune tiers and the re-tier by value, with the 3x gold check over every old roll.
- `apps/client/test/itemActions.test.ts`, `itemView.test.ts`: right-click equip, drop fit, foreign drag data rejected, tooltips, bag clicks routed only to the open station.
- `apps/client/test/stations.test.ts`: one station window at a time, the editor and the character sheet with them, which station takes the bag's clicks.
- `apps/server/test/tradeAtomic.test.ts`: a buy, a rune buy that topped up a stack, and a sale whose shelf write fails inside the transaction (an injected SQLite trigger) change nothing; after a later autosave and a restart each item is in exactly one place and the gold is unchanged; a trade after a failed one saves normally; successful trades conserve every item and coin across a restart.
- `apps/server/test/grants.test.ts`: a grant adds exactly one item with a uid above every uid in the save, unbound, and it reaches the character on the next login once, with every other item unchanged; nothing is written on a refusal.

## Limits and open questions

- `fixedName` and `lore` exist on vessels only; other kinds get them with the first unique of their kind. Uniques that bend the rules (fixed, hand-made affixes with special effects) are planned; see [runes.md](runes.md), "Planned".
- `LOOT.inventorySize` (20) is left over from the old 20-slot bag and unused.
