# Stash

Status: Live since 2026-09-29 as one 12x10 grid per account. Stash tabs are being built now; this page describes the single stash on `main` and will be updated when tabs land.

## What it does

- **One stash per account,** shared by all its characters, at the chest nearest the town spawn. Click the chest: the hero walks into reach (150 units) and the stash opens beside the bag; walking away closes it.
- **A 12x10 grid** with the same footprints as the bag ([items.md](items.md)). Right-click moves an item between bag and stash; drag places it.
- **The forge reads the stash:** plain runes are taken from the bag first, then the stash, and rolled runes can come from either. A sigil must be in the bag to be inscribed ([forge.md](forge.md)).

## Why

- **Per account,** so characters on one account can pass items to each other.
- **Stored separately from characters and written in one transaction with them.** Every save (room change, disconnect, autosave, shutdown, trades) writes the character and the stash together, so an item moved between bag and stash can never land in neither or both.
- **An unreadable stash refuses the join** instead of being saved over. The row is kept, and nothing is lost until someone looks at it.
- **Bound items cannot go in,** and neither can a sigil holding bound runes, so a new character cannot farm its starter kit for another ([items.md](items.md), "Bound items"). Forge refunds never go to the stash for the same reason.
- **Pending items fill the stash first on load** (never bound ones), then the bag. A character whose items still fit nowhere is told: "N items did not fit in your bag or stash. Make room in the stash and log in again to get them back."
- **Stations open on a click,** after the hero walks into reach, and close when you walk away, as in D2.

## How

- Position: the chest nearest the spawn in `packages/shared/src/world/town.ts` (a town with no chest gets one near the spawn).
- Rules: `packages/shared/src/sim/inventory.ts` (`STASH_REACH` 150, `nearStash`, `moveItem`, `splitStash`, `restoreStash`, `placePending`).
- Storage: the `accounts.stash_json` column; `loadStash`, `saveCharacterAndStash`, `saveMany` in `apps/server/src/accounts.ts`; `persist` and `saveAll` in `apps/server/src/manager.ts`.
- Protocol: `moveItem { uid, to: 'bag' | 'stash', x, y }`; the stash travels in the `inventory` message as a cell array (`stash: (ItemUid | null)[]`).
- Client: `StashWindow` in `apps/client/src/ui/Inventory.tsx`.

Invariants:

- A stash item's uid is reissued on load, like every stored item.
- The stash is only touched while its account's character stands at the chest (or through the forge's plain and rolled rune refs).
- Character and stash rows are written in the same transaction.

Tests:

- `packages/shared/test/grid.test.ts`: the stash needs the chest; split and reload of the stash; items are never lost when bag and stash are full.
- `packages/shared/test/itemSafety.test.ts`: bound items and bound pending items stay out of the stash; the forge refuses a rolled rune in another account's stash.
- `apps/server/test/worlds.test.ts`: an unreadable stash refuses the join and keeps the row.
- `apps/server/test/forge.test.ts`: an inscribe that takes runes from the stash saves stash and character together.

## Stash tabs (in progress)

Being built now, not on `main`. From the work in progress, to be confirmed when it merges:

- General tabs (one free, more bought with character gold, up to 10), plus a rune tab that holds plain runes as counts per rune and a list of rolled runes, and a sigil tab.
- Tab names and colours, Ctrl+click quick move, taking runes out of the rune tab, sorting a tab.
- A one-time conversion of the old single grid into the first tab.

Guild stashes will reuse the tab model ([guilds.md](guilds.md)).

## Limits and open questions

- One grid only, until tabs land.
