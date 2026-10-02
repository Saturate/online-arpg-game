# Seamless restart

Status: Planned (owner, 2026-10-02).

"Could we somehow have restartless or better deploy of new code?" The owner chose a seamless restart: a deploy still restarts the server, but players continue where they were.

## Planned

- **On shutdown (SIGTERM):** save every character as today, plus the session state that is lost today: each player's room, world copy and position, their party, open dungeon runs where possible, ground loot and loot piles, and world copy memory (dead bosses, opened chests, gate timers). Written in one transaction to SQLite, with a format version.
- **On boot:** restore that state before accepting players: rebuild the world copies with their own seeds and generation numbers, put ground loot and piles back where they lay, restore memory and parties. A player who reconnects within a few minutes lands where they stood, in the same world copy and party; later, or if their spot is gone, at the town spawn as today. The snapshot is used once and then deleted.
- **What players see:** when the connection drops for a deploy, a calm full-screen overlay: "Updating game server, please hang tight" (dark, in the game's look), with a quiet progress pulse, while the client keeps reconnecting; it reloads on the new build and drops them back in. A countdown announcement goes out first when people are online (for example 60 s), so nobody is mid-fight by surprise.
- **Items:** this moves items (ground loot, piles), so it gets a loss and duplication review. A crash without SIGTERM restores nothing new and loses only what a crash loses today.

## Limits and open questions

- Monsters, spells in flight and Arena runs are not restored; chunks refill as on any first visit.
- The deployment keeps the Recreate strategy (one pod owns the SQLite file), so there is still about a minute of downtime; a faster handover is a separate step.
