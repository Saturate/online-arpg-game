# Backlog

Owner requests written down but not started. When one is picked up, move it into its feature doc (`docs/features/`) and delete it here.

- **Leash hover bug** (2026-09-30, found by the streaming work): an aggroed monster whose target is alive beyond the 1300-unit leash hovers at the leash edge forever (each step back inside it re-picks the target and walks out), so it never walks home or sleeps. A leash that sends the monster all the way home before it can re-aggro would fix it. See [features/world-streaming.md](features/world-streaming.md).
