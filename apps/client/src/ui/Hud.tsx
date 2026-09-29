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

function XpBar() {
  const level = useUi((s) => s.level);
  const xp = useUi((s) => s.xp);
  const next = useUi((s) => s.xpNext);
  const ratio = next > 0 ? Math.min(1, xp / next) : 1;
  return (
    <div className="xp-bar" title={`${xp.toLocaleString()} / ${next.toLocaleString()} XP to level ${level + 1}`}>
      <div style={{ width: `${ratio * 100}%` }} />
      <span>
        Level {level} <small>{Math.floor(ratio * 100)}%</small>
      </span>
    </div>
  );
}

/** Mouse access to the panels, for anyone who does not know or has not bound the keys. */
function PanelButtons() {
  const invKey = useSettings((s) => s.bindings.inventory);
  const charKey = useSettings((s) => s.bindings.character);
  const invOpen = useUi((s) => s.inventoryOpen);
  const charOpen = useUi((s) => s.characterOpen);
  return (
    <div className="panel-buttons">
      <button type="button" className={invOpen ? 'on' : ''} onClick={() => useUi.getState().toggleInventory()} title={`Inventory (${keyLabel(invKey)})`} aria-label="Inventory">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M7 8V6a5 5 0 0 1 10 0v2h3l-1 13H5L4 8zm2 0h6V6a3 3 0 0 0-6 0z" />
        </svg>
      </button>
      <button type="button" className={charOpen ? 'on' : ''} onClick={() => useUi.setState((s) => ({ characterOpen: !s.characterOpen }))} title={`Character (${keyLabel(charKey)})`} aria-label="Character">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 3a4 4 0 1 1 0 8 4 4 0 0 1 0-8zm-7 18c0-4 3-7 7-7s7 3 7 7z" />
        </svg>
      </button>
      <button type="button" onClick={() => useUi.getState().toggleMenu()} title="Menu (Esc)" aria-label="Menu">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 6h16v2H4zm0 5h16v2H4zm0 5h16v2H4z" />
        </svg>
      </button>
    </div>
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
          <XpBar />
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
        <PanelButtons />
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
  const players = useUi((s) => s.party);
  const partyInfo = useUi((s) => s.partyInfo);
  const wave = useUi((s) => s.wave);
  const theme = useUi((s) => s.roomTheme);
  const playerId = useUi((s) => s.playerId);
  // Public worlds are shared with strangers, so the frame lists yourself and your party only.
  const members = new Set(partyInfo?.members.map((m) => m.name) ?? []);
  const shown = players.filter((p) => p.id === playerId || members.has(p.name));
  return (
    <aside className="party">
      {theme === 'arena' && <h3>Wave {wave}</h3>}
      {shown.map((p) => (
        <div key={p.id} className={`party-row${p.dead ? ' dead' : ''}${p.id === playerId ? ' me' : ''}`}>
          <span className="dot" style={{ background: cssColor(CLASSES[p.cls].color) }} />
          <span className="pname">
            {p.name} <small>Lv {p.level} {CLASSES[p.cls].name}</small>
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
