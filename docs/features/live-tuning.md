# Live tuning

Status: Planned (owner, 2026-10-01).

"I want base damage settings for all runes, skills etc. All entities need to be able to be configured via API, deployless."

## What it does

Every gameplay number that matters for balance can be changed through the admin API and the admin page, and the change reaches running rooms and clients without a deploy or a restart. The defaults stay in code; the server stores only overrides.

## Scope (owner, 2026-10-01)

- **Shapes and runes:** base damage, speed, range, radius and duration of Bolt, Orb, Nova, Zone, Aura, Dash and Bond; each rune's Force cost, spirit and effect amounts (Split copies, Large, Concentrated, infusions and their burn, chill, shock and poison).
- **Starter skills:** the per-starter damage multiplier ([runes.md](runes.md), "Planned: starter damage multipliers in admin"), and later each starter's rune numbers directly.
- **Monsters and minions:** monsters are tunable already (the admin Monsters tab); extend minions to everything (abilities, cooldowns, pack and Hound numbers) and add monster abilities and traits.
- **Players and loot:** class base stats, level scaling, the Force pool and its regen, drop rates, gold, affix roll ranges and prices.

## Decisions

- **No balance guard** (owner): admins tune freely. The balance tests keep checking the code defaults only. The admin page may show numbers such as damage per Force for information, but never refuses a save.
- **History with rollback** (owner): every change is logged with who made it, when, the old and the new value; any change can be reverted with one click. One active set, no named profiles.
- **One registry:** a schema in `packages/shared` lists every tunable number with its path (for example `shape.bolt.damage`), category, label, default (read from the config), and a validated range. The API, the admin page and validation all come from it, so adding a number is one registry line.
- **Applied the same everywhere:** the server and every client apply the same overrides (sent with the welcome and on every change), so tooltips, the forge and prediction match the server. Replays record the overrides they ran with.
- **Monster tuning stays** as it is and is linked from the same admin page; it may move into the registry later.

## How (plan)

1. **Framework and shapes and runes:** the registry, storage (an overrides table and a history table in SQLite), the API (`GET /api/admin/tuning` for schema plus current values, `PATCH` for changes, `GET .../history`, `POST .../revert`), delivery to clients, the admin page (a dark table by category, search, the code default beside each value, reset to default per field, the history list with revert), and the first category: shapes and runes.
2. **Starters:** fold the per-starter multiplier in; then starter rune numbers.
3. **Minions and monster abilities and traits.**
4. **Players and loot.**

Each phase ships on its own. Loot and prices touch the economy, so phase 4 gets a fresh-eyes review for gold minting.

## Limits and open questions

- Values computed once at module load from the config (derived constants) do not follow an override unless they are recomputed; phase 1 has to find and fix those for its categories.
- A change mid-fight applies on the next cast or spawn, not to things already in the world.
