import { AFFIXES, CLASSES, ENEMY_AFFIX_TAGS, HEAT, MINION_DEFS, skillById, type SigilItem } from '@rune/shared';
import type { CSSProperties } from 'react';
import { cssColor } from '../render/config.js';
import { SkillIcon } from './icons.js';
import { keyLabel, useSettings } from './settings.js';

const SKILL_ACTIONS = ['skill1', 'skill2', 'skill3', 'skill4'] as const;
import { compileFor, itemByUid, useUi } from './store.js';

/** A Diablo-style globe. The liquid level is a clipped fill; the surface wobbles with a CSS animation. */
function Orb({ label, value, max, kind, danger }: { label: string; value: number; max: number; kind: 'life' | 'force'; danger?: boolean }) {
  const ratio = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  const style: CSSProperties & Record<'--level', string> = { '--level': `${(1 - ratio) * 100}%` };
  return (
    <div className={`orb ${kind}${danger ? ' danger' : ''}`} style={style} role="meter" aria-label={label} aria-valuenow={Math.round(value)} aria-valuemax={max}>
      <div className="orb-liquid" />
      <div className="orb-shine" />
      <span className="orb-value">
        {Math.round(value)}
        <small>/{max}</small>
      </span>
      <span className="orb-label">{label}</span>
    </div>
  );
}

function SkillSlot({ slot }: { slot: number }) {
  const inv = useUi((s) => s.inventory);
  const classId = useUi((s) => s.classId);
  const castCooldown = useUi((s) => s.castCooldown);
  const editorAllowed = useUi((s) => s.editorAllowed);
  const openEditor = useUi((s) => s.openEditor);
  const binding = useSettings((s) => s.bindings[SKILL_ACTIONS[slot] ?? 'skill1']);
  const uid = inv?.sigils[slot] ?? null;
  const item = itemByUid(inv, uid);
  const sigil: SigilItem | null = item?.kind === 'sigil' ? item : null;
  const result = sigil && classId ? compileFor(sigil, classId) : null;
  const persistent = result?.ok === true && result.persistent;
  const skill = skillById(sigil?.skill);
  const name = skill?.name ?? (sigil?.runes.length ? 'Custom skill' : 'Empty');
  const cost = !result ? '' : !result.ok ? 'unstable' : persistent ? `${result.spirit} spirit` : `${Math.round(result.heat)}`;
  const cd = persistent ? 0 : Math.min(1, castCooldown / HEAT.castCooldownSeconds);
  const sweep: CSSProperties & Record<'--cd', string> = { '--cd': `${cd * 360}deg` };

  return (
    <button
      type="button"
      className={`skill${persistent ? ' persistent' : ''}${result && !result.ok ? ' unstable' : ''}${sigil ? '' : ' empty'}`}
      onClick={() => uid !== null && editorAllowed && openEditor(uid)}
      title={skill ? `${skill.name}: ${skill.description}` : name}
    >
      {sigil && sigil.runes.length > 0 ? <SkillIcon runes={skill?.runes ?? sigil.runes} size={56} /> : <div className="skill-blank" />}
      {cd > 0 && <div className="skill-cd" style={sweep} />}
      <kbd className="skill-key">{keyLabel(binding)}</kbd>
      {cost && <span className={`skill-cost${result && !result.ok ? ' bad' : ''}`}>{cost}</span>}
      <span className="skill-name">{name}</span>
    </button>
  );
}

function Warband() {
  const classId = useUi((s) => s.classId);
  const inv = useUi((s) => s.inventory);
  const stance = useUi((s) => s.stance);
  const respawn = useUi((s) => s.minionRespawn);
  const stanceKey = useSettings((s) => s.bindings.stance);
  if (classId !== 'binder' || !inv) return null;
  return (
    <div className="warband">
      <span className="stance" title="Cycles minion stance">
        <kbd>{keyLabel(stanceKey)}</kbd> {stance}
      </span>
      {inv.warband.map((uid, slot) => {
        const item = itemByUid(inv, uid);
        if (!item || item.kind !== 'vessel') return <span key={slot} className="minion-pip empty" />;
        const t = respawn[slot] ?? 0;
        return (
          <span key={slot} className={`minion-pip${t > 0 ? ' down' : ''}`} style={{ borderColor: cssColor(MINION_DEFS[item.minion].color) }} title={item.name}>
            {t > 0 ? t : ''}
          </span>
        );
      })}
    </div>
  );
}

export function Hud() {
  const life = useUi((s) => s.life);
  const maxLife = useUi((s) => s.maxLife);
  const heat = useUi((s) => s.heat);
  const heatMax = useUi((s) => s.heatMax);
  const spiritMax = useUi((s) => s.spiritMax);
  const spiritReserved = useUi((s) => s.spiritReserved);
  const respawnIn = useUi((s) => s.respawnIn);
  const roomName = useUi((s) => s.roomName);
  const lowLife = maxLife > 0 && life / maxLife < 0.3;
  const spiritRatio = spiritMax > 0 ? spiritReserved / spiritMax : 0;
  return (
    <>
      {lowLife && respawnIn === null && <div className="low-life-vignette" />}
      <div className="hud">
        <Orb label="Life" value={life} max={maxLife} kind="life" danger={lowLife} />
        <div className="hud-center">
          <div className="spirit-bar" title={`Spirit reserved ${spiritReserved} / ${spiritMax}`}>
            <div style={{ width: `${spiritRatio * 100}%` }} />
            <span>
              Spirit {spiritReserved} / {spiritMax}
            </span>
          </div>
          <div className="skillbar">
            {[0, 1, 2, 3].map((slot) => (
              <SkillSlot key={slot} slot={slot} />
            ))}
          </div>
          <Warband />
        </div>
        <Orb label={HEAT.displayName} value={heat} max={Math.round(heatMax)} kind="force" danger={heat > heatMax} />
      </div>
      {respawnIn !== null && (
        <div className="death">
          <h2>You have fallen</h2>
          <p>
            Returning to {roomName || 'the camp'} in {respawnIn}
          </p>
        </div>
      )}
    </>
  );
}

export function Party() {
  const party = useUi((s) => s.party);
  const wave = useUi((s) => s.wave);
  const theme = useUi((s) => s.roomTheme);
  const playerId = useUi((s) => s.playerId);
  return (
    <aside className="party">
      {theme === 'arena' && <h3>Wave {wave}</h3>}
      {party.map((p) => (
        <div key={p.id} className={`party-row${p.dead ? ' dead' : ''}${p.id === playerId ? ' me' : ''}`}>
          <span className="dot" style={{ background: cssColor(CLASSES[p.cls].color) }} />
          <span className="pname">
            {p.name} <small>{CLASSES[p.cls].name}</small>
          </span>
          <div className="mini-bar">
            <div style={{ width: `${(p.life / Math.max(1, p.maxLife)) * 100}%` }} />
          </div>
        </div>
      ))}
    </aside>
  );
}

/** D2-style target frame: the hovered monster's name, level, life and affixes. */
export function TargetFrame() {
  const target = useUi((s) => s.target);
  if (!target) return null;
  const ratio = target.maxLife > 0 ? Math.max(0, target.life / target.maxLife) : 0;
  const kind = target.boss ? 'boss' : target.rare ? 'rare' : 'normal';
  return (
    <div className={`target-frame ${kind}`} role="status" aria-live="off">
      <div className="target-name">
        {target.name} <span className="target-level">Level {target.level}</span>
        {target.boss && <span className="target-tag">Boss</span>}
      </div>
      <div className="target-bar">
        <div style={{ width: `${ratio * 100}%` }} />
        <span>
          {Math.max(0, Math.ceil(target.life))} / {Math.round(target.maxLife)}
        </span>
      </div>
      {target.affixes.length > 0 && <div className="target-affixes">{target.affixes.map((a) => ENEMY_AFFIX_TAGS[a] ?? AFFIXES[a].nameWord).join(', ')}</div>}
    </div>
  );
}

export function RecordingBadge() {
  const recording = useUi((s) => s.recording);
  return recording ? (
    <div className="rec-badge" title="Recording a replay. F8 stops and saves it.">
      REC
    </div>
  ) : null;
}

export function Banner() {
  const banner = useUi((s) => s.banner);
  if (!banner) return null;
  return (
    <div key={banner.id} className="banner" role="status">
      <h2>{banner.title}</h2>
      <p>{banner.text}</p>
    </div>
  );
}

export function Notices() {
  const notices = useUi((s) => s.notices);
  return (
    <div className="notices" role="status" aria-live="polite">
      {notices.map((n) => (
        <div key={n.id} className="notice">
          {n.text}
        </div>
      ))}
    </div>
  );
}
