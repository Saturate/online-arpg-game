import { MINION_DEFS, vesselSpirit, type ClassId, type InventoryMessage, type Item } from '@rune/shared';
import { compileFor } from './store.js';

/**
 * Spirit bookkeeping on the client, mirroring the server's spiritReservedFor: persistent skills
 * and bound minions each hold some of it back for as long as they are equipped.
 */

export interface SpiritUse {
  key: string;
  name: string;
  spirit: number;
  kind: 'skill' | 'minion';
}

/** What an item would reserve once equipped, or null when it reserves nothing (a cast skill, gear). */
export function spiritCost(item: Item, classId: ClassId): number | null {
  if (item.kind === 'vessel') return vesselSpirit(item);
  if (item.kind !== 'sigil') return null;
  const r = compileFor(item, classId);
  return r.ok && r.persistent ? r.spirit : null;
}

export function spiritUses(inv: InventoryMessage, classId: ClassId): SpiritUse[] {
  const find = (uid: number | null) => (uid === null ? undefined : inv.items.find((i) => i.uid === uid));
  const out: SpiritUse[] = [];
  inv.sigils.forEach((uid, slot) => {
    const item = find(uid);
    const cost = item ? spiritCost(item, classId) : null;
    if (item && cost !== null) out.push({ key: `s${slot}`, name: item.name, spirit: cost, kind: 'skill' });
  });
  inv.warband.forEach((uid, slot) => {
    const item = find(uid);
    if (item?.kind === 'vessel') out.push({ key: `w${slot}`, name: `${MINION_DEFS[item.minion].name}`, spirit: vesselSpirit(item), kind: 'minion' });
  });
  return out;
}
