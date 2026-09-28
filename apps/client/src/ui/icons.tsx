import { MINION_DEFS, RUNES, skillById, type FormId, type GearCategory, type Item, type RuneId } from '@rune/shared';
import { cssColor, ELEMENT_COLORS, TIER_COLORS } from '../render/config.js';

/**
 * Procedural SVG icons. Skills are drawn from their rune program (form glyph, element colour), so
 * a new skill gets a sensible icon with no art. Items use their tier colour and contents.
 */

const FORM_GLYPHS: Record<FormId, string> = {
  bolt: 'M12 52 L40 24 M40 24 L30 24 M40 24 L40 34 M20 44 L44 20',
  nova: 'M32 32 m-18 0 a18 18 0 1 0 36 0 a18 18 0 1 0 -36 0 M32 32 m-8 0 a8 8 0 1 0 16 0 a8 8 0 1 0 -16 0',
  zone: 'M10 40 Q32 26 54 40 Q32 54 10 40 Z M20 40 Q32 33 44 40',
  dash: 'M14 22 L28 32 L14 42 M28 22 L42 32 L28 42 M42 22 L52 32 L42 42',
  aura: 'M32 12 L36 28 L52 32 L36 36 L32 52 L28 36 L12 32 L28 28 Z',
  link: 'M20 38 a8 8 0 0 1 0 -12 l6 -6 a8 8 0 0 1 12 12 M44 26 a8 8 0 0 1 0 12 l-6 6 a8 8 0 0 1 -12 -12',
};

function runeColor(runes: readonly RuneId[]): number {
  for (const r of runes) {
    if (r === 'fire' || r === 'cold' || r === 'lightning') return ELEMENT_COLORS[r];
  }
  for (const r of runes) if (RUNES[r].category === 'effect') return RUNES[r].color;
  return 0xd0d8e8;
}

export function SkillIcon({ runes, size = 44, dim = false }: { runes: readonly RuneId[]; size?: number; dim?: boolean }) {
  const first = runes[0];
  const form: FormId = first === 'bolt' || first === 'nova' || first === 'zone' || first === 'dash' || first === 'aura' || first === 'link' ? first : 'bolt';
  const color = cssColor(runeColor(runes));
  const splits = runes.filter((r) => r === 'split').length;
  const triggered = runes.some((r) => RUNES[r].category === 'trigger');
  const id = `g${runes.join('')}`;
  return (
    <svg className="skill-icon" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" style={{ opacity: dim ? 0.45 : 1 }}>
      <defs>
        <radialGradient id={id} cx="50%" cy="40%" r="70%">
          <stop offset="0%" stopColor={color} stopOpacity="0.55" />
          <stop offset="100%" stopColor="#0a0806" stopOpacity="1" />
        </radialGradient>
      </defs>
      <rect x="1" y="1" width="62" height="62" rx="6" fill={`url(#${id})`} stroke="#6b5634" strokeWidth="2" />
      <path d={FORM_GLYPHS[form]} fill="none" stroke={color} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
      {splits > 0 && (
        <text x="50" y="58" fontSize="13" fontWeight="700" fill={color} textAnchor="middle">
          x{3 ** splits}
        </text>
      )}
      {triggered && <circle cx="52" cy="12" r="5" fill="#ffb347" stroke="#000" strokeWidth="1" />}
    </svg>
  );
}

/** Simple silhouettes per equipment category. */
const GEAR_GLYPHS: Record<GearCategory, string> = {
  weapon: 'M14 50 L44 20 L50 14 L48 22 L20 50 Z M18 40 L24 46',
  helmet: 'M14 40 Q14 16 32 14 Q50 16 50 40 L44 40 L44 30 L20 30 L20 40 Z',
  body: 'M20 14 L28 18 L36 18 L44 14 L52 24 L46 30 L46 52 L18 52 L18 30 L12 24 Z',
  gloves: 'M22 52 L22 28 L26 16 L30 28 L32 14 L36 28 L40 18 L42 30 L46 26 L44 40 L40 52 Z',
  boots: 'M22 12 L36 12 L36 40 L52 44 L52 52 L22 52 Z',
  belt: 'M8 28 L56 28 L56 38 L8 38 Z M28 26 L38 26 L38 40 L28 40 Z',
  amulet: 'M18 12 Q32 34 46 12 M32 34 L40 44 L32 54 L24 44 Z',
  ring: 'M32 18 a14 14 0 1 0 0.01 0 M32 24 a8 8 0 1 1 -0.01 0 M28 12 L36 12 L32 18 Z',
};

export function ItemIcon({ item, size = 44 }: { item: Item; size?: number }) {
  const tier = cssColor(TIER_COLORS[item.tier]);
  if (item.kind === 'gear') {
    return (
      <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
        <path d={GEAR_GLYPHS[item.category]} fill="#1a150f" stroke={tier} strokeWidth="2.5" strokeLinejoin="round" fillRule="evenodd" />
      </svg>
    );
  }
  if (item.kind === 'vessel') {
    const c = cssColor(MINION_DEFS[item.minion].color);
    return (
      <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
        <path d="M22 14 h20 l-2 8 q10 6 10 20 q0 12 -18 12 q-18 0 -18 -12 q0 -14 10 -20 z" fill="#1a140e" stroke={tier} strokeWidth="2.5" />
        <circle cx="32" cy="40" r="9" fill={c} opacity="0.85" />
        <circle cx="29" cy="38" r="2" fill="#000" />
        <circle cx="35" cy="38" r="2" fill="#000" />
      </svg>
    );
  }
  const skill = skillById(item.skill);
  const runes = skill ? skill.runes : item.runes;
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <path d="M32 4 L58 32 L32 60 L6 32 Z" fill="#120e0a" stroke={tier} strokeWidth="3" />
      {item.corrupted && <path d="M32 4 L58 32 L32 60 L6 32 Z" fill="none" stroke="#b01030" strokeWidth="1.5" strokeDasharray="4 3" />}
      {runes.length > 0 ? (
        <g transform="translate(16 16) scale(0.5)">
          <path d={FORM_GLYPHS[runes[0] === 'nova' || runes[0] === 'zone' || runes[0] === 'dash' || runes[0] === 'aura' || runes[0] === 'link' ? runes[0] : 'bolt']} fill="none" stroke={cssColor(runeColor(runes))} strokeWidth="6" strokeLinecap="round" />
        </g>
      ) : (
        <circle cx="32" cy="32" r="5" fill={tier} opacity="0.5" />
      )}
    </svg>
  );
}
