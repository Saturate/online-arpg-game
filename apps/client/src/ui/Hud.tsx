import { AFFIXES, CLASSES, describeTree, ENEMY_AFFIX_TAGS, HEAT, MINION_DEFS, starterSigilById, toRuneInstance, type SigilCompile, type SigilItem } from '@rune/shared';
import { useState, type CSSProperties } from 'react';
import { cssColor } from '../render/config.js';
import { SkillIcon } from './icons.js';
import { keyLabel, useSettings } from './settings.js';

const SKILL_ACTIONS = ['skill1', 'skill2', 'skill3', 'skill4'] as const;
import { spiritUses } from './spirit.js';
import { compileFor, itemByUid, pickSkill, swapSkills, useUi } from './store.js';

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

/** What a skill does and costs, above its slot: the spell sentence and its Force or spirit. */
function SkillPop({ name, description, result }: { name: string; description: string | null; result: SigilCompile | null }) {
  return (
    <div className="skill-pop panel" role="tooltip">
      <h4>{name}</h4>
      {description && <p className="muted">{description}</p>}
      {result?.ok && <p className="skill-pop-sentence">{describeTree(result.tree)}</p>}
      {result?.ok && (
        <p className="skill-pop-cost">{result.persistent ? `Reserves ${result.spirit} spirit while equipped` : `${Math.round(result.force)} ${HEAT.displayName} per cast`}</p>
      )}
      {result && !result.ok && <p className="skill-pop-bad">Fizzles: {result.errors[0]?.message ?? 'the runes do not make a spell'}</p>}
      <p className="skill-pop-hint">Left or right click puts it on that mouse button</p>
    </div>
  );
}

/** Drag type for reordering the skill bar; kept apart from item drags so the two never mix. */
const SKILL_DRAG = 'application/x-rune-skill-slot';

function SkillSlot({ slot }: { slot: number }) {
  const inv = useUi((s) => s.inventory);
  const classId = useUi((s) => s.classId);
  const castCooldown = useUi((s) => s.castCooldown);
  const editorAllowed = useUi((s) => s.forgeOpen || (s.editorAllowed && s.devTools));
  const openEditor = useUi((s) => s.openEditor);
  const binding = useSettings((s) => s.bindings[SKILL_ACTIONS[slot] ?? 'skill1']);
  const onLeft = useUi((s) => s.leftSkill === slot);
  const onRight = useUi((s) => s.rightSkill === slot);
  const uid = inv?.sigils[slot] ?? null;
  const item = itemByUid(inv, uid);
  const sigil: SigilItem | null = item?.kind === 'sigil' ? item : null;
  const result = sigil && classId ? compileFor(sigil, classId) : null;
  const persistent = result?.ok === true && result.persistent;
  const skill = starterSigilById(sigil?.starter);
  const name = skill?.name ?? (!sigil ? 'Empty' : sigil.slots.length ? sigil.name : 'Blank sigil');
  const [hovered, setHovered] = useState(false);
  const cost = !result ? '' : !result.ok ? 'fizzles' : persistent ? `${result.spirit} spirit` : `${Math.round(result.force)}`;
  const cd = persistent ? 0 : Math.min(1, castCooldown / HEAT.castCooldownSeconds);
  const sweep: CSSProperties & Record<'--cd', string> = { '--cd': `${cd * 360}deg` };

  return (
    <button
      type="button"
      className={`skill${persistent ? ' persistent' : ''}${result && !result.ok ? ' unstable' : ''}${sigil ? '' : ' empty'}${onLeft || onRight ? ' active' : ''}`}
      // Left-click puts the skill on the left mouse button, right-click on the right one. At the
      // forge (or on a builder's bench) a second left-click on the left skill opens the sigil editor.
      onClick={() => {
        if (onLeft && uid !== null && editorAllowed) openEditor(uid);
        else pickSkill('left', slot);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        pickSkill('right', slot);
      }}
      // Drag a skill onto another slot to reorder the bar.
      draggable={sigil !== null}
      onDragStart={(e) => {
        e.dataTransfer.setData(SKILL_DRAG, String(slot));
        e.dataTransfer.effectAllowed = 'move';
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(SKILL_DRAG)) e.preventDefault();
      }}
      onDrop={(e) => {
        e.preventDefault();
        const from = Number(e.dataTransfer.getData(SKILL_DRAG));
        if (Number.isInteger(from) && from >= 0 && from < 4) swapSkills(from, slot);
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      aria-label={`${name}${skill ? `: ${skill.description}` : ''}`}
    >
      {hovered && sigil && <SkillPop name={name} description={skill?.description ?? null} result={sigil.slots.length > 0 ? result : null} />}
      {sigil && sigil.slots.length > 0 ? <SkillIcon runes={sigil.slots.map(toRuneInstance)} size={56} /> : <div className="skill-blank" />}
      {cd > 0 && <div className="skill-cd" style={sweep} />}
      <kbd className="skill-key">{keyLabel(binding)}</kbd>
      {(onLeft || onRight) && <span className="skill-rmb">{onLeft && onRight ? 'L+R' : onLeft ? 'LMB' : 'RMB'}</span>}
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

/**
 * Spirit as a segmented bar: one segment per persistent skill or bound minion, the rest free.
 * Hovering lists what holds how much, so it is clear what to take off to fit something new.
 */
function SpiritBar() {
  const spiritMax = useUi((s) => s.spiritMax);
  const reserved = useUi((s) => s.spiritReserved);
  const inv = useUi((s) => s.inventory);
  const classId = useUi((s) => s.classId);
  const [open, setOpen] = useState(false);
  const uses = inv && classId ? spiritUses(inv, classId) : [];
  const free = Math.max(0, spiritMax - reserved);
  const pct = (n: number) => `${spiritMax > 0 ? (n / spiritMax) * 100 : 0}%`;
  return (
    <div className="spirit-bar" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      {uses.map((u) => (
        <div key={u.key} className={`spirit-seg ${u.kind}`} style={{ width: pct(u.spirit) }} />
      ))}
      <span>
        Spirit {reserved} reserved · {free} free
      </span>
      {open && (
        <div className="spirit-pop panel" role="tooltip">
          <h4>
            Spirit {reserved} / {spiritMax}
          </h4>
          {uses.length === 0 ? (
            <p className="muted">Nothing reserved. Persistent skills (auras, links) and bound minions each hold some spirit while equipped.</p>
          ) : (
            <ul>
              {uses.map((u) => (
                <li key={u.key}>
                  <i className={`spirit-dot ${u.kind}`} />
                  {u.name}
                  <b>{u.spirit}</b>
                </li>
              ))}
              <li className="free">
                <i className="spirit-dot" />
                Free
                <b>{free}</b>
              </li>
            </ul>
          )}
        </div>
      )}
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
        // Only bound minions show: the warband is as big as spirit allows, so empty slots are noise.
        if (!item || item.kind !== 'vessel') return null;
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
  const respawnIn = useUi((s) => s.respawnIn);
  const roomName = useUi((s) => s.roomName);
  const arena = useUi((s) => s.arena);
  const scoreScreen = useUi((s) => s.arenaResult !== null);
  const lowLife = maxLife > 0 && life / maxLife < 0.3;
  return (
    <>
      {lowLife && respawnIn === null && <div className="low-life-vignette" />}
      <div className="hud">
        <Orb label="Life" value={life} max={maxLife} kind="life" danger={lowLife} />
        <div className="hud-center">
          <XpBar />
          <SpiritBar />
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
      {respawnIn !== null && !(arena && scoreScreen) && (
        <div className="death">
          <h2>You have fallen</h2>
          {/* One life in the Arena: the fallen watch the rest of the party until the run ends. */}
          {arena ? (
            <p>{arena.alive > 0 ? `${arena.alive} still fighting. Watch them, or leave by town portal (Esc).` : 'The run is over.'}</p>
          ) : (
            <p>
              Returning to {roomName || 'the camp'} in {respawnIn}
            </p>
          )}
        </div>
      )}
    </>
  );
}

export function Party() {
  const players = useUi((s) => s.party);
  const partyInfo = useUi((s) => s.partyInfo);
  const arena = useUi((s) => s.arena);
  const playerId = useUi((s) => s.playerId);
  // Public worlds are shared with strangers, so the frame lists yourself and your party only.
  const members = new Set(partyInfo?.members.map((m) => m.name) ?? []);
  const shown = players.filter((p) => p.id === playerId || members.has(p.name));
  return (
    <aside className="party">
      {arena && (
        <div className="arena-status">
          <h3>Wave {arena.wave}</h3>
          <b>{arena.score.toLocaleString()}</b>
          {arena.nextWaveIn !== null && <small>{arena.wave === 0 ? 'First wave' : 'Next wave'} in {arena.nextWaveIn}</small>}
        </div>
      )}
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
