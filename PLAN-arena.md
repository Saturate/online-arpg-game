# Plan: the Arena as a zone

Status: approved by the owner (2026-09-29) and built; see DECISIONS.md, "The Arena", for the rules as built.

## Rules

- **Entry:** the Arena portal in town leads to the Arena gate, a safe antechamber built like a dungeon's (the `staging` room, ready check with R). Each run is a fresh room for the players inside at the countdown.
- **The title screen loses the Arena mode.** Everyone enters the world; the Arena is reached from town.
- **Waves** start 3 s after the run begins and get harder: more monsters, rarer packs, and monster level rising with the wave (starting at the party's average level). A short breather between waves.
- **One life per run.** A dead player stays down and watches; the run ends when everyone inside is dead (or has left).
- **Score:** points per kill (the monster's XP value, before the level penalty), plus a bonus per wave cleared. Shown live in the HUD and on a score screen when the run ends.
- **Rewards:** no loot and no gold drop in the Arena. XP is 50% of normal.
- **Leaderboard:** stored in SQLite, one row per finished run (season, characters, classes, party size, score, wave, time). Monthly seasons (`YYYY-MM`); two boards per season, solo and party. A board in the Arena gate hall (click to open, like the stash) shows the current season's top 10 of each and the previous seasons' winners. The admin page shows the same.
- **Builders' test bench** leaves the Arena, where it would be cheating: builders open a private sandbox room with the chat command `/sandbox` (a flat map with the free bench and dev tools; progress saved like anywhere else, bench rules unchanged).

## Not in this version

Arena-specific monster pools, modifiers per season, rewards for season winners, spectating other runs.
