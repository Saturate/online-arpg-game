/**
 * Account stash tabs. Prices are paid in the buying character's gold.
 *
 * A normal monster drops about 1.4 gold per monster level on average (35% of kills, 2 to 6 per
 * level; LOOT in config/sim.ts), a rare four times a normal drop and a boss fifteen times. At level
 * 10 the second tab (250) is about 18 normal drops of gold, or two rares: a first goal within the
 * first hour. Each tab after that costs 250 more, so the tenth is 2250 and all nine extra tabs 11250,
 * which keeps tabs a steady gold sink for the whole game instead of a one-off purchase.
 */
export const STASH_TABS = {
  /** General tabs every account starts with. */
  freeGeneral: 1,
  /** General tabs an account can own at most, bought ones included. */
  maxGeneral: 10,
  /** Price of the first tab bought (the account's second). */
  firstPrice: 250,
  /** Each further tab costs this much more than the one before. */
  priceStep: 250,
  /**
   * Rune items the rune tab lists: rolled runes and plain stacks (each still RUNE_STACK at most).
   * Runes are a quarter of all drops, and once every rune is its own item (planned) a player keeps
   * hundreds of them to build with. 1000 is a little under the 1200 cells of all ten general tabs.
   */
  runeCap: 1000,
  /** Sigils the sigil tab lists. */
  sigilCap: 200,
  /** Tab names: 1 to 16 characters from STASH_NAME_PATTERN, checked on the server. */
  nameMax: 16,
} as const;

/** Letters, digits, spaces and a little punctuation. No markup or control characters reach other screens. */
export const STASH_NAME_PATTERN = /^[A-Za-z0-9 .,'!?&()+#:-]+$/;

/**
 * Muted tab colours that sit with the dark stone and iron of the inventory panels: soot, rust,
 * dried blood, moss, bone, slate, umber and verdigris. The first is every new tab's.
 */
export const STASH_COLORS = [
  { id: 'ash', label: 'Ash', hex: '#6e6a62' },
  { id: 'rust', label: 'Rust', hex: '#8a4b2a' },
  { id: 'blood', label: 'Blood', hex: '#7a2626' },
  { id: 'moss', label: 'Moss', hex: '#4f6135' },
  { id: 'bone', label: 'Bone', hex: '#a39a7c' },
  { id: 'slate', label: 'Slate', hex: '#46566a' },
  { id: 'umber', label: 'Umber', hex: '#6b5230' },
  { id: 'verdigris', label: 'Verdigris', hex: '#3f6b62' },
] as const;

export type StashColorId = (typeof STASH_COLORS)[number]['id'];

export function isStashColorId(v: unknown): v is StashColorId {
  return typeof v === 'string' && STASH_COLORS.some((c) => c.id === v);
}

/** Gold for the next general tab when the account owns `owned`; null at the cap. */
export function stashTabPrice(owned: number): number | null {
  if (owned >= STASH_TABS.maxGeneral) return null;
  const bought = Math.max(0, owned - STASH_TABS.freeGeneral);
  return STASH_TABS.firstPrice + STASH_TABS.priceStep * bought;
}

/** A tab name as the server accepts it: already trimmed, single spaces, 1 to 16 allowed characters. */
export function isStashTabName(v: unknown): v is string {
  return typeof v === 'string' && v.length >= 1 && v.length <= STASH_TABS.nameMax && v === v.trim() && !v.includes('  ') && STASH_NAME_PATTERN.test(v);
}
