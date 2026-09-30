# Backlog

Owner requests written down but not started. When one is picked up, move it into its feature doc (`docs/features/`) and delete it here.

- **Summons inactive while their master is dead** (2026-09-30): minions should stop fighting (and not be targetable, or stand down) while the player is dead, and come back with them. See [features/minions.md](features/minions.md).
- **Camp fires in the world** (2026-09-30): only two camp fires exist (the forge and one on a test map). Options: generated camps in zones (a camp fire with crates and tents, sometimes guarded), and camp fires placeable in the town editor (being added with the asset expansion). See [features/vfx.md](features/vfx.md), "World fires".
- **Dungeon torch bowls look blown out up close** (2026-09-30): the torch light sits just above the bowl. See [features/vfx.md](features/vfx.md).
- **Hound minion pathing behind fences** (2026-09-30): packmates can get stuck behind the town fence after a teleport (minions follow the master's trail); they catch up at 700 units. See [features/minions.md](features/minions.md).
- **Party-only XP sharing?** (2026-09-30, question to the owner): kill XP is shared with every living player within 1500 units, party or not ([features/characters.md](features/characters.md)); the docs say "party members". Decide whether to limit it to the party.
- **Party teleport across world copies** (2026-09-30): in the main game, being in a party should always let you teleport to any member, including moving you into their world copy even when it counts as full (party members always fit). Arena runs and the private sandbox stay excluded. Today a teleport into another world copy or a full copy is refused. See [features/chat-and-parties.md](features/chat-and-parties.md).
