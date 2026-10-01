import {
  CLASSES,
  ENEMIES,
  ENEMY_TYPE_IDS,
  familyOf,
  MINION_DEFS,
  MINION_TYPE_IDS,
  ROLE_INFO,
  TUNABLES,
  TUNING_CATEGORY_NAMES,
  type AdminTokenInfo,
  type Role,
  type SearchAccount,
  type ServerEvent,
  type ServerSettings,
} from '@rune/shared';
import type { Check } from '../monsters/modelChecks.js';
import { tabVisible, type Tab } from '../tabs.js';

/**
 * Search everywhere on the admin page (docs/features/admin-ui.md). Pure, so ranking and the
 * permission filter run in tests without a browser. Entries come from data the page already has or
 * that ships with the code; players and log lines come from `GET /api/admin/search`, which leaves
 * out what the role may not see before it gets here.
 */

export type SearchKind = 'player' | 'character' | 'setting' | 'tuning' | 'monster' | 'minion' | 'modelCheck' | 'token' | 'log';

export const KIND_NAMES: Record<SearchKind, string> = {
  player: 'Account',
  character: 'Character',
  setting: 'Setting',
  tuning: 'Tuning',
  monster: 'Monster',
  minion: 'Minion',
  modelCheck: 'Model check',
  token: 'API token',
  log: 'Log',
};

export interface SearchEntry {
  /** Unique across every source, for React keys. */
  id: string;
  kind: SearchKind;
  tab: Tab;
  /** The `data-search-id` suffix the tab gives the element to focus. */
  target: string;
  title: string;
  detail: string;
  /** Other text that should find it: paths, ids, categories. */
  terms: readonly string[];
}

/**
 * The Settings tab's fields, by the setting they edit. A Record so a new setting fails the build until
 * it is searchable. The three clock fields share one control.
 */
export const SETTING_LABELS: Record<keyof ServerSettings, { label: string; target: string; terms?: string[] }> = {
  xpRate: { label: 'XP rate', target: 'xpRate', terms: ['experience'] },
  lootRate: { label: 'Loot rate', target: 'lootRate', terms: ['drops'] },
  motd: { label: 'Message of the day', target: 'motd', terms: ['motd', 'welcome'] },
  registrationOpen: { label: 'Registration open', target: 'registrationOpen', terms: ['signup', 'new accounts'] },
  worldSeed: { label: 'World seed', target: 'worldSeed' },
  dayMinutes: { label: 'Day length', target: 'dayMinutes', terms: ['night', 'cycle'] },
  nightBrightness: { label: 'Night brightness', target: 'nightBrightness', terms: ['dark'] },
  timeOfDay: { label: 'Time of day', target: 'timeOfDay', terms: ['clock', 'hold'] },
  clockOffset: { label: 'Time of day (clock offset)', target: 'timeOfDay', terms: ['clock'] },
  heldPhase: { label: 'Time of day (held)', target: 'timeOfDay', terms: ['clock', 'hold'] },
  heroLight: { label: 'Hero light at night', target: 'heroLight', terms: ['light'] },
  heroLightRadius: { label: 'Hero light reach', target: 'heroLightRadius', terms: ['light', 'radius'] },
  lampLight: { label: 'Lamps and torches', target: 'lampLight', terms: ['light', 'torch'] },
  forceMax: { label: 'Force bar', target: 'forceMax' },
  forceCostRate: { label: 'Force cost', target: 'forceCostRate' },
  forceCoolRate: { label: 'Force cooling', target: 'forceCoolRate' },
  forceRampMax: { label: 'Cooling ramp', target: 'forceRampMax', terms: ['force'] },
  zoomDefault: { label: 'Camera zoom', target: 'zoomDefault' },
  zoomDungeon: { label: 'Camera zoom in dungeons', target: 'zoomDungeon' },
  zoomMin: { label: 'Furthest zoom out', target: 'zoomMin', terms: ['camera'] },
  zoomMax: { label: 'Closest zoom in', target: 'zoomMax', terms: ['camera'] },
  respawnMinutes: { label: 'Monster respawn', target: 'respawnMinutes' },
  bossRespawnMinutes: { label: 'Boss respawn', target: 'bossRespawnMinutes' },
  gateRespawnMinutes: { label: 'Gate boss respawn', target: 'gateRespawnMinutes' },
  bossLifeMultiplier: { label: 'Boss life', target: 'bossLifeMultiplier' },
  bossDamageMultiplier: { label: 'Boss damage', target: 'bossDamageMultiplier' },
  castCooldownSeconds: { label: 'Cast cooldown', target: 'castCooldownSeconds', terms: ['spell'] },
};

/** What the model checker looks at, so "root motion" finds the tab that checks it. */
export const MODEL_CHECK_NAMES: Record<Check['id'], string> = {
  triangles: 'Triangle count',
  size: 'File size',
  facing: 'Facing',
  feet: 'Feet on the ground',
  colours: 'Dark colours',
  loops: 'Looping clips',
  materials: 'Missing materials',
  roles: 'Animation roles',
  rootMotion: 'Root motion',
  rig: 'Rig type',
};

function settingEntries(): SearchEntry[] {
  const keys = Object.keys(SETTING_LABELS).filter((k): k is keyof ServerSettings => k in SETTING_LABELS);
  return keys.map((key) => {
    const s = SETTING_LABELS[key];
    return { id: `setting:${key}`, kind: 'setting', tab: 'settings', target: s.target, title: s.label, detail: key, terms: [key, ...(s.terms ?? [])] };
  });
}

/** Everything that ships with the code: settings, tuning numbers, monsters, minions, model checks. */
export function staticEntries(): SearchEntry[] {
  const out: SearchEntry[] = settingEntries();
  for (const t of TUNABLES) {
    const category = TUNING_CATEGORY_NAMES[t.category];
    out.push({ id: `tuning:${t.path}`, kind: 'tuning', tab: 'tuning', target: t.path, title: t.label, detail: `${category}${t.group ? `, ${t.group}` : ''} · ${t.path}`, terms: [t.path, category, t.group ?? ''] });
  }
  for (const id of ENEMY_TYPE_IDS) {
    out.push({ id: `monster:${id}`, kind: 'monster', tab: 'monsters', target: id, title: ENEMIES[id].name, detail: `${familyOf(id)} · ${id}`, terms: [id, familyOf(id)] });
  }
  for (const id of MINION_TYPE_IDS) {
    out.push({ id: `minion:${id}`, kind: 'minion', tab: 'minions', target: id, title: MINION_DEFS[id].name, detail: id, terms: [id] });
  }
  for (const [id, name] of Object.entries(MODEL_CHECK_NAMES)) {
    out.push({ id: `modelCheck:${id}`, kind: 'modelCheck', tab: 'modelCheck', target: 'drop', title: name, detail: 'Checked when a model is dropped', terms: [id, 'glb', 'model'] });
  }
  return out;
}

export function tokenEntries(tokens: readonly AdminTokenInfo[]): SearchEntry[] {
  return tokens.map((t) => ({ id: `token:${t.id}`, kind: 'token', tab: 'tokens', target: t.id, title: t.name, detail: `${t.createdBy} · ${t.scopes.join(', ')}`, terms: [t.id, t.createdBy, ...t.scopes] }));
}

/** Model files tried on in this browser (Model check, "Try on"). */
export function tryOnEntries(tryOns: readonly { key: string; fileName: string }[]): SearchEntry[] {
  return tryOns.map((t) => ({ id: `tryon:${t.key}`, kind: 'modelCheck', tab: 'modelCheck', target: 'drop', title: t.fileName, detail: `Tried on ${t.key.split(':')[1] ?? t.key}`, terms: [t.key] }));
}

/** An account and each of its characters, all landing on the account's row in Players. */
export function accountEntries(accounts: readonly SearchAccount[]): SearchEntry[] {
  return accounts.flatMap((a) => {
    const badges = [a.role !== 'player' ? ROLE_INFO[a.role].name : '', a.guest ? 'guest' : '', a.banned ? 'banned' : ''].filter((b) => b !== '');
    const account: SearchEntry = { id: `player:${a.id}`, kind: 'player', tab: 'players', target: String(a.id), title: a.username, detail: [`${a.characters.length} character${a.characters.length === 1 ? '' : 's'}`, ...badges].join(' · '), terms: a.characters.map((c) => c.name) };
    const chars = a.characters.map((c): SearchEntry => ({ id: `character:${c.id}`, kind: 'character', tab: 'players', target: String(a.id), title: c.name, detail: `${CLASSES[c.classId].name} ${c.level} · ${a.username}`, terms: [a.username] }));
    return [account, ...chars];
  });
}

export function logEntries(lines: readonly ServerEvent[]): SearchEntry[] {
  return lines.map((e) => ({ id: `log:${e.id}`, kind: 'log', tab: 'log', target: String(e.id), title: e.text, detail: `${e.kind} · ${new Date(e.at).toLocaleTimeString()}`, terms: [e.kind] }));
}

/** Only what the role's tabs show: a result must never lead to a tab the role cannot open. */
export function allowedEntries(entries: readonly SearchEntry[], role: Role): SearchEntry[] {
  return entries.filter((e) => tabVisible(role, e.tab));
}

const WORD_START = /[\s._:/()-]/;

/** How well one query word matches one text, both lower case: whole, start, word start, anywhere. */
function wordScore(text: string, word: string): number {
  if (text === word) return 100;
  if (text.startsWith(word)) return 80;
  let at = text.indexOf(word);
  while (at > 0) {
    if (WORD_START.test(text.charAt(at - 1))) return 60;
    at = text.indexOf(word, at + 1);
  }
  return text.includes(word) ? 35 : 0;
}

/**
 * Log lines are many and noisy, so they sort below a named thing that matches as well; players come
 * first, since they are what staff look up most.
 */
const KIND_WEIGHT: Record<SearchKind, number> = { player: 6, character: 5, setting: 4, tuning: 3, monster: 3, minion: 3, token: 3, modelCheck: 1, log: -15 };

export function scoreEntry(entry: SearchEntry, query: string): number {
  const q = query.trim().toLowerCase();
  if (q === '') return 0;
  const title = entry.title.toLowerCase();
  const terms = entry.terms.map((t) => t.toLowerCase());
  let total = 0;
  for (const word of q.split(/\s+/)) {
    // A term match counts for less than a title match, so "fire" puts Fireball above a path containing it.
    const best = Math.max(wordScore(title, word), ...terms.map((t) => wordScore(t, word) * 0.7));
    if (best === 0) return 0;
    total += best;
  }
  if (q.includes(' ') && title.includes(q)) total += 40;
  return total + KIND_WEIGHT[entry.kind];
}

/** The best `limit` matches, best first; ties go to the shorter title. */
export function rankEntries(entries: readonly SearchEntry[], query: string, limit = 30): SearchEntry[] {
  const scored: { e: SearchEntry; s: number }[] = [];
  for (const e of entries) {
    const s = scoreEntry(e, query);
    if (s > 0) scored.push({ e, s });
  }
  scored.sort((a, b) => b.s - a.s || a.e.title.length - b.e.title.length);
  return scored.slice(0, limit).map((x) => x.e);
}
