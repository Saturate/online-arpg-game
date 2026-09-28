export type RuneCategory = 'form' | 'element' | 'effect' | 'modifier' | 'trigger' | 'action';

export const RUNE_IDS = [
  'bolt',
  'nova',
  'zone',
  'dash',
  'aura',
  'link',
  'fire',
  'cold',
  'lightning',
  'impact',
  'ward',
  'restore',
  'swift',
  'large',
  'linger',
  'pierce',
  'timer',
  'onhit',
  'onexpire',
  'onland',
  'pulse',
  'split',
] as const;
export type RuneId = (typeof RUNE_IDS)[number];

export type FormId = 'bolt' | 'nova' | 'zone' | 'dash' | 'aura' | 'link';
export type ElementId = 'fire' | 'cold' | 'lightning';
export type EffectId = 'impact' | 'ward' | 'restore';
export type ModifierId = 'swift' | 'large' | 'linger' | 'pierce';
export type TriggerId = 'timer' | 'onhit' | 'onexpire' | 'onland' | 'pulse';

export interface RuneDef {
  id: RuneId;
  name: string;
  /** Placeholder for the future rune language. */
  syllable: string;
  category: RuneCategory;
  heatCost: number;
  /** Spirit this rune reserves when part of a persistent skill. */
  spiritCost?: number;
  persistent?: boolean;
  params?: Record<string, number>;
  /** Always true in the demo; used by rune knowledge later. */
  known?: boolean;
  color: number;
}

export const RUNES: Record<RuneId, RuneDef> = {
  bolt: { id: 'bolt', name: 'Bolt', syllable: 'ka', category: 'form', heatCost: 8, known: true, color: 0xd0d8e8 },
  nova: { id: 'nova', name: 'Nova', syllable: 'ro', category: 'form', heatCost: 14, known: true, color: 0xd0d8e8 },
  zone: { id: 'zone', name: 'Zone', syllable: 'ul', category: 'form', heatCost: 16, known: true, color: 0xd0d8e8 },
  dash: { id: 'dash', name: 'Dash', syllable: 'vi', category: 'form', heatCost: 12, known: true, color: 0xd0d8e8 },
  aura: {
    id: 'aura',
    name: 'Aura',
    syllable: 'om',
    category: 'form',
    heatCost: 0,
    spiritCost: 30,
    persistent: true,
    known: true,
    color: 0xd0d8e8,
  },
  link: {
    id: 'link',
    name: 'Link',
    syllable: 'te',
    category: 'form',
    heatCost: 0,
    spiritCost: 25,
    persistent: true,
    known: true,
    color: 0xd0d8e8,
  },
  fire: { id: 'fire', name: 'Fire', syllable: 'ig', category: 'element', heatCost: 4, spiritCost: 10, known: true, color: 0xff6a2b },
  cold: { id: 'cold', name: 'Cold', syllable: 'is', category: 'element', heatCost: 4, spiritCost: 10, known: true, color: 0x6ad0ff },
  lightning: {
    id: 'lightning',
    name: 'Lightning',
    syllable: 'az',
    category: 'element',
    heatCost: 5,
    spiritCost: 10,
    known: true,
    color: 0xf5e663,
  },
  impact: { id: 'impact', name: 'Impact', syllable: 'dru', category: 'effect', heatCost: 5, spiritCost: 10, known: true, color: 0xb08cff },
  ward: { id: 'ward', name: 'Ward', syllable: 'sel', category: 'effect', heatCost: 5, spiritCost: 12, known: true, color: 0x7fe0c0 },
  restore: {
    id: 'restore',
    name: 'Restore',
    syllable: 'ma',
    category: 'effect',
    heatCost: 6,
    spiritCost: 12,
    known: true,
    color: 0x8cf08c,
  },
  swift: { id: 'swift', name: 'Swift', syllable: 'fe', category: 'modifier', heatCost: 3, spiritCost: 5, known: true, color: 0xe0e0e0 },
  large: { id: 'large', name: 'Large', syllable: 'gor', category: 'modifier', heatCost: 3, spiritCost: 8, known: true, color: 0xe0e0e0 },
  linger: { id: 'linger', name: 'Linger', syllable: 'lo', category: 'modifier', heatCost: 3, spiritCost: 5, known: true, color: 0xe0e0e0 },
  pierce: { id: 'pierce', name: 'Pierce', syllable: 'tik', category: 'modifier', heatCost: 3, spiritCost: 5, known: true, color: 0xe0e0e0 },
  timer: { id: 'timer', name: 'Timer', syllable: 'nu', category: 'trigger', heatCost: 4, known: true, color: 0xffb347 },
  onhit: { id: 'onhit', name: 'On Hit', syllable: 'pa', category: 'trigger', heatCost: 4, known: true, color: 0xffb347 },
  onexpire: { id: 'onexpire', name: 'On Expire', syllable: 'mor', category: 'trigger', heatCost: 4, known: true, color: 0xffb347 },
  onland: { id: 'onland', name: 'On Land', syllable: 'da', category: 'trigger', heatCost: 4, known: true, color: 0xffb347 },
  pulse: { id: 'pulse', name: 'Pulse', syllable: 'vo', category: 'trigger', heatCost: 6, known: true, color: 0xffb347 },
  split: {
    id: 'split',
    name: 'Split',
    syllable: 'xi',
    category: 'action',
    heatCost: 6,
    params: { count: 3 },
    known: true,
    color: 0xff7eb6,
  },
};

export function isRuneId(value: unknown): value is RuneId {
  return typeof value === 'string' && RUNE_IDS.some((id) => id === value);
}

export function isFormId(id: RuneId): id is FormId {
  return RUNES[id].category === 'form';
}

export function isElementId(id: RuneId): id is ElementId {
  return RUNES[id].category === 'element';
}

export function isEffectId(id: RuneId): id is EffectId {
  return RUNES[id].category === 'effect';
}

export function isModifierId(id: RuneId): id is ModifierId {
  return RUNES[id].category === 'modifier';
}

export function isTriggerId(id: RuneId): id is TriggerId {
  return RUNES[id].category === 'trigger';
}

/** Which triggers each form supports. Aura and Link take none. */
export const TRIGGERS_FOR_FORM: Record<FormId, readonly TriggerId[]> = {
  bolt: ['onhit', 'onexpire', 'timer', 'pulse'],
  dash: ['onhit', 'onland', 'timer'],
  zone: ['onexpire', 'timer', 'pulse'],
  nova: ['timer'],
  aura: [],
  link: [],
};

export interface ComboDef {
  id: string;
  name: string;
  runes: readonly [RuneId, RuneId];
  description: string;
}

/** Hidden combos: matched when both runes attach to the same node. */
export const COMBOS: readonly ComboDef[] = [
  {
    id: 'burning_ward',
    name: 'Burning Ward',
    runes: ['ward', 'fire'],
    description: 'The ward also burns enemies that touch it.',
  },
  {
    id: 'frostfire',
    name: 'Frostfire',
    runes: ['fire', 'cold'],
    description: 'Deals both damage types and applies both ailments.',
  },
];
