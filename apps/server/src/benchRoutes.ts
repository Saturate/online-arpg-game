import { checkBenchSpell, type BenchState } from '@rune/shared';
import type { BenchStore } from './benchStore.js';

export interface BenchRequest {
  method: string;
  path: string;
  body: () => Promise<unknown>;
  /** Adding and removing picks takes the `tuning` permission; looking needs only staff access, checked before. */
  canEdit: boolean;
  /** Shares the tuning write limit, so a script cannot flood the table. */
  allowWrite: () => boolean;
  by: { account: string; token: string | null };
  log: (what: string) => void;
}

const PICK = /^\/api\/admin\/bench\/picks\/(\d{1,9})$/;

/**
 * GET /api/admin/bench is the admin picks and the most-equipped sigils; POST .../picks adds a pick
 * (`{ text, classId, multicast? }`, checked by the grammar and the compiler), DELETE .../picks/<id>
 * removes one. Null means the path is not ours.
 */
export async function benchRoute(req: BenchRequest, store: BenchStore): Promise<[number, unknown] | null> {
  const { method, path } = req;
  if (path === '/api/admin/bench') {
    if (method !== 'GET') return [405, { error: 'Use GET' }];
    const popular = store.mostEquipped();
    const state: BenchState = { picks: store.picks(), popular: popular.sigils, popularAt: popular.at };
    return [200, state];
  }
  if (path === '/api/admin/bench/picks') {
    if (method !== 'POST') return [405, { error: 'Use POST' }];
    if (!req.canEdit) return [403, { error: 'Your role cannot do that' }];
    if (!req.allowWrite()) return [429, { error: 'Too many changes; wait a minute' }];
    const spell = checkBenchSpell(await req.body());
    if (typeof spell === 'string') return [400, { error: spell }];
    const added = store.add(spell, req.by);
    if (added === 'duplicate') return [409, { error: 'That spell is already on the bench' }];
    if (added === 'full') return [409, { error: 'The bench is full; remove a pick first' }];
    req.log(`bench pick #${added.id} added: ${added.classId}${added.multicast > 1 ? ` multicast ${added.multicast}` : ''} "${added.text}"`);
    return [201, added];
  }
  const match = PICK.exec(path);
  if (match) {
    if (method !== 'DELETE') return [405, { error: 'Use DELETE' }];
    if (!req.canEdit) return [403, { error: 'Your role cannot do that' }];
    if (!req.allowWrite()) return [429, { error: 'Too many changes; wait a minute' }];
    const gone = store.remove(Number(match[1]));
    if (!gone) return [404, { error: `No pick #${match[1]}` }];
    req.log(`bench pick #${gone.id} removed: ${gone.classId} "${gone.text}" (added by ${gone.account})`);
    return [200, { ok: true }];
  }
  return null;
}
