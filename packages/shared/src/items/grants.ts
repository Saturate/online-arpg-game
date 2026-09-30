import { ROLLABLE_RUNES, createBrothersCreation, createRolledRune, createVessel, ITEM_TIERS, type Item, type ItemTier, type ItemUid } from './items.js';
import { dropSigil } from './drops.js';
import { MINION_TYPE_IDS, type MinionTypeId } from '../data/minions.js';
import { ACCOUNT_RULES } from '../protocol/accounts.js';
import type { RuneId } from '../runes/v2/runes.js';
import type { Rng } from '../sim/rng.js';

/**
 * What the owner can grant from the admin page: the one named item, and the rolls the dev tools
 * already make. Grants are never bound, unlike dev tool items, because they are meant to be real
 * items (the brothers' vessels are for trading and testing on live).
 */
export const GRANT_TEMPLATES = ['brothers_creation', 'vessel', 'sigil', 'rune'] as const;
export type GrantTemplate = (typeof GRANT_TEMPLATES)[number];

export const GRANT_TEMPLATE_INFO: Record<GrantTemplate, { name: string; rolled: boolean }> = {
  brothers_creation: { name: 'Brothers Creation (relic Hound vessel)', rolled: false },
  vessel: { name: 'Vessel (rolled)', rolled: true },
  sigil: { name: 'Sigil (rolled, as a drop)', rolled: true },
  rune: { name: 'Rolled rune', rolled: true },
};

export const GRANT_LEVEL = { min: 1, max: 30 } as const;

export interface GrantRequest {
  username: string;
  characterId: number;
  template: GrantTemplate;
  tier: ItemTier;
  /** Item level: the monster level a drop would have come from. */
  level: number;
  /** Vessels only; null rolls the type like a drop. */
  minion: MinionTypeId | null;
  /** Rolled runes only; null rolls the rune like a drop. */
  rune: RuneId | null;
}

const KEYS = new Set(['username', 'characterId', 'template', 'tier', 'level', 'minion', 'rune']);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Every field is checked here, on the server; the admin page's own checks are only a convenience. */
export function parseGrantRequest(v: unknown): GrantRequest | string {
  if (!isRecord(v)) return 'Expected a JSON object';
  const unknownKey = Object.keys(v).find((k) => !KEYS.has(k));
  if (unknownKey !== undefined) return `Unknown field "${unknownKey}"`;
  const { username, characterId, template, tier, level, minion, rune } = v;
  if (typeof username !== 'string' || !ACCOUNT_RULES.usernamePattern.test(username)) return 'username must be an account name';
  if (typeof characterId !== 'number' || !Number.isSafeInteger(characterId) || characterId < 1) return 'characterId must be a character id';
  const t = GRANT_TEMPLATES.find((x) => x === template);
  if (!t) return `template must be one of ${GRANT_TEMPLATES.join(', ')}`;
  const tr = ITEM_TIERS.find((x) => x === tier);
  if (!tr) return `tier must be one of ${ITEM_TIERS.join(', ')}`;
  if (typeof level !== 'number' || !Number.isInteger(level) || level < GRANT_LEVEL.min || level > GRANT_LEVEL.max) return `level must be a whole number from ${GRANT_LEVEL.min} to ${GRANT_LEVEL.max}`;
  if (t === 'brothers_creation' && tr !== 'relic') return 'Brothers Creation is always a relic';
  let m: MinionTypeId | null = null;
  if (minion !== undefined && minion !== null) {
    const found = MINION_TYPE_IDS.find((x) => x === minion);
    if (!found || t !== 'vessel') return 'minion must be a minion type, and only for a vessel';
    m = found;
  }
  let r: RuneId | null = null;
  if (rune !== undefined && rune !== null) {
    const found = ROLLABLE_RUNES.find((x) => x === rune);
    if (!found || t !== 'rune') return 'rune must be a rune that rolls affixes, and only for a rolled rune';
    r = found;
  }
  return { username, characterId, template: t, tier: tr, level, minion: m, rune: r };
}

/**
 * The one item a grant makes. `newUid` gives the item its uid and, for a sigil that came with runes,
 * each rune its own; nothing is bound.
 */
export function createGrantItem(req: GrantRequest, newUid: () => ItemUid, rng: Rng): Item {
  switch (req.template) {
    case 'brothers_creation':
      return createBrothersCreation(newUid(), req.level);
    case 'vessel':
      return createVessel(newUid(), rng, req.tier, req.minion ?? undefined, req.level);
    case 'rune':
      return createRolledRune(newUid(), rng, req.tier, req.level, req.rune ?? undefined);
    case 'sigil':
      return dropSigil(rng, newUid, req.tier, req.level);
  }
}
