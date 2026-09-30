import type { ElementId, SpellFx } from '@rune/shared';
import { Color } from 'three';

/**
 * What a spell looks like, from its element or, without one, what it does. Frostfire and other
 * mixes show their first element, which is all the snapshot carries.
 */
export type VfxStyle = 'fire' | 'cold' | 'lightning' | 'plain' | 'restore' | 'ward' | 'mixed';

export const STYLE_INDEX: Record<VfxStyle, number> = { plain: 0, fire: 1, cold: 2, lightning: 3, restore: 4, ward: 5, mixed: 6 };

export function styleOf(el: ElementId | null, fx: SpellFx): VfxStyle {
  if (el) return el;
  if (fx === 'heal') return 'restore';
  if (fx === 'ward') return 'ward';
  if (fx === 'mixed') return 'mixed';
  return 'plain';
}

/**
 * Embers, not neon: every style has a hot core, a body colour close to the old flat colour so a
 * spell is still recognised at a glance, a dark deep tone for charred edges and falloff, and the
 * colour of its smoke or mist. Hex values are sRGB; `linear` holds the same colours converted.
 */
interface PaletteHex {
  core: number;
  body: number;
  deep: number;
  smoke: number;
}

const HEX: Record<VfxStyle, PaletteHex> = {
  fire: { core: 0xffd8a0, body: 0xff6a24, deep: 0x7a2208, smoke: 0x2a221e },
  cold: { core: 0xd8eefa, body: 0x5ab4e0, deep: 0x1e4a70, smoke: 0x55697a },
  lightning: { core: 0xfffbe6, body: 0xeadc6a, deep: 0x6a5a20, smoke: 0x5a5a60 },
  plain: { core: 0xeae2d4, body: 0xa89a86, deep: 0x3e342a, smoke: 0x6a5e50 },
  restore: { core: 0xe4f6d4, body: 0x86c070, deep: 0x243e1e, smoke: 0x5a7a58 },
  ward: { core: 0xdcf4ee, body: 0x62b8a8, deep: 0x163e3a, smoke: 0x4a6a66 },
  mixed: { core: 0xece2f8, body: 0xa48ad8, deep: 0x302448, smoke: 0x5a5068 },
};

export interface StylePalette {
  core: Color;
  body: Color;
  deep: Color;
  smoke: Color;
}

function build(): Record<VfxStyle, StylePalette> {
  const out: Partial<Record<VfxStyle, StylePalette>> = {};
  for (const [style, hex] of Object.entries(HEX)) {
    if (!isStyle(style)) continue;
    out[style] = { core: new Color(hex.core), body: new Color(hex.body), deep: new Color(hex.deep), smoke: new Color(hex.smoke) };
  }
  return {
    fire: out.fire ?? fallback(),
    cold: out.cold ?? fallback(),
    lightning: out.lightning ?? fallback(),
    plain: out.plain ?? fallback(),
    restore: out.restore ?? fallback(),
    ward: out.ward ?? fallback(),
    mixed: out.mixed ?? fallback(),
  };
}

function fallback(): StylePalette {
  return { core: new Color(1, 1, 1), body: new Color(1, 1, 1), deep: new Color(0, 0, 0), smoke: new Color(0.3, 0.3, 0.3) };
}

function isStyle(v: string): v is VfxStyle {
  return v in STYLE_INDEX;
}

/** Linear colours (three converts sRGB hex on construction), read by emitters and uniforms. */
export const PALETTE: Record<VfxStyle, StylePalette> = build();

export const STYLES: readonly VfxStyle[] = ['plain', 'fire', 'cold', 'lightning', 'restore', 'ward', 'mixed'];
