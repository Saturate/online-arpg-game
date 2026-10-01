/**
 * Every rule the v2 grammar enforces, by name. Several are answers to questions the rune design
 * (docs/features/runes.md) left open; those are marked ASSUMED so the owner can see what was decided for the prototype.
 */
export const RULES = {
  EMPTY: { id: 'empty', text: 'A spell needs at least one rune.' },
  UNKNOWN_RUNE: { id: 'unknown-rune', text: 'Every word in the text box must name a rune.' },
  UNKNOWN_AFFIX: { id: 'unknown-affix', text: 'Every item inside [ ] must be a known affix.' },
  BAD_COUNT: { id: 'bad-count', text: 'A (n) count only goes on runes that have a number to set.' },
  FIRST_RUNE_SHAPE: { id: 'first-rune-shape', text: 'The first rune must be a shape.' },
  AFFIX_NOT_ALLOWED: { id: 'affix-not-allowed', text: 'Each affix only rolls on certain runes; release affixes only on shapes.' },
  /**
   * Infusions, effects and shapers attach to the nearest shape on their left (postfix).
   * Not an error by itself; listed so the owner can see it.
   */
  POSTFIX: { id: 'postfix', text: 'Infusions, effects and shapers attach to the nearest shape on their left.' },
  /**
   * ASSUMED. A Split written after the parent's release point and before the payload's shape
   * splits the payload, not the parent. The examples in docs/features/runes.md need this
   * (`Orb [every 0.2 s], Cold, Split 4, Bolt` sprays four bolts; the endgame spell makes six embers).
   * The release point is the shape itself for a release affix, or the trigger rune's position.
   * A Link right after such a Split goes with it. Everything else still attaches to the parent.
   */
  SPLIT_BEFORE_PAYLOAD: {
    id: 'split-before-payload',
    text: 'A Split after the release point and before the payload shape splits the payload.',
  },
  RELEASE_STARTS_PAYLOAD: {
    id: 'release-starts-payload',
    text: 'A trigger rune or release affix makes everything from the next shape onward that shape\'s payload.',
  },
  TRAILING_RELEASE: { id: 'trailing-release', text: 'A trigger or release affix needs a payload shape after it.' },
  ONE_RELEASE: { id: 'one-release', text: 'A shape releases its payload one way: at most one trigger rune or release affix.' },
  RELEASE_NOT_FOR_SHAPE: { id: 'release-not-for-shape', text: 'Each shape only accepts some release kinds (TRIGGERS_FOR_SHAPE).' },
  ONRELEASE_NEEDS_HOLD: { id: 'onrelease-needs-hold', text: '"On release" needs a Charge rune on the shape, or a Beam.' },
  RELEASE_INTERVAL: { id: 'release-interval', text: '"Every" and "after" need at least 0.1 s.' },
  MULTICAST: { id: 'multicast', text: 'Shapes in a row with no release between are cast together, up to the multicast.' },
  /** ASSUMED. Multicast counts per cast-together group, so a payload of Nova + Zone needs multicast 2 as well. */
  MULTICAST_PER_GROUP: { id: 'multicast-per-group', text: 'Multicast applies to every group, payloads included.' },
  SHAPER_NOT_FOR_SHAPE: { id: 'shaper-not-for-shape', text: 'Each shape only accepts some shapers (SHAPERS_FOR_SHAPE).' },
  LINK_NEEDS_SPLIT: { id: 'link-needs-split', text: 'Link joins copies, so it needs a Split earlier on the same shape.' },
  /** Owner decision: doubled runes stack for now, so a second Split multiplies the copies. Kept as a named rule for the total cap. */
  SPLIT_ONCE: { id: 'split-once', text: 'Splits multiply, up to 12 copies of one shape.' },
  SPLIT_COUNT: { id: 'split-count', text: 'Split makes 2 to 6 copies (the plan\'s roll range).' },
  /** Owner decision: doubled runes stack for now (two Homing pull harder). Link and Orbit have nothing to stack, so they stay once. */
  DUPLICATE_SHAPER: { id: 'duplicate-shaper', text: 'Link and Orbit go on a shape once; other shapers stack.' },
  PERSISTENT_ALONE: { id: 'persistent-alone', text: 'Aura and Bond must be the only shape in the spell.' },
  PERSISTENT_NO_RELEASE: { id: 'persistent-no-release', text: 'Aura and Bond cannot have a trigger or release affix.' },
  PERSISTENT_NO_SPLIT: { id: 'persistent-no-split', text: 'Aura and Bond cannot be split.' },
  PERSISTENT_NO_CHARGE: { id: 'persistent-no-charge', text: 'Aura and Bond cannot be charged.' },
  /** ASSUMED. Dash moves the caster, and a payload spawns away from the caster, so Dash is a root shape only. */
  DASH_ROOT_ONLY: { id: 'dash-root-only', text: 'Dash moves you, so it cannot be a payload.' },
  /** ASSUMED. Charging needs a held button, which only the cast itself has. */
  CHARGE_ROOT_ONLY: { id: 'charge-root-only', text: 'Charge needs a held button, so only a root shape can be charged.' },
  INFUSION_INHERIT: { id: 'infusion-inherit', text: 'A payload inherits its parent\'s infusions unless it has its own.' },
  MAX_DEPTH: { id: 'max-depth', text: 'Payloads nest at most maxDepth levels below the cast.' },
  /**
   * The budget is the most entities alive at once, not the lifetime total. `every` counts only the
   * releases whose payloads overlap in time (payload lifetime / interval), not every pulse.
   */
  ENTITY_CAP: { id: 'entity-cap', text: 'The most entities alive at once must stay within liveCap.' },
  /** Compiler rules: the grammar reads these spells, but the sigil or the engine cannot hold them. */
  OVER_CAPACITY: { id: 'over-capacity', text: 'A sigil holds at most as many runes as it has slots.' },
  RUNE_NOT_CASTABLE: { id: 'rune-not-castable', text: 'This rune is not in the game yet (phase 4); the grammar reads it but nothing can cast it.' },
  ENGINE_NOT_READY: {
    id: 'engine-not-ready',
    text: 'The engine cannot run this part yet (phase 4): homing, bounce, or releasing on a held button.',
  },
  /** ASSUMED. On a Dash or a Bond, Concentrated would be damage with nothing given up, so it is refused rather than ignored like Large. */
  CONCENTRATED_NEEDS_AREA: { id: 'concentrated-needs-area', text: 'Concentrated trades area for damage, so it needs a shape with an area (not Dash or Bond).' },
  CONCENTRATED_AMOUNT: { id: 'concentrated-amount', text: 'Concentrated adds 40 to 60% more damage, the range a drop rolls.' },
  /**
   * One per shape, like Link and Orbit: a second one added damage again and took another 30% of the
   * size, and once the size hit its floor every further one was free damage.
   */
  CONCENTRATED_ONCE: { id: 'concentrated-once', text: 'A shape takes one Concentrated rune.' },
  PLAIN_MODIFIER_OFF: {
    id: 'plain-modifier-off',
    text: 'Swift and Large are affixes; as plain runes they only work when plainModifierRunes is on (open question 1).',
  },
} as const;

export type RuleKey = keyof typeof RULES;
export type RuleId = (typeof RULES)[RuleKey]['id'];

export interface GrammarError {
  rule: RuleId;
  /** Index of the offending rune in the list, or -1 for the spell as a whole. */
  runeIndex: number;
  message: string;
}

export interface GrammarContext {
  /** Shapes a sigil casts together in one group. */
  multicast: number;
  /** Payload levels allowed below the cast. The cast itself is depth 0. */
  maxDepth: number;
  /** Most entities one cast may have alive at once. */
  liveCap: number;
  /** Accept Swift and Large as plain runes (owner decision: yes, they teach the system early). */
  plainModifierRunes: boolean;
}

export const DEFAULT_CONTEXT: GrammarContext = {
  multicast: 1,
  maxDepth: 3,
  liveCap: 40,
  plainModifierRunes: true,
};

/** Most copies one shape may have after its Splits multiply. */
export const MAX_COPIES = 12;

export const SPLIT_COUNT_RANGE = { min: 2, max: 6 } as const;
export const MIN_RELEASE_SECONDS = 0.1;
