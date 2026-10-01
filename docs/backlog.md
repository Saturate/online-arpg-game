# Backlog

Owner requests written down but not started. When one is picked up, move it into its feature doc (`docs/features/`) and delete it here.

- **Hero stuck on a fence corner leaving town** (2026-10-01, seen by the chunk rendering agent): the hero got stuck at a fence corner walking out of town. Check whether the new solid decor or the fence footprints leave a gap too narrow to pass; see [features/town.md](features/town.md).
- **A failed save during a room move or a duplicate login** (2026-10-01, found by the trade fix agent): `move` removes the player from the old room before `persist`, and `endSession` does the same during a duplicate-login join; if `persist` throws, the player is in no room until they reconnect (or the new join stops and the old client is half-closed), and changes since the last save are lost. Progress loss, not duplication. See `apps/server/src/manager.ts`.
- **A rune buy that only tops up bag stacks does not resend the bag** (2026-10-01, found in the trade review): `addItem` returns early (`packages/shared/src/sim/inventory.ts`, around line 112) without `changed(p)`, so the client sees the new count and gold only when something else changes.
- **A misleading log when SQLite rolls back by itself** (2026-10-01): in `AccountStore.transaction` (`apps/server/src/accounts.ts`), a `ROLLBACK` after SQLite already rolled back (disk full, I/O error) throws "no transaction is active" and hides the real error.
