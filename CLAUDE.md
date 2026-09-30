# Working on this repo

Browser ARPG with an authoritative server, live at https://arpg.akj.io. Start with `README.md` (layout, commands, handoff), then `docs/features/index.md` for the feature you touch. Cross-cutting decisions are in `DECISIONS.md`.

## Deploys

- A push to `main` deploys: GitHub Actions builds the image, Flux rolls it out and the live server restarts while people play. **Never push until the owner says to deploy in the current conversation.** Commit locally and report what is waiting; when told to deploy, push everything waiting in one go.
- Before a deploy that converts saves, copy `/data/rune.db` first (the only rollback) and dry-run the conversion on the copy (`pnpm runes:convert-check <db>`). The README handoff has the steps.
- Run the push skill's gates (typecheck, tests, client build) before pushing.

## How work is done

- **Subagents build, the main session plans and reviews.** Give each agent a precise brief with file ownership and "stage only your own files"; run independent pieces in parallel where files do not overlap; keep the main session for planning, coordination, verification and talking to the owner. Only small edits are done directly.
- **Fresh-eyes review before shipping.** Anything that moves items (inventory, stash, forge, trades, loot, conversions) gets a separate reviewer looking for item loss and duplication. Other features get a normal code review. Fix and review again until clean.
- **Feature docs are part of done.** Every feature has `docs/features/<feature>.md` (what it does, why, how, limits and open questions), listed in `docs/features/index.md`. Every brief includes writing or updating it. New plans start as a feature doc with status "Planned". `DECISIONS.md` keeps only cross-cutting decisions.
- **Ask when the owner's intent is unclear**, especially about the look or anything that changes the economy.

## Look

Dark and gritty, like Diablo 2 Act 1 and Path of Exile: low light, muted and desaturated colour, grime and wear. Never bright, glossy or "cute mobile game"; living but grim trees are fine. The KayKit models are cartoon style, so the grit comes from lighting, the canvas colour grade and the shared grime shader (`apps/client/src/render/grit.ts`). Nights must stay playable (night brightness is an admin setting). This applies to models and UI as well as lighting.

## Spellcraft direction

Runes read left to right like a Noita wand, and the order is the puzzle. Sigils are wands (slots, cast delay, multicast). Built-in skills are starter sigils of rolled runes. Rune affixes come from drops and the rune trader; the forge costs gold. Classes are heading toward three styles (melee, ranged, spell) with their own sigils, weapons and minions. Details and what is decided are in `docs/features/runes.md` and `forge.md`.

## 3D models

- Use headless Blender (`blender -b --python <script> -- <args>`) with the scripts in `tools/blender/` (the README there has the order and a worked example), and check every model with `pnpm model:check <file.glb>`.
- The role and lessons for modelling are in `.claude/agents/model-artist.md`; visual review in `.claude/agents/visual-reviewer.md`. Project agents in `.claude/agents/` only launch by type after a Claude Code restart; before that, run a general-purpose agent told to read the file.
- The Blender MCP (Blender Lab, `projects.blender.org/lab/blender_mcp`) is optional and set up per machine: clone to `~/blender_mcp`, `claude mcp add --scope local blender -- uv --directory ~/blender_mcp/mcp run blender-mcp`, and enable the add-on in Blender (it listens on localhost:9876). It runs any Python the model sends, so only open trusted files while it is connected.

## Code

- TypeScript strict, no casts (`as`, except `as const`), narrow instead; no `any`.
- Comments explain why, not what.
- No em dashes in code, comments, docs or messages.
- Commits: Conventional Commits. While 1Password is locked, commit unsigned (`git -c commit.gpgsign=false commit`); SSH to `svr.akj.io` also needs 1Password approval.
