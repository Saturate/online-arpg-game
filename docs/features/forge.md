# Forge

Status: Pushed to `main` on 2026-09-30 with the rune rework (commits `0f1ec98`, `733906b`, `7dd03eb`, `d5700c0`, `d4e3282`). The first forge (plain runes into sigils) went live on 2026-09-29.

## What it does

The forge is where sigils are inscribed: you put rune items into a sigil's slots, left to right, and the sigil casts the spell they spell out ([runes.md](runes.md)).

- **Where:** the weapon rack nearest the town spawn, marked with a campfire and a gold "Forge" label. Click it: the hero walks into reach and the forge opens straight into the sigil editor, with the bag. Walking away closes it. K toggles the editor while you stand at the forge; elsewhere it says "Sigils are inscribed at the forge in town".
- **The editor** has three columns:
  - **Sigils:** equipped (with their key 1 to 4), then the bag, then the stash. Stash sigils are shown locked. Each shows `slots/capacity` and the starter it still matches.
  - **Slots:** read left to right, one cell per slot, each with the rune's two-letter glyph, its name, and marks for rolled, bound, weakens, from stash and the gold price. Click a slot to take the rune out, drag to reorder, drag back to the pool to remove.
  - **Rune pool:** the plain and rolled runes you own in the bag and the stash, filtered by kind (Shapes, Infusions, Shapers, Effects, Triggers, Modifiers). Runes this draft took out show again so they can go back in for free.
- **The readout** shows the spell as a sentence ("Fires a slow cold orb...") and as a bracket view, the Force per cast (or spirit reserved for a persistent skill), the most entities alive at once, and compiler notes. A broken spell names each error by slot and rule, and says how much Force each fizzle costs.
- **A training dummy preview** casts the draft every 1.4 s at a dummy 260 units away and shows damage per second averaged over 4 s.
- **Cost:** the save button reads "Inscribe for N gold". Runes kept or taken out are free. A draft that fizzles can still be saved; the button says "Inscribe anyway (fizzles)".
- **Warnings before you save:** runes that come back out, runes going to pending because the bag is full, and runes that will weaken on the way out ("Orb: +100% damage becomes +55%").

## Why

- **A sigil holds whole rune items,** so a rune comes out exactly as it went in: the same uid, rolls and binding. The only exception is clamping (below).
- **Everything is checked before anything moves.** A refused inscribe changes nothing, so a half-applied edit cannot lose or duplicate a rune.
- **The message carries the slot uids the client drafted from** (`base`). If the sigil changed since, the server refuses with "The sigil changed; look again". A double click cannot apply a draft to the wrong slots.
- **The server sends the new inventory first, then the `inscribed` reply.** Until the new slots are on screen, a second click would resend a draft made against the old ones.
- **Source order for plain runes:** the bag first, bound stacks first, then the stash's rune tab, then its general tabs. Bound runes are spent before unbound ones because they have no other use.
- **Runes left out go back to the bag, or to pending when it is full, never to the stash.** The stash is the account's, and a bound rune must not reach it.
- **Price:** each inserted rune costs its sell value (factor `insertPriceFactor` 1). Taking a rune out is free. Any factor is safe against minting, because a sigil sells for no more than its runes' sell values on top of its own.
- **Bound runes cost nothing to insert:** they cannot be sold, so a price protects nothing, and a new character with no gold must be able to put its starter runes back.
- **Only at the forge, and not for a sigil in the stash:** a sigil in the shared stash could carry bound runes to another character. Saving an unchanged draft is allowed anywhere, since nothing moves.
- **Persistent skills check spirit:** an equipped sigil's new spell is compiled on trial, and the inscribe is refused if its reservation does not fit.

### Rolls clamp on the way out

Starter runes hold rolls no drop can have (Fireball's Orb has +100% damage, Frozen Orb pulses every 0.18 s). They keep them inside a sigil, and the sigil casts its starter's live recipe numbers while it holds that starter's runes in order, any rolls (`holdsStarterRecipe`, `castingSlots` in `items/items.ts`; [runes.md](runes.md), "The starter rule"). Kept alone, reordered or beside other runes, every rune casts with its rolls clamped as below, and the readout says which runes do; putting the starter back together restores it. A whole starter's slots show the live numbers on hover; the weakening warning reads the stored rolls, since those are what come out. Multishot's Bolt alone at +300% damage dealt 2.85x the best starter's damage per Force. Any rune leaving a sigil has each affix clamped into the range its affix can roll, and the forge warns first. Otherwise a dropped or unbound starter sigil would hand out runes better than any roll.

- The range is the lowest to highest value over the affix's tiers that can drop.
- Most affixes clamp down to the best value. "Every X s" clamps to the shortest rollable interval (lower is better), and "after X s" moves to the nearest end of its table.
- Starter rolls carry the tier their value falls in (`honestTier` in `items/runeRolls.ts`): the lowest tier whose range holds it, the top tier when it is above every drop, the bottom one for a drawback. So Multishot's split(5) is a tier 3 roll inside the sigil and out of it, and sells and prices as one. Before 2026-10-01 every starter roll was tier 0; the load pass re-tiers any roll stronger than its own tier ([items.md](items.md), "Rune roll pass").
- The tier only ever goes down on the way out (`Math.min(a.tier, range.max.tier)`), so a rune never comes out worth more than it counted for inside.
- Values inside the table, or weaker than it (the negative speeds of slow orbs), are left alone.
- Example: Fireball's `orb[+100% damage]` comes out as +55%, the top of the T3 `rune_damage` range (35 to 55).

### The builders' bench

The free test bench left the Arena, where it would be cheating ([arena.md](arena.md)). Builders open a private flat room with `/sandbox` (again, or the town portal, to leave) that has the bench and the F3 dev tools, with no waves, so it is not a private farm.

- On the bench plain runes are free and made fresh, bound and marked `bench`. No stack is spent and the reach check is skipped. Rolled runes still come from your bag or stash, for free.
- **Bench runes exist only inside a sigil.** Whenever one leaves a sigil, at the bench or at a real forge, it is gone. Real runes, including bound starter runes and bound rolled runes, always come back.
- Because bench runes are bound, the sigil holding them is bound too, so it cannot be sold, dropped or stashed ([items.md](items.md), "Bound items").

## How

Code:

- Client editor: `apps/client/src/ui/ForgeEditor.tsx`, the draft model in `apps/client/src/ui/forge/draft.ts` (`resolveDraft`, `buildPool`, `plainRef`, `refundOverflow`), the dummy in `ui/forge/preview.ts` and `ui/forge/PreviewCanvas.tsx`, styles in `ui/forge.css`. Opening and closing: `apps/client/src/game/game.ts` (`walkToStation`, the reach check each step).
- Server rules: `inscribe()` in `packages/shared/src/sim/inventory.ts`, called from `Simulation` and from `apps/server/src/room.ts`, which passes whether the player may use the bench.
- Prices: `packages/shared/src/items/prices.ts` (`forgeInsertPrice`, `runeValue`, `sellPrice`).
- Clamping: `packages/shared/src/items/runeRolls.ts` (`clampRuneRolls`, `clampRoll`, `rollRange`, `rollLosses`).
- Forge position: `packages/shared/src/world/town.ts` (the `weaponrack` nearest the spawn; a town with none gets one near the spawn), copied to the map's `forge` field in `world/maps.ts`.
- Sandbox: `toggleSandbox` in `apps/server/src/manager.ts` makes a flat room with `RoomRules { bench: true, waves: false }`. `editorAllowed` is `rules.bench && arena === null` in `sim/simulation.ts`.

The protocol, from `packages/shared/src/protocol/messages.ts`:

```ts
type RuneRef =
  | { from: 'keep'; index: number }      // the rune now in slot `index`; each index once
  | { from: 'plain'; rune: RuneId }      // bag first (bound stacks first), then the stash
  | { from: 'rolled'; uid: ItemUid };    // from the bag or the stash; each uid once

{ t: 'inscribe'; uid: ItemUid; base: ItemUid[]; slots: RuneRef[]; attempt: number }
{ t: 'inscribed'; uid: ItemUid; attempt: number; ok: true } | { ...; ok: false; error: string }
```

`parseClientMessage` caps `slots` and `base` at `SIGIL_MAX_SLOTS` (10) and rejects repeated keep indices, rolled uids and `base` entries. The client ignores replies for any attempt but its latest, and frees the button after 5 s if a reply is lost.

Server checks, in order: the sigil is yours; it is in the bag or equipped (not the stash); `base` matches; no rune fills two slots; an unchanged draft returns early; you are at the forge (or on the bench); the count fits the sigil's capacity; every ref resolves to a castable rune you own; you have the gold; an equipped persistent skill fits your spirit.

Numbers:

| Constant | Value | Where |
|---|---|---|
| `FORGE.insertPriceFactor` | 1 | `config/forge.ts` |
| `FORGE_REACH` | 170 units (the client uses 160, so latency cannot leave a request just out of range) | `sim/inventory.ts` |
| Rune sell value | `max(1, round(TIER_VALUE[tier] * (1 + 0.12 * (ilvl - 1))))` plus `runeAffixValue` [4, 10, 25] per affix by tier; `TIER_VALUE` common 4, magic 12, rare 40, relic 150 | `items/prices.ts`, `config/forge.ts` |
| Dummy preview | cast every 1.4 s, DPS over 4 s, dummy at 260 units | `ui/forge/preview.ts` |

Saving: the forge does not write to the database itself. Every save writes the character and the account stash in one SQLite transaction, so a rune moved between them cannot land in neither ([stash.md](stash.md)).

Tests:

- `packages/shared/test/forgeConservation.test.ts`: 250-step random inscribe runs on 12 seeds (normal, full bag, bench). Runes only move; gold drops by exactly the price of what went in; a refusal changes nothing; no uid is in two places; slots stay within capacity; no bound item reaches the stash; the only roll change allowed is a clamp that is no stronger; a stale `base` is refused.
- `packages/shared/test/itemSafety.test.ts`: source order, rolled runes once each, another character's stash refused, refunds never to the stash, all or nothing, prices, the stash sigil and reach refusals, bench behaviour, a found rune leaving a bound starter sigil comes back unbound, a spirit refusal changes nothing, 0 gold can still put a bound starter rune back.
- `packages/shared/test/forge.test.ts`: bag then stash, refunds, refusals away from the forge, bench only on test maps, bound starter runes handed back, rolled runes come out whole, an unchanged save is free anywhere.
- `apps/server/test/forge.test.ts`: taking runes from the account stash charges exactly the insert prices and saves stash and character together; inventory is sent before the reply, and a resend drafted from old slots is refused.
- `apps/client/test/forgeDraft.test.ts`: the client's draft mirrors the server (pool counts, source order, prices, refunds, overflow, clamped refunds, bench runes left out).

## Limits and open questions

- **The rune trader is not built.** Planned: a town NPC whose stock refreshes on a timer (30 minutes in the plan, marked open), mostly plain common runes at low prices and now and then one rolled rare at a high price. The owner decided the stock is shared server-wide: a rare appears for everyone with a chat line, and the first buyer gets it. With the forge it is a gold sink, which the economy needs once selling stacks is priced by count.
- The plan said "each saved change costs gold, scaled by the rune count and tier". What was built charges only inserted runes, by sell value; reorders and removals are free.
- The forge only takes castable runes. Phase 4 runes cannot be inscribed until the engine runs them ([runes.md](runes.md)).

## Planned: forge redesign (owner, 2026-09-30)

"Much more exploratory and not handholdy. Place a sigil, put in runes, see if it works or not, click inscribe and it will produce it if it can. If it's not valid it will show that. Make it cool with particle effects in the UI when clicking, game like."

- **Socket:** an anvil or altar where the player drags a sigil; its rune slots light up around it.
- **Building:** runes dragged in and out freely while drafting. The only live signal: working runes glow steady, a broken chain flickers or dims from where it breaks. No rule text, sentence or bracket view while building.
- **Inscribe:** runic sparks and embers flow into the sigil, with a sound. If it would fizzle: sparks die, the sigil cracks briefly, one short line says why (the grammar's error). Nothing is spent on a fizzle and a fizzling spell is not saved (replaces today's "Inscribe anyway").
- **After a successful inscribe** the sentence shows as the sigil's reading and stays in its tooltip; the bracket view and details sit behind a small "Study" toggle.
- **Kept:** the gold price on the button, the weakening warning for out-of-table runes, the dummy preview behind a "Test" button.
- **A shared UI particle layer** (canvas over the panels, dark and ember-toned) reusable by other panels.
- **Fused runes (owner decision, revised):** runes already in a sigil are fused and can never be taken out or moved. A sigil with open slots can be added to: new runes go into the open slots after the fused ones (slots read left to right, so adding is appending). Nothing is spent while experimenting, only on a successful Inscribe (the new runes and gold); the result must compile or the Inscribe is refused and nothing changes.
- **Smashing:** at the forge, destroy an inscribed sigil (in-game confirmation, never a browser dialog). Each rune survives independently with a chance set on the admin page (default 10%). Survivors go to the bag, else pending; out-of-table rolls are clamped as on any extraction; bound runes stay bound; bench runes never survive. The sigil shatters with sparks, survivors fly out.
- **Applies to starter sigils too;** existing sigils with runes on live count as inscribed.
- **Drops:** a sigil can drop blank, partly inscribed (some fused runes and open slots, for example 1 taken and 5 open; the fused part starts with a readable prefix such as a shape, maybe an infusion or a release) or full (the starter spells). Shares in config.
- **Starter sigils get one open slot** beyond their runes so a new character can append at the forge from level 1 (owner confirmed 2026-10-01).
- **Appending keeps a starter's numbers (owner, 2026-10-01):** a starter keeps its hand-set rolls while it holds its full recipe in order, and runes appended after the recipe are allowed, so the open slot works. Today any sigil that is not exactly the recipe casts clamped (`holdsStarterRecipe`, "Rolls clamp on the way out"), appended runes included; the redesign changes that test to "the recipe, then anything". Before it ships, the appended cases must be measured against the 2x damage-per-Force cap in `forcePerDamage.test.ts`: every starter's full recipe with appended infusions, effects, Split, a trigger or release and a payload, on its cheapest class. Fused runes cannot be reordered, so the in-place prefix and reorder cases that clamp today stay closed.
- **Server rules to change:** inscribe only appends to open slots (the existing `base` check covers the fused part); refuse non-compiling spells; a smash message; conservation tests for smash (survivors plus destroyed equals what the sigil held, chance seeded in tests). Item review before it ships.
