import { DEFAULTS, isShapeId, MINION_DEFS, runeColor as runeTint, runeKind, runeName, toRuneInstance, type GearCategory, type Item, type RuneInstance, type ShapeId } from '@rune/shared';
import { useEffect, useId } from 'react';
import { cssColor, ELEMENT_COLORS, TIER_COLORS } from '../render/config.js';
import { requestModelIcon, useModelIcons } from './itemIconRenderer.js';
import { iconModelFor } from './itemView.js';

/**
 * Item and skill icons. Skills are drawn from their rune program (form glyph, element colour), so
 * a new skill gets a sensible icon with no art. Weapons and helmets with a matching KayKit mesh
 * show a render of it; everything else has a drawn, shaded silhouette per base type.
 */

const BOLT_GLYPH = 'M12 52 L40 24 M40 24 L30 24 M40 24 L40 34 M20 44 L44 20';

/** Shapes without their own glyph yet (the phase 4 ones) draw as a bolt. */
const SHAPE_GLYPHS: Partial<Record<ShapeId, string>> = {
  bolt: BOLT_GLYPH,
  orb: 'M32 32 m-14 0 a14 14 0 1 0 28 0 a14 14 0 1 0 -28 0 M26 28 a6 6 0 0 1 8 -4',
  nova: 'M32 32 m-18 0 a18 18 0 1 0 36 0 a18 18 0 1 0 -36 0 M32 32 m-8 0 a8 8 0 1 0 16 0 a8 8 0 1 0 -16 0',
  zone: 'M10 40 Q32 26 54 40 Q32 54 10 40 Z M20 40 Q32 33 44 40',
  dash: 'M14 22 L28 32 L14 42 M28 22 L42 32 L28 42 M42 22 L52 32 L42 42',
  aura: 'M32 12 L36 28 L52 32 L36 36 L32 52 L28 36 L12 32 L28 28 Z',
  bond: 'M20 38 a8 8 0 0 1 0 -12 l6 -6 a8 8 0 0 1 12 12 M44 26 a8 8 0 0 1 0 12 l-6 6 a8 8 0 0 1 -12 -12',
};

function glyphFor(runes: readonly RuneInstance[]): string {
  const first = runes[0]?.id;
  return (first && isShapeId(first) ? SHAPE_GLYPHS[first] : undefined) ?? BOLT_GLYPH;
}

function runeColor(runes: readonly RuneInstance[]): number {
  for (const { id } of runes) {
    if (id === 'fire' || id === 'cold' || id === 'lightning') return ELEMENT_COLORS[id];
  }
  for (const { id } of runes) if (runeKind(id) === 'effect') return runeTint(id);
  return 0xd0d8e8;
}

export function SkillIcon({ runes, size = 44, dim = false }: { runes: readonly RuneInstance[]; size?: number; dim?: boolean }) {
  const glyph = glyphFor(runes);
  const color = cssColor(runeColor(runes));
  const copies = runes.reduce((n, r) => (r.id === 'split' ? n * (r.affixes.count ?? DEFAULTS.splitCount) : n), 1);
  const triggered = runes.some((r) => runeKind(r.id) === 'trigger' || r.affixes.release !== undefined);
  const id = `g${useId().replace(/:/g, '')}`;
  return (
    <svg className="skill-icon" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" style={{ opacity: dim ? 0.45 : 1 }}>
      <defs>
        <radialGradient id={id} cx="50%" cy="40%" r="70%">
          <stop offset="0%" stopColor={color} stopOpacity="0.55" />
          <stop offset="100%" stopColor="#0a0806" stopOpacity="1" />
        </radialGradient>
      </defs>
      <rect x="1" y="1" width="62" height="62" rx="6" fill={`url(#${id})`} stroke="#6b5634" strokeWidth="2" />
      <path d={glyph} fill="none" stroke={color} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
      {copies > 1 && (
        <text x="50" y="58" fontSize="13" fontWeight="700" fill={color} textAnchor="middle">
          x{copies}
        </text>
      )}
      {triggered && <circle cx="52" cy="12" r="5" fill="#ffb347" stroke="#000" strokeWidth="1" />}
    </svg>
  );
}

// ---------------------------------------------------------------------------------------------
// Drawn gear

type Material = 'metal' | 'dark' | 'rust' | 'wood' | 'leather' | 'cloth' | 'silk' | 'bone' | 'gold' | 'rope' | 'jade' | 'coral' | 'moon' | 'arcane';

/** Two-stop gradients: lit side then shaded side. */
const MATERIALS: Record<Material, readonly [string, string]> = {
  metal: ['#e8edf2', '#7c8490'],
  dark: ['#8a8f99', '#3c4048'],
  rust: ['#c98a5a', '#6a3a20'],
  wood: ['#b07a44', '#5a3818'],
  leather: ['#a8744a', '#5a3a20'],
  cloth: ['#d6c49a', '#8a7650'],
  silk: ['#a48ae0', '#4a3480'],
  bone: ['#f4ecd8', '#b0a080'],
  gold: ['#ffe9a0', '#b08420'],
  rope: ['#d8b878', '#8a6a34'],
  jade: ['#8af0b8', '#1f8a54'],
  coral: ['#ffb0a0', '#c0402c'],
  moon: ['#e8f4ff', '#6a8ac8'],
  arcane: ['#b8f4ff', '#3a8ad8'],
};

interface Part {
  d: string;
  m: Material;
}

/** One entry per base in GEAR_BASES, in a 64x64 box. Later parts draw on top. */
const BASE_ART: Readonly<Record<string, readonly Part[]>> = {
  rusty_axe: [
    { d: 'M17 55 L20 58 L46 20 L43 17 Z', m: 'wood' },
    { d: 'M38 12 Q56 8 58 28 Q50 22 42 26 L36 20 Z', m: 'rust' },
  ],
  war_axe: [
    { d: 'M15 56 L18 59 L47 18 L44 15 Z', m: 'wood' },
    { d: 'M41 6 Q60 6 60 26 Q52 20 46 22 L40 14 Z', m: 'metal' },
    { d: 'M40 14 Q26 8 24 26 Q32 22 38 24 Z', m: 'metal' },
  ],
  short_bow: [
    { d: 'M22 6 Q48 32 22 58 L25 58 Q52 32 25 6 Z', m: 'wood' },
    { d: 'M23 7 L23 57 L24 57 L24 7 Z', m: 'cloth' },
  ],
  recurve_bow: [
    { d: 'M18 4 Q30 6 32 14 Q44 32 32 50 Q30 58 18 60 L20 57 Q28 54 29 48 Q40 32 29 16 Q28 10 20 7 Z', m: 'dark' },
    { d: 'M19 6 L19 58 L20 58 L20 6 Z', m: 'cloth' },
    { d: 'M30 28 L36 28 L36 36 L30 36 Z', m: 'leather' },
  ],
  gnarled_staff: [
    { d: 'M18 58 L21 60 Q30 44 34 30 Q38 20 44 12 L41 10 Q34 18 31 28 Q26 44 18 58 Z', m: 'wood' },
    { d: 'M40 4 Q52 6 50 16 Q46 22 40 18 Q34 12 40 4 Z', m: 'wood' },
    { d: 'M42 9 Q47 10 46 14 Q44 16 42 14 Z', m: 'jade' },
  ],
  runed_staff: [
    { d: 'M16 58 L19 61 L44 20 L41 17 Z', m: 'dark' },
    { d: 'M38 20 L46 12 L50 16 L42 24 Z', m: 'gold' },
    { d: 'M44 4 a8 8 0 1 0 0.1 0 Z', m: 'arcane' },
  ],
  bone_wand: [
    { d: 'M18 50 L22 54 L44 26 L40 22 Z', m: 'bone' },
    { d: 'M36 14 Q48 8 52 18 Q54 28 44 30 Q34 30 34 22 Q34 16 36 14 Z', m: 'bone' },
    { d: 'M40 20 a2.5 2.5 0 1 0 0.1 0 M47 19 a2.5 2.5 0 1 0 0.1 0', m: 'dark' },
  ],
  grave_sceptre: [
    { d: 'M16 56 L20 60 L42 26 L38 22 Z', m: 'dark' },
    { d: 'M40 8 L44 16 L52 14 L48 22 L56 26 L48 30 L50 38 L42 32 L36 38 L36 30 L28 28 L34 22 L30 14 L38 16 Z', m: 'bone' },
    { d: 'M42 23 a3 3 0 1 0 0.1 0 Z', m: 'jade' },
  ],
  leather_cap: [
    { d: 'M12 42 Q12 16 32 14 Q52 16 52 42 Z', m: 'leather' },
    { d: 'M8 42 L56 42 L54 48 L10 48 Z', m: 'leather' },
    { d: 'M30 14 L34 14 L34 42 L30 42 Z', m: 'dark' },
  ],
  iron_helm: [
    { d: 'M12 44 Q10 12 32 10 Q54 12 52 44 L44 52 L20 52 Z', m: 'metal' },
    { d: 'M18 30 L46 30 L46 35 L18 35 Z', m: 'dark' },
    { d: 'M30 30 L34 30 L34 50 L30 50 Z', m: 'metal' },
  ],
  circlet: [
    { d: 'M8 36 Q32 20 56 36 L56 42 Q32 26 8 42 Z', m: 'gold' },
    { d: 'M32 18 L38 28 L32 34 L26 28 Z', m: 'arcane' },
  ],
  padded_vest: [
    { d: 'M20 10 L28 14 L36 14 L44 10 L52 20 L46 26 L46 56 L18 56 L18 26 L12 20 Z', m: 'cloth' },
    { d: 'M20 30 L44 30 L44 32 L20 32 Z M20 40 L44 40 L44 42 L20 42 Z M31 14 L33 14 L33 56 L31 56 Z', m: 'leather' },
  ],
  chain_mail: [
    { d: 'M18 10 L28 14 L36 14 L46 10 L56 22 L48 28 L48 58 L16 58 L16 28 L8 22 Z', m: 'metal' },
    { d: 'M22 24 h4 v4 h-4 Z M30 24 h4 v4 h-4 Z M38 24 h4 v4 h-4 Z M26 32 h4 v4 h-4 Z M34 32 h4 v4 h-4 Z M22 40 h4 v4 h-4 Z M30 40 h4 v4 h-4 Z M38 40 h4 v4 h-4 Z M26 48 h4 v4 h-4 Z M34 48 h4 v4 h-4 Z', m: 'dark' },
  ],
  silk_robe: [
    { d: 'M24 8 L32 14 L40 8 L50 18 L44 24 L54 60 L10 60 L20 24 L14 18 Z', m: 'silk' },
    { d: 'M30 14 L34 14 L36 60 L28 60 Z', m: 'gold' },
  ],
  wraps: [
    { d: 'M22 54 L22 26 Q22 16 32 16 Q42 16 42 26 L44 40 L40 54 Z', m: 'cloth' },
    { d: 'M22 30 L42 26 L42 29 L22 33 Z M22 38 L43 34 L43 37 L22 41 Z M22 46 L42 42 L42 45 L22 49 Z', m: 'leather' },
  ],
  gauntlets: [
    { d: 'M20 56 L20 30 Q20 14 32 14 Q46 14 46 28 L48 44 L42 56 Z', m: 'metal' },
    { d: 'M20 34 L46 30 L46 34 L20 38 Z M22 46 L46 42 L46 46 L22 50 Z', m: 'dark' },
    { d: 'M44 24 Q54 26 52 36 L46 34 Z', m: 'metal' },
  ],
  spellweave_gloves: [
    { d: 'M20 56 L20 28 Q20 16 32 16 Q44 16 44 28 L46 42 L42 56 Z', m: 'silk' },
    { d: 'M32 30 L36 38 L32 46 L28 38 Z', m: 'arcane' },
  ],
  sandals: [
    { d: 'M16 50 Q16 44 24 44 L52 46 Q58 48 56 54 L18 56 Q16 54 16 50 Z', m: 'leather' },
    { d: 'M24 44 L26 26 L30 26 L30 45 Z M34 45 L42 32 L45 34 L39 46 Z', m: 'rope' },
  ],
  greaves: [
    { d: 'M22 8 L38 8 L38 38 L54 44 L54 54 L20 54 L20 40 Z', m: 'metal' },
    { d: 'M22 18 L38 18 L38 21 L22 21 Z M20 46 L54 48 L54 51 L20 51 Z', m: 'dark' },
  ],
  rope_belt: [
    { d: 'M6 28 Q32 22 58 28 L58 34 Q32 28 6 34 Z', m: 'rope' },
    { d: 'M30 32 Q26 44 24 52 L28 52 Q30 44 33 34 Z M34 32 Q38 44 40 50 L36 50 Q34 42 32 34 Z', m: 'rope' },
  ],
  heavy_belt: [
    { d: 'M4 26 L60 26 L60 38 L4 38 Z', m: 'leather' },
    { d: 'M24 22 L40 22 L40 42 L24 42 Z', m: 'metal' },
    { d: 'M28 27 L36 27 L36 37 L28 37 Z', m: 'dark' },
  ],
  bone_amulet: [
    { d: 'M16 8 Q32 36 48 8 L46 8 Q32 32 18 8 Z', m: 'rope' },
    { d: 'M28 30 Q32 26 36 30 L34 52 Q32 56 30 52 Z', m: 'bone' },
  ],
  jade_amulet: [
    { d: 'M16 8 Q32 34 48 8 L46 8 Q32 30 18 8 Z', m: 'gold' },
    { d: 'M32 28 L42 40 L32 54 L22 40 Z', m: 'jade' },
  ],
  iron_ring: [
    { d: 'M32 16 a16 16 0 1 0 0.1 0 Z M32 24 a8 8 0 1 1 -0.1 0 Z', m: 'dark' },
  ],
  coral_ring: [
    { d: 'M32 22 a14 14 0 1 0 0.1 0 Z M32 28 a8 8 0 1 1 -0.1 0 Z', m: 'gold' },
    { d: 'M32 8 a7 7 0 1 0 0.1 0 Z', m: 'coral' },
  ],
  moonstone_ring: [
    { d: 'M32 22 a14 14 0 1 0 0.1 0 Z M32 28 a8 8 0 1 1 -0.1 0 Z', m: 'metal' },
    { d: 'M32 8 a7 7 0 1 0 0.1 0 Z', m: 'moon' },
  ],
};

/** For tests: every base in GEAR_BASES should have its own art rather than the slot fallback. */
export function hasGearArt(base: string): boolean {
  return BASE_ART[base] !== undefined;
}

/** When a base has no art (a new base added later), its slot's silhouette stands in. */
const CATEGORY_FALLBACK: Record<GearCategory, string> = {
  weapon: 'war_axe',
  helmet: 'iron_helm',
  body: 'chain_mail',
  gloves: 'gauntlets',
  boots: 'greaves',
  belt: 'heavy_belt',
  amulet: 'jade_amulet',
  ring: 'iron_ring',
};

function GearArt({ base, category }: { base: string; category: GearCategory }) {
  const parts = BASE_ART[base] ?? BASE_ART[CATEGORY_FALLBACK[category]] ?? [];
  const uid = useId().replace(/:/g, '');
  const used = [...new Set(parts.map((p) => p.m))];
  return (
    <>
      <defs>
        {used.map((m) => (
          <linearGradient key={m} id={`${uid}${m}`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={MATERIALS[m][0]} />
            <stop offset="100%" stopColor={MATERIALS[m][1]} />
          </linearGradient>
        ))}
      </defs>
      {parts.map((p, i) => (
        <path key={i} d={p.d} fill={`url(#${uid}${p.m})`} stroke="#0b0907" strokeWidth="1.4" strokeLinejoin="round" fillRule="evenodd" />
      ))}
    </>
  );
}

/** Empty paperdoll slots show a faint outline of what goes there, instead of a word. */
export function SlotSilhouette({ category, size = 40 }: { category: GearCategory; size?: number }) {
  const parts = BASE_ART[CATEGORY_FALLBACK[category]] ?? [];
  return (
    <svg className="slot-silhouette" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      {parts.map((p, i) => (
        <path key={i} d={p.d} fill="currentColor" fillRule="evenodd" />
      ))}
    </svg>
  );
}

function ModelOrArt({ item, size }: { item: Extract<Item, { kind: 'gear' }>; size: number }) {
  const found = iconModelFor(item);
  const url = useModelIcons((s) => (found ? s.urls[found.key] : undefined));
  useEffect(() => {
    if (found) requestModelIcon(found.key, found.model);
  }, [found?.key]);
  if (url) return <img className="item-model" src={url} width={size} height={size} alt="" draggable={false} />;
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <GearArt base={item.base} category={item.category} />
    </svg>
  );
}

export function ItemIcon({ item, size = 44 }: { item: Item; size?: number }) {
  if (item.kind === 'gear') return <ModelOrArt item={item} size={size} />;
  if (item.kind === 'vessel') return <VesselIcon item={item} size={size} />;
  if (item.kind === 'rune') return <RuneIcon item={item} size={size} />;
  return <SigilIcon item={item} size={size} />;
}

/** A carved stone with the rune's first letters, tinted by the rune, and the stack count in the corner. Rolled runes get a second, brighter rim. */
function RuneIcon({ item, size }: { item: Extract<Item, { kind: 'rune' }>; size: number }) {
  const c = cssColor(runeTint(item.rune));
  const rolled = item.affixes.length > 0;
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <path d="M32 6 L54 18 L54 46 L32 58 L10 46 L10 18 Z" fill="#1c1813" stroke={c} strokeWidth="3" />
      {rolled && <path d="M32 11 L50 21 L50 43 L32 53 L14 43 L14 21 Z" fill="none" stroke={cssColor(TIER_COLORS.magic)} strokeWidth="1.5" />}
      <text x="32" y="40" textAnchor="middle" fontSize="18" fontWeight="700" fill={c} fontFamily="Cinzel, serif">
        {runeName(item.rune).slice(0, 2)}
      </text>
      {item.count > 1 && (
        <text x="56" y="60" textAnchor="end" fontSize="16" fontWeight="700" fill="#f0e6d0" stroke="#000" strokeWidth="3" paintOrder="stroke">
          {item.count}
        </text>
      )}
    </svg>
  );
}

function VesselIcon({ item, size }: { item: Extract<Item, { kind: 'vessel' }>; size: number }) {
  const c = cssColor(MINION_DEFS[item.minion].color);
  const uid = useId().replace(/:/g, '');
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <linearGradient id={`${uid}jar`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#5a4a3a" />
          <stop offset="100%" stopColor="#1a130c" />
        </linearGradient>
        <radialGradient id={`${uid}soul`} cx="50%" cy="45%" r="55%">
          <stop offset="0%" stopColor="#fff" stopOpacity="0.9" />
          <stop offset="35%" stopColor={c} stopOpacity="0.95" />
          <stop offset="100%" stopColor={c} stopOpacity="0.15" />
        </radialGradient>
      </defs>
      <path d="M24 8 h16 v6 h-2 v4 q14 6 14 22 q0 16 -20 16 q-20 0 -20 -16 q0 -16 14 -22 v-4 h-2 Z" fill={`url(#${uid}jar)`} stroke="#0b0907" strokeWidth="1.4" />
      <ellipse cx="32" cy="40" rx="12" ry="11" fill={`url(#${uid}soul)`} />
      <circle cx="28" cy="38" r="2.2" fill="#0b0907" />
      <circle cx="36" cy="38" r="2.2" fill="#0b0907" />
      <path d="M22 8 h20 v4 h-20 Z" fill="#8a7a5a" stroke="#0b0907" strokeWidth="1.2" />
    </svg>
  );
}

function SigilIcon({ item, size }: { item: Extract<Item, { kind: 'sigil' }>; size: number }) {
  const tier = cssColor(TIER_COLORS[item.tier]);
  const runes = item.slots.map(toRuneInstance);
  const glyph = glyphFor(runes);
  const color = cssColor(runeColor(runes));
  const uid = useId().replace(/:/g, '');
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <radialGradient id={`${uid}core`} cx="50%" cy="45%" r="60%">
          <stop offset="0%" stopColor={color} stopOpacity="0.45" />
          <stop offset="100%" stopColor="#0b0907" stopOpacity="1" />
        </radialGradient>
      </defs>
      <path d="M32 3 L59 32 L32 61 L5 32 Z" fill={`url(#${uid}core)`} stroke={tier} strokeWidth="2.5" strokeLinejoin="round" />
      <path d="M32 9 L53 32 L32 55 L11 32 Z" fill="none" stroke="#0b0907" strokeOpacity="0.6" strokeWidth="1" />
      {item.corrupted && <path d="M32 3 L59 32 L32 61 L5 32 Z" fill="none" stroke="#c01838" strokeWidth="1.6" strokeDasharray="4 3" />}
      {runes.length > 0 ? (
        <g transform="translate(14 14) scale(0.56)">
          <path d={glyph} fill="none" stroke={color} strokeWidth="6.5" strokeLinecap="round" strokeLinejoin="round" />
        </g>
      ) : (
        <circle cx="32" cy="32" r="5" fill={tier} opacity="0.5" />
      )}
    </svg>
  );
}
