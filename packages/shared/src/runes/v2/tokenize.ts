import { ADDED_DAMAGE_SPREAD, ADDED_KEYS, COUNT_AFFIX, INFUSION_IDS, isInfusionId, isRuneId, neutralImplicitValue, runeName, type Release, type RuneAffixes, type RuneId, type RuneInstance } from './runes.js';
import { RULES, type GrammarError } from './rules.js';

export interface RuneToken {
  text: string;
  start: number;
  end: number;
}

export interface TokenizeResult {
  runes: RuneInstance[];
  /** One per rune-like word, in order; lines up with `runes` when there are no errors. */
  tokens: RuneToken[];
  errors: GrammarError[];
}

const ALIASES: Record<string, RuneId> = {
  ball: 'orb',
  frost: 'cold',
  ice: 'cold',
  shock: 'lightning',
  tether: 'bond',
  hit: 'onhit',
  expire: 'onexpire',
  land: 'onland',
  conc: 'concentrated',
};

const NUM = String.raw`([+-]?\d+(?:\.\d+)?|[+-]?\.\d+)`;
const PERCENT_WORDS = ['speed', 'size', 'duration', 'damage'] as const;
type PercentWord = (typeof PERCENT_WORDS)[number];
const isPercentWord = (s: string): s is PercentWord => s === 'speed' || s === 'size' || s === 'duration' || s === 'damage';

/** Descriptive words for the common rolls; the numbers match what the sentence reads back. */
const WORD_AFFIXES: Record<string, (a: RuneAffixes) => void> = {
  slow: (a) => (a.speed = (a.speed ?? 0) - 30),
  fast: (a) => (a.speed = (a.speed ?? 0) + 30),
  swift: (a) => (a.speed = (a.speed ?? 0) + 30),
  small: (a) => (a.size = (a.size ?? 0) - 30),
  large: (a) => (a.size = (a.size ?? 0) + 50),
  big: (a) => (a.size = (a.size ?? 0) + 50),
  long: (a) => (a.duration = (a.duration ?? 0) + 50),
  short: (a) => (a.duration = (a.duration ?? 0) - 30),
  homing: (a) => (a.homing = (a.homing ?? 0) + 1),
};

const COUNT_KEYS: Record<string, 'pierce' | 'bounce' | 'homing' | 'chain' | 'count' | 'stackLimit' | 'chargeStages' | 'seconds' | 'concentration'> = {
  pierce: 'pierce',
  bounce: 'bounce',
  homing: 'homing',
  chain: 'chain',
  count: 'count',
  copies: 'count',
  stack: 'stackLimit',
  'up to': 'stackLimit',
  limit: 'stackLimit',
  stages: 'chargeStages',
  seconds: 'seconds',
  concentration: 'concentration',
};

function parseRelease(item: string): Release | null {
  const flat = item.replace(/[\s_-]+/g, '');
  if (flat === 'onhit') return { kind: 'onhit', seconds: 0 };
  if (flat === 'onexpire') return { kind: 'onexpire', seconds: 0 };
  if (flat === 'onland' || flat === 'onlanding') return { kind: 'onland', seconds: 0 };
  if (flat === 'onrelease') return { kind: 'onrelease', seconds: 0 };
  const timed = new RegExp(String.raw`^(every|after)\s*[:=]?\s*${NUM}\s*s?$`).exec(item);
  if (timed?.[1] && timed[2]) {
    return { kind: timed[1] === 'every' ? 'every' : 'after', seconds: Number(timed[2]) };
  }
  return null;
}

/** Applies one `[ ]` item to the affixes; false when the item means nothing. */
function applyAffix(raw: string, a: RuneAffixes): boolean {
  const item = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  if (item === '') return true;
  const release = parseRelease(item);
  if (release) {
    a.release = release;
    return true;
  }
  // "adds 4 fire" or "adds 4 to 8 fire": the high end is fixed by the low (ADDED_DAMAGE_SPREAD).
  const added = new RegExp(String.raw`^adds?\s+${NUM}(?:\s+to\s+${NUM})?\s+(\w+)(?:\s+damage)?$`).exec(item);
  if (added?.[1] && added[3] && isInfusionId(added[3])) {
    const low = Number(added[1]);
    if (added[2] !== undefined && Math.abs(Number(added[2]) - low * ADDED_DAMAGE_SPREAD) > 1e-9) return false;
    const key = ADDED_KEYS[added[3]];
    a[key] = (a[key] ?? 0) + low;
    return true;
  }
  const word = WORD_AFFIXES[item];
  if (word) {
    word(a);
    return true;
  }
  // A ranged roll, rolled inside on every cast: "+20 to 60% damage", "pierce 0 to 3".
  const pctRange = new RegExp(String.raw`^${NUM}\s*%?\s+to\s+${NUM}\s*%\s*damage$`).exec(item);
  if (pctRange?.[1] && pctRange[2]) {
    const low = Number(pctRange[1]);
    const high = Number(pctRange[2]);
    if (!(high > low)) return false;
    a.damage = low;
    a.damageMax = high;
    return true;
  }
  const countRange = new RegExp(String.raw`^(pierce|count|copies)\s*[:=]?\s*${NUM}\s+to\s+${NUM}$`).exec(item);
  if (countRange?.[1] && countRange[2] && countRange[3]) {
    const low = Number(countRange[2]);
    const high = Number(countRange[3]);
    if (!(high > low)) return false;
    if (countRange[1] === 'pierce') {
      a.pierce = low;
      a.pierceMax = high;
    } else {
      a.count = low;
      a.countMax = high;
    }
    return true;
  }
  // "+30% damage", "-15% speed"
  const pctFirst = new RegExp(String.raw`^${NUM}\s*%\s*(\w+)$`).exec(item);
  if (pctFirst?.[1] && pctFirst[2] && isPercentWord(pctFirst[2])) {
    a[pctFirst[2]] = Number(pctFirst[1]);
    return true;
  }
  // "damage +30%", "speed:-15"
  const pctLast = new RegExp(String.raw`^(\w+)\s*[:=]?\s*${NUM}\s*%?$`).exec(item);
  if (pctLast?.[1] && pctLast[2] && isPercentWord(pctLast[1])) {
    a[pctLast[1]] = Number(pctLast[2]);
    return true;
  }
  // "pierce 2", "up to 3", "stages:4"
  const counted = new RegExp(String.raw`^([a-z ]+?)\s*[:=]?\s*${NUM}$`).exec(item);
  const countKey = counted?.[1] ? COUNT_KEYS[counted[1].trim()] : undefined;
  if (counted?.[2] && countKey) {
    a[countKey] = Number(counted[2]);
    return true;
  }
  return false;
}

function resolveName(word: string): RuneId | null {
  const flat = word.toLowerCase().replace(/[\s_-]+/g, '');
  if (isRuneId(flat)) return flat;
  return ALIASES[flat] ?? null;
}

/**
 * Forgiving text form of a rune list: `orb[every 0.2s] cold split(4) bolt[small]`.
 * Case-insensitive; runes separate by spaces, commas, `>` or arrows; `[a, b]` holds affixes;
 * `(n)`, a trailing digit (`split4`) or a following bare number (`split 4`) sets the rune's count;
 * `on hit` may be written as two words.
 */
export function tokenizeSpell(text: string): TokenizeResult {
  const runes: RuneInstance[] = [];
  const tokens: RuneToken[] = [];
  const errors: GrammarError[] = [];
  const at = (i: number, rule: 'UNKNOWN_RUNE' | 'UNKNOWN_AFFIX' | 'BAD_COUNT', message: string): void => {
    errors.push({ rule: RULES[rule].id, runeIndex: i, message });
  };

  // Word, then any mix of (n), [..] and {implicit} groups, or a bare number standing alone.
  const re = /([a-zA-Z_-]+)(\d+(?:\.\d+)?)?((?:\s*(?:\([^)]*\)|\[[^\]]*\]|\{[^}]*\}))*)|(\d+(?:\.\d+)?)/g;
  const setCount = (index: number, id: RuneId, value: number, affixes: RuneAffixes): void => {
    const key = COUNT_AFFIX[id];
    if (!key || key === 'release') {
      at(index, 'BAD_COUNT', `${runeName(id)} (rune ${index + 1}) has no number to set, so (${value}) means nothing on it.`);
      return;
    }
    affixes[key] = value;
  };

  let m: RegExpExecArray | null;
  let pendingOn: RuneToken | null = null;
  while ((m = re.exec(text)) !== null) {
    const [whole, word, digits, groups, bare] = m;
    const start = m.index;
    const end = start + whole.length;

    if (bare !== undefined) {
      const lastRune = runes[runes.length - 1];
      const lastToken = tokens[tokens.length - 1];
      if (lastRune && lastToken && runes.length === tokens.length) {
        setCount(tokens.length - 1, lastRune.id, Number(bare), lastRune.affixes);
        lastToken.end = end;
        lastToken.text = text.slice(lastToken.start, end);
      } else {
        tokens.push({ text: whole, start, end });
        at(tokens.length - 1, 'BAD_COUNT', `The number ${bare} does not follow a rune.`);
      }
      continue;
    }
    if (word === undefined) continue;

    // "on hit" written as two words.
    if (word.toLowerCase() === 'on' && !digits && !groups?.trim()) {
      pendingOn = { text: whole, start, end };
      continue;
    }
    let name = word;
    let tokenStart = start;
    if (pendingOn) {
      name = `on${word}`;
      tokenStart = pendingOn.start;
      pendingOn = null;
    }
    const token: RuneToken = { text: text.slice(tokenStart, end), start: tokenStart, end };
    tokens.push(token);
    const index = tokens.length - 1;
    const id = resolveName(name);
    if (!id) {
      at(index, 'UNKNOWN_RUNE', `"${name}" (word ${index + 1}) is not a rune.`);
      continue;
    }
    const affixes: RuneAffixes = {};
    let implicit: number | undefined;
    if (digits) setCount(index, id, Number(digits), affixes);
    for (const g of (groups ?? '').matchAll(/\(([^)]*)\)|\[([^\]]*)\]|\{([^}]*)\}/g)) {
      if (g[3] !== undefined) {
        // The implicit: "{104}" or "{104%}" is 104% of the rune's base; Split's "{1}" is one extra copy at most.
        const n = Number(g[3].trim().replace(/%$/, ''));
        if (g[3].trim() === '' || !Number.isFinite(n)) at(index, 'BAD_COUNT', `{${g[3]}} on ${runeName(id)} is not a number.`);
        else implicit = n;
      } else if (g[1] !== undefined) {
        // "(4)", or a ranged count "(2 to 4)" rolled on every cast.
        const range = /^\s*(\d+(?:\.\d+)?)\s+to\s+(\d+(?:\.\d+)?)\s*$/.exec(g[1]);
        const n = Number(g[1].trim());
        if (range?.[1] && range[2] && COUNT_AFFIX[id] === 'count' && Number(range[2]) > Number(range[1])) {
          affixes.count = Number(range[1]);
          affixes.countMax = Number(range[2]);
        } else if (g[1].trim() === '' || !Number.isFinite(n)) at(index, 'BAD_COUNT', `(${g[1]}) on ${runeName(id)} is not a number.`);
        else setCount(index, id, n, affixes);
      } else if (g[2] !== undefined) {
        for (const item of g[2].split(',')) {
          if (!applyAffix(item, affixes)) {
            at(index, 'UNKNOWN_AFFIX', `"${item.trim()}" on ${runeName(id)} (rune ${index + 1}) is not an affix.`);
          }
        }
      }
    }
    // Only add the rune when this token produced one, so runes and tokens stay aligned.
    if (runes.length === index) runes.push(implicit === undefined ? { id, affixes } : { id, affixes, implicit });
  }
  if (pendingOn) {
    tokens.push(pendingOn);
    at(tokens.length - 1, 'UNKNOWN_RUNE', '"on" needs a word after it, like "on hit".');
  }
  return { runes, tokens, errors };
}

/** Writes runes back in the text form `tokenizeSpell` reads. */
export function formatRunes(runes: readonly RuneInstance[]): string {
  return runes
    .map((r) => {
      const items: string[] = [];
      const a = r.affixes;
      if (a.release) {
        const k = a.release.kind;
        items.push(k === 'after' || k === 'every' ? `${k} ${a.release.seconds}s` : k);
      }
      for (const key of PERCENT_WORDS) {
        const v = a[key];
        if (v === undefined) continue;
        const high = key === 'damage' ? a.damageMax : undefined;
        items.push(high !== undefined && high > v ? `${v > 0 ? '+' : ''}${v} to ${high}% ${key}` : `${v > 0 ? '+' : ''}${v}% ${key}`);
      }
      for (const el of INFUSION_IDS) {
        const v = a[ADDED_KEYS[el]];
        if (v !== undefined) items.push(`adds ${v} to ${Number((v * ADDED_DAMAGE_SPREAD).toFixed(6))} ${el}`);
      }
      const count = COUNT_AFFIX[r.id];
      let suffix = '';
      for (const key of ['count', 'pierce', 'bounce', 'homing', 'chain', 'stackLimit', 'chargeStages', 'seconds', 'concentration'] as const) {
        const v = a[key];
        if (v === undefined) continue;
        const high = key === 'count' ? a.countMax : key === 'pierce' ? a.pierceMax : undefined;
        const shown = high !== undefined && high > v ? `${v} to ${high}` : `${v}`;
        if (key === count) suffix = `(${shown})`;
        else items.push(`${key === 'stackLimit' ? 'stack' : key === 'chargeStages' ? 'stages' : key} ${shown}`);
      }
      const implicit = r.implicit !== undefined && r.implicit !== neutralImplicitValue(r.id) ? `{${r.implicit}}` : '';
      return `${r.id}${suffix}${implicit}${items.length ? `[${items.join(', ')}]` : ''}`;
    })
    .join(' ');
}
