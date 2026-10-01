import type { AffixId } from '../../data/affixes.js';
import type { RuneId } from './runes.js';

/**
 * One line per rune and per rune affix, for the forge and item tooltips. Written for players:
 * what the rune does to the spell, not how the engine does it. Runes read left to right, so
 * "the shape before it" is the nearest shape on the rune's left.
 */
export const RUNE_DESCRIPTIONS: Record<RuneId, string> = {
  orb: 'Starts a spell with a slow, heavy ball that flies toward the cursor.',
  bolt: 'Starts a spell with a fast, thin projectile.',
  beam: 'A line from you to the cursor, held while the button is down. Not in the game yet.',
  nova: 'A ring that bursts outward from where it starts.',
  zone: 'A patch of ground that works on whatever stands in it for a few seconds.',
  dash: 'Throws you forward toward the cursor.',
  arrow: 'A shot that scales with the bow you hold. Not in the game yet.',
  strike: 'A single blow with the weapon you hold. Not in the game yet.',
  cleave: 'A sweeping arc with the weapon you hold. Not in the game yet.',
  throw: 'A thrown blade that flies and returns. Not in the game yet.',
  trap: 'A trap set on the ground that springs when an enemy steps on it. Not in the game yet.',
  aura: 'Held around you while the sigil is equipped. Reserves spirit instead of costing Force.',
  bond: 'A tether to an ally or minion, held while the sigil is equipped. Reserves spirit.',
  fire: 'The shape before it deals fire damage and sets enemies burning.',
  cold: 'The shape before it deals cold damage and slows enemies.',
  lightning: 'The shape before it deals lightning damage and shocks enemies.',
  split: 'The shape before it becomes several copies that fan out, each dealing less damage.',
  link: 'Joins split copies with beams that hurt what crosses them. Not in the game yet.',
  orbit: 'Copies circle you instead of flying off. Not in the game yet.',
  homing: 'The shape before it turns toward enemies. Not in the game yet.',
  bounce: 'The shape before it bounces off what it hits. Not in the game yet.',
  chain: 'The shape before it jumps on to more targets. Not in the game yet.',
  stack: 'Lets the spell\'s ground effects stack before they merge. Not in the game yet.',
  charge: 'Hold the button to power the spell up, let go to fire. Not in the game yet.',
  impact: 'The shape before it knocks enemies back.',
  ward: 'The shape before it shields allies it touches, you included.',
  restore: 'The shape before it heals allies it touches, you included.',
  onhit: 'Everything after this rune is released where the shape before it hits.',
  onexpire: 'Everything after this rune is released when the shape before it runs out.',
  timer: 'Everything after this rune is released half a second after the shape before it appears.',
  pulse: 'Everything after this rune is released again and again while the shape before it lives.',
  onland: 'Everything after this rune is released where your Dash lands.',
  swift: 'The shape before it moves faster.',
  large: 'The shape before it is bigger.',
  concentrated: 'The shape before it hits harder in a smaller area: more damage, 30% less size. Needs a shape with an area, so not a Dash or a Bond.',
};

type RuneAffixId =
  | 'release_onhit'
  | 'release_onexpire'
  | 'release_after'
  | 'release_every'
  | 'release_onland'
  | 'rune_speed'
  | 'rune_size'
  | 'rune_duration'
  | 'rune_damage'
  | 'rune_pierce'
  | 'split_count'
  | 'rune_concentrated';

/** What each rune affix means, beside its rolled line ("Releases its payload on hit"). */
export const RUNE_AFFIX_DESCRIPTIONS = {
  release_onhit: 'Works like an On Hit rune without taking a slot: the runes after it fire where it hits.',
  release_onexpire: 'Works like an On Expire rune without taking a slot: the runes after it fire when it runs out.',
  release_after: 'Works like a Timer rune without taking a slot: the runes after it fire after this long.',
  release_every: 'Works like a Pulse rune without taking a slot: the runes after it fire this often.',
  release_onland: 'Works like an On Land rune without taking a slot: the runes after it fire where the dash ends.',
  rune_speed: 'How fast the shape travels.',
  rune_size: 'How big the shape is.',
  rune_duration: 'How long the shape lasts.',
  rune_damage: 'How hard the shape hits.',
  rune_pierce: 'The shape flies through this many enemies before it stops.',
  split_count: 'How many copies the Split makes.',
  rune_concentrated: 'How much more damage the Concentrated rune gives; several on one shape add up.',
} as const satisfies Record<RuneAffixId, string> & Partial<Record<AffixId, string>>;

export function runeDescription(id: RuneId): string {
  return RUNE_DESCRIPTIONS[id];
}

const AFFIX_TEXT: Partial<Record<AffixId, string>> = RUNE_AFFIX_DESCRIPTIONS;

/** Null for affixes that are not rune affixes (wand stats, gear, vessels). */
export function runeAffixDescription(id: AffixId): string | null {
  return AFFIX_TEXT[id] ?? null;
}

/**
 * Two-letter glyphs for rune icons. Hand-picked because first letters collide (Bolt, Bond and
 * Bounce; Strike and Stack; Chain and Charge; the On triggers).
 */
export const RUNE_GLYPHS: Record<RuneId, string> = {
  orb: 'Or',
  bolt: 'Bt',
  beam: 'Be',
  nova: 'No',
  zone: 'Zo',
  dash: 'Da',
  arrow: 'Ar',
  strike: 'Sk',
  cleave: 'Cv',
  throw: 'Th',
  trap: 'Tr',
  aura: 'Au',
  bond: 'Bd',
  fire: 'Fi',
  cold: 'Co',
  lightning: 'Li',
  split: 'Sp',
  link: 'Lk',
  orbit: 'Ob',
  homing: 'Ho',
  bounce: 'Bn',
  chain: 'Cn',
  stack: 'St',
  charge: 'Cg',
  impact: 'Im',
  ward: 'Wa',
  restore: 'Re',
  onhit: 'OH',
  onexpire: 'OE',
  timer: 'Ti',
  pulse: 'Pu',
  onland: 'OL',
  swift: 'Sw',
  large: 'La',
  concentrated: 'Ct',
};

export function runeGlyph(id: RuneId): string {
  return RUNE_GLYPHS[id];
}
