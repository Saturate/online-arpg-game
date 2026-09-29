import { advanceSpell, type EntityId, type EntitySnap, type Snapshot, type SpellSnap } from '@rune/shared';

/**
 * The spell entities the server has told this client about. Snapshots send each one once (and again
 * only when its motion changes), then list it as gone; this table carries them forward so every
 * snapshot can be expanded back to full state before the rest of the client sees it.
 */
export class SpellTable {
  private readonly records = new Map<EntityId, { record: SpellSnap; tick: number }>();

  /** The snapshot with its spell entities filled in at the snapshot's tick. */
  expand(snap: Snapshot): Snapshot {
    for (const id of snap.gone) this.records.delete(id);
    for (const record of snap.spells) this.records.set(record.id, { record, tick: snap.tick });
    if (this.records.size === 0) return snap;
    const spells: EntitySnap[] = [];
    for (const { record, tick } of this.records.values()) spells.push(advanceSpell(record, snap.tick - tick));
    return { ...snap, entities: [...snap.entities, ...spells] };
  }
}
