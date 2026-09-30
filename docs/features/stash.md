# Stash

Status: one 12x10 grid per account live since 2026-09-29; stash tabs built 2026-09-30, not deployed yet.

## What it does

- **One stash per account,** shared by all its characters, at the chest nearest the town spawn. Click the chest: the hero walks into reach (150 units) and the stash opens beside the bag; walking away closes it. The window moves by its title bar when panels are unlocked, like the bag; the tab bar sits below the title bar, so clicking a tab never starts a drag.
- **Tabs:**
  - **General tabs:** 12x10 grids with the same footprints as the bag ([items.md](items.md)). An account starts with 1; more are bought at the chest with the buying character's gold, up to 10. Each can be renamed (1 to 16 characters) and given one of 8 muted colours.
  - **Rune tab:** a list of up to 1000 rune items, plain stacks (still 20 each) and rolled runes, sortable by rune, kind, tier, item level or an affix value, and filterable by rune, kind, tier and affix text.
  - **Sigil tab:** a list of up to 200 sigils, sortable by tier, item level, slots or name, filterable by tier, blank or inscribed, and starter; each row shows the wand stats and the spell's sentence.
- **Moving:** drag and drop into and between tabs. Ctrl+click (Cmd+click on macOS) or right-click in the bag sends an item to the tab that takes it: runes to the rune tab, sigils to the sigil tab, anything else to the open general tab if it has room, else the first general tab that does. The same click in the stash sends it back to the bag. Shift+click on a plain stack in the stash takes part of it.
- **Sort** per tab: general tabs pack in the bag's sort order; the lists sort by the chosen key.
- **The forge reads the stash:** plain runes come from the bag first (bound stacks first), then the rune tab, then general tabs; rolled runes can come from the bag or anywhere in the stash. A sigil must be carried to be inscribed ([forge.md](forge.md)).

## Why

- **Per account,** so characters on one account can pass items to each other.
- **A list for runes, not fixed slots per rune.** The first version had one slot per rune holding up to 500; it was replaced because runes are planned to stop stacking (every rune its own item with its own base roll, see [runes.md](runes.md)), and a list with sort and filter handles both.
- **Tabs cost gold** (250 for the second, then 250 more each: 2250 for the tenth, 11,250 for all nine extra), a gold sink that lasts the whole game. A normal monster drops about 1.4 gold per monster level, so the second tab is about 18 normal gold drops at level 10.
- **Stored separately from characters and written in one transaction with them.** Every save (room change, disconnect, autosave, shutdown, trades) writes the character and the stash together, so an item moved between bag and stash can never land in neither or both.
- **An unreadable stash refuses the join** instead of being saved over. The row is kept, and nothing is lost until someone looks at it.
- **Bound items cannot go in,** and neither can a sigil holding bound runes, so a new character cannot farm its starter kit for another ([items.md](items.md), "Bound items"). Forge refunds never go to the stash for the same reason.
- **One character per account is in the world at a time:** a join first saves and closes the account's other session, and only then loads the stash, so two sessions can never race on it.
- **Stations open on a click,** after the hero walks into reach, and close when you walk away, as in D2.
- **One station window at a time.** Opening the stash, the trader, the forge or a waypoint menu closes the others, and the stash and trader also close the character sheet (they take its side of the screen; on 1600x900 there is no spot for all three beside the bag). The chest can sit inside the trader's reach, so being in reach decides nothing: the bag's right-click and Ctrl/Cmd+click go only to the open station (`activeStation` in `apps/client/src/ui/stations.ts`), so a right-click at the chest never sells. Escape, the bag's close button or I closes the station for real; the next I opens only the bag.

## How

- Position: the chest nearest the spawn in `packages/shared/src/world/town.ts`.
- Save shape: `packages/shared/src/items/stash.ts`:

```ts
interface GeneralTab { kind: 'general'; id: number; name: string; color: StashColorId; cells: (ItemUid | null)[] }
interface RuneTab { kind: 'runes'; list: ItemUid[] }   // up to 1000
interface SigilTab { kind: 'sigils'; list: ItemUid[] } // up to 200
interface StashLayout { stashFormat: 2; general: GeneralTab[]; runes: RuneTab; sigils: SigilTab }
interface StashSave extends StashLayout { runeFormat: 2; items: Item[] }
```

- Prices and caps: `packages/shared/src/config/stash.ts`.
- Rules: `packages/shared/src/sim/inventory.ts` (`STASH_REACH` 150, `nearStash`, `moveItem`, `quickMove`, `takeRunes`, `sortStash`, `buyStashTab`, `editStashTab`, `splitStash`, `restoreStash`, `placePending`).
- Protocol (`protocol/messages.ts`, validated in `protocol/validate.ts`): `moveItem { uid, to }` where `to` is a bag cell, a tab cell, `runes` or `sigils`; `quickMove { uid, tab }`; `takeRunes { uid, count, to }`; `sortStash { tab, key, affix }`; `buyStashTab`; `editStashTab { tab, name, color }`. The `inventory` message carries `stash: StashLayout` and `stashTabPrice`.
- Storage: `accounts.stash_json`; `loadStash`, `saveCharacterAndStash`, `saveMany` in `apps/server/src/accounts.ts`; `persist` and `saveAll` in `apps/server/src/manager.ts`.
- Conversion: on load, a v1 rune stash goes through the rune conversion, then a single-grid stash becomes tabs: the grid is tab 1 with every position kept, unbound runes and sigils move to their lists whole (every uid kept). `pnpm runes:convert-check <db>` checks both steps; on the live copy from before the rune deploy, both stashes converted and all checks passed.
- Client: the stash window in `apps/client/src/ui/Inventory.tsx`.

Rules every operation keeps:

- The player is at the chest; everything is checked before anything changes, and a refusal changes nothing.
- A plain stack moved to the rune tab first tops up stacks of the same rune; only what is left needs a new row, refused when the list is full.
- Pending items on load: unbound plain runes top up bag stacks, then rune tab stacks, then take a rune tab row; rolled runes go to the rune list and sigils to the sigil list; everything else to the first general tab with room, then the bag. Bound items only ever go to the bag.
- A layout naming a uid twice, a bound item, a list past its cap or a stack over 20 leaves the item unplaced, as pending with the character, never dropped.
- A stash item's uid is reissued on load, like every stored item.

Tests:

- `packages/shared/test/stashConservation.test.ts`: 8 seeds of mixed stash operations with inscribes, pickups and reloads, including near-cap runs; item and rune counts, gold, one place per uid, nothing bound in the stash, stacks of 20 or less, list caps, and refusals that change nothing.
- `packages/shared/test/grid.test.ts`, `itemSafety.test.ts`: the chest, bound items staying out, full bag and stash.
- `apps/server/test/`: a tab purchase and a move in one session, then a join with a second character sees the item exactly once and ignores the closed session; an unreadable stash refuses the join; forge draws save stash and character together; a v1-era stash row loads through both conversions.

## Limits and open questions

- General tabs are only bought, never sold back.
- The rune tab still holds plain stacks of 20; it is ready for runes that no longer stack.
- Guild stashes will reuse the tab model ([guilds.md](guilds.md)).
