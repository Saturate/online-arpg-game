import {
  ABILITY_FIELDS,
  ABILITY_NUMBER_KEYS,
  ABILITY_NUMBERS,
  abilityDefault,
  can,
  emptyTuning,
  ENEMIES,
  ENEMY_STAT_KEYS,
  ENEMY_STATS,
  ENEMY_TYPE_IDS,
  enemyStatDefault,
  enemyStatKeys,
  familyOf,
  isEnemyTypeId,
  isMinionTypeId,
  isMonsterModelId,
  MINION_DEFS,
  MINION_STAT_KEYS,
  MINION_STATS,
  MINION_TYPE_IDS,
  MODEL_HEIGHT,
  MONSTER_MODEL_IDS,
  type AbilityPatch,
  type EnemyOverride,
  type EnemyTypeId,
  type MinionOverride,
  type MinionTypeId,
  type MonsterModelId,
  type NumberSpec,
  type Role,
  type TuningOverrides,
} from '@rune/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { buildBuiltin, bakeClips, BUILTIN_MODELS } from '../../dev/builtinModels.js';
import { assetById, instantiate, type AnimRole } from '../../render/assets.js';
import { ENEMY_ASSETS, MINION_ASSETS, sizedAsset } from '../../render/characters.js';
import { exportOverrides } from './exportText.js';
import { ModelStage, type StageTarget } from './ModelStage.js';
import { tuningApi } from './tuningApi.js';
import { searchId, type Jump } from '../tabs.js';
import './monsters.css';

type Kind = 'monsters' | 'minions';

interface Field {
  /** `life`, or `abilities.0.cooldown` for an ability's number. */
  path: string;
  spec: NumberSpec;
  code: number;
}

interface Section {
  title: string;
  note?: string;
  fields: Field[];
}

interface TypeInfo {
  id: string;
  name: string;
  group: string;
  sections: Section[];
  defaultModel: string | undefined;
  codeRadius: number;
  /** The built-in procedural model's id in dev/builtinModels.ts, for types without a model file. */
  builtinId: string;
}

/** An override as the editor holds it: numbers by path, plus the model. */
interface Draft {
  values: Record<string, number>;
  model: MonsterModelId | null;
  height: number | null;
}

const EMPTY_DRAFT: Draft = { values: {}, model: null, height: null };

function isOneOf<K extends string>(keys: readonly K[], v: string): v is K {
  return keys.some((k) => k === v);
}

function enemyInfo(id: EnemyTypeId): TypeInfo {
  const def = ENEMIES[id];
  const sections: Section[] = [{ title: 'Stats', fields: enemyStatKeys(def).map((k) => ({ path: k, spec: ENEMY_STATS[k], code: enemyStatDefault(def, k) })) }];
  if (def.behaviour === 'monster') {
    def.abilities.forEach((a, i) => {
      const tags = [a.kind === 'summon' ? `summons ${ENEMIES[a.type].name}` : null, 'element' in a && a.element ? a.element : null, 'atSelf' in a && a.atSelf ? 'on itself' : null, a.enragedOnly ? 'enraged only' : null];
      sections.push({
        title: `Ability ${i + 1}: ${a.kind}`,
        note: tags.filter((t): t is string => t !== null).join(', '),
        fields: ABILITY_FIELDS[a.kind].map((k) => ({ path: `abilities.${i}.${k}`, spec: ABILITY_NUMBERS[k], code: abilityDefault(a, k) })),
      });
    });
  }
  return { id, name: def.name, group: familyOf(id), sections, defaultModel: ENEMY_ASSETS[id], codeRadius: def.radius, builtinId: id };
}

function minionInfo(id: MinionTypeId): TypeInfo {
  const def = MINION_DEFS[id];
  return {
    id,
    name: def.name,
    group: def.ranged ? 'ranged' : 'melee',
    sections: [{ title: 'Stats', fields: MINION_STAT_KEYS.map((k) => ({ path: k, spec: MINION_STATS[k], code: def[k] })) }],
    defaultModel: MINION_ASSETS[id],
    codeRadius: def.radius,
    builtinId: `minion_${id}`,
  };
}

function draftOf(o: EnemyOverride | MinionOverride | undefined): Draft {
  if (!o) return EMPTY_DRAFT;
  const values: Record<string, number> = {};
  for (const [k, v] of Object.entries(o)) if (typeof v === 'number' && k !== 'height') values[k] = v;
  if ('abilities' in o && o.abilities) {
    for (const [i, patch] of Object.entries(o.abilities)) for (const [k, v] of Object.entries(patch ?? {})) if (typeof v === 'number') values[`abilities.${i}.${k}`] = v;
  }
  return { values, model: o.model ?? null, height: o.height ?? null };
}

function enemyOverrideOf(id: EnemyTypeId, d: Draft): EnemyOverride {
  const out: EnemyOverride = {};
  const def = ENEMIES[id];
  const list = def.behaviour === 'monster' ? def.abilities : [];
  const abilities: Partial<Record<string, AbilityPatch>> = {};
  for (const [path, v] of Object.entries(d.values)) {
    const [head, index, key] = path.split('.');
    const ability = index === undefined ? undefined : list[Number(index)];
    if (head === 'abilities' && index !== undefined && ability && key !== undefined && isOneOf(ABILITY_NUMBER_KEYS, key)) {
      // The kind travels with the numbers so the server can tell if the ability list changed.
      const patch = abilities[index] ?? { kind: ability.kind };
      patch[key] = v;
      abilities[index] = patch;
    } else if (head !== undefined && isOneOf(ENEMY_STAT_KEYS, head)) out[head] = v;
  }
  if (Object.keys(abilities).length > 0) out.abilities = abilities;
  if (d.model) out.model = d.model;
  if (d.height !== null) out.height = d.height;
  return out;
}

function minionOverrideOf(d: Draft): MinionOverride {
  const out: MinionOverride = {};
  for (const [k, v] of Object.entries(d.values)) if (isOneOf(MINION_STAT_KEYS, k)) out[k] = v;
  if (d.model) out.model = d.model;
  if (d.height !== null) out.height = d.height;
  return out;
}

function sameDraft(a: Draft, b: Draft): boolean {
  const ka = Object.keys(a.values).filter((k) => a.values[k] !== undefined);
  const kb = Object.keys(b.values).filter((k) => b.values[k] !== undefined);
  return a.model === b.model && a.height === b.height && ka.length === kb.length && ka.every((k) => a.values[k] === b.values[k]);
}

function savedFor(kind: Kind, id: string, saved: TuningOverrides): EnemyOverride | MinionOverride | undefined {
  if (kind === 'monsters') return isEnemyTypeId(id) ? saved.monsters[id] : undefined;
  return isMinionTypeId(id) ? saved.minions[id] : undefined;
}

function outOfRange(spec: NumberSpec, v: number): boolean {
  return !Number.isFinite(v) || v < spec.min || v > spec.max || (spec.int === true && !Number.isInteger(v));
}

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  // Revoked on the next task: some browsers start the download only after the click handler returns.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** The model the viewer shows for a type with the draft applied, the same way the game builds it. */
function stageTarget(kind: Kind, info: TypeInfo, draft: Draft): StageTarget {
  const radius = draft.values.radius ?? info.codeRadius;
  const base = assetById(draft.model ?? info.defaultModel ?? '');
  const asset = base ? sizedAsset(base, draft.height ?? undefined) : undefined;
  if (asset) {
    return {
      key: `${kind}:${info.id}:${asset.id}:${radius}`,
      roles: asset.clips ?? {},
      load: async () => {
        const inst = await instantiate(asset);
        // The game scales models with the collision radius (see attachCharacter in entities.ts).
        inst.root.scale.multiplyScalar(radius / info.codeRadius);
        return inst;
      },
    };
  }
  const builtin = BUILTIN_MODELS.find((b) => b.id === info.builtinId);
  const roles: Partial<Record<AnimRole, string>> = { idle: 'Idle', walk: 'Walk', run: 'Walk', attack: 'Attack' };
  return {
    key: `${kind}:${info.id}:builtin:${radius}`,
    roles,
    load: async () => {
      if (!builtin) throw new Error('This type has no model');
      const sized = { ...builtin, radius };
      const rig = buildBuiltin(sized);
      return { root: rig.root, clips: bakeClips(rig, sized) };
    },
  };
}

function fmt(n: number): string {
  return String(Number(n.toFixed(4)));
}

function NumberRow({ field, value, saved, editable, onChange }: { field: Field; value: number | undefined; saved: number | undefined; editable: boolean; onChange: (v: number | undefined) => void }) {
  const [text, setText] = useState(value === undefined ? '' : String(value));
  useEffect(() => setText(value === undefined ? '' : String(value)), [value]);
  const shown = value ?? field.code;
  const bad = value !== undefined && outOfRange(field.spec, value);
  const unsaved = value !== saved;
  const overridden = saved !== undefined;
  return (
    <tr className={overridden ? 'mon-over' : ''}>
      <th scope="row">{field.spec.label}</th>
      <td>
        <input
          type="number"
          step="any"
          value={text}
          placeholder={fmt(field.code)}
          disabled={!editable}
          aria-invalid={bad}
          className={bad ? 'mon-bad' : ''}
          aria-label={field.spec.label}
          onChange={(e) => {
            setText(e.target.value);
            if (e.target.value.trim() === '') onChange(undefined);
            else {
              const n = Number(e.target.value);
              if (Number.isFinite(n)) onChange(n === field.code ? undefined : n);
            }
          }}
        />
      </td>
      <td className="muted small" title={`Allowed ${field.spec.min} to ${field.spec.max}`}>
        code {fmt(field.code)}
      </td>
      <td>
        <div className="mon-mark">
          {overridden && <span className="badge gold" title={`Saved override: ${fmt(saved)}`}>override</span>}
          {unsaved && <span className="badge" title={`Was ${fmt(saved ?? field.code)}`}>unsaved</span>}
          {shown !== field.code && editable && (
            <button type="button" className="small" title="Back to the code default" onClick={() => onChange(undefined)}>
              reset
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

export function TuningTab({ kind, token, role, notify, focus }: { kind: Kind; token: string; role: Role; notify: (t: string) => void; focus: Jump | null }) {
  const editable = can(role, 'settings');
  const infos = useMemo(() => (kind === 'monsters' ? ENEMY_TYPE_IDS.map(enemyInfo) : MINION_TYPE_IDS.map(minionInfo)), [kind]);
  const [saved, setSaved] = useState<TuningOverrides>(emptyTuning);
  const [selected, setSelected] = useState<string>(() => infos[0]?.id ?? '');
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [exported, setExported] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (focus) {
      setSearch('');
      setSelected(focus.target);
    }
  }, [focus]);

  const load = useCallback(async () => {
    const [m, n] = await Promise.all([tuningApi.monsters(token), tuningApi.minions(token)]);
    if (!m.ok) return notify(m.error);
    if (!n.ok) return notify(n.error);
    setSaved({ monsters: m.data, minions: n.data });
  }, [token, notify]);

  useEffect(() => {
    void load();
  }, [load]);

  const info = infos.find((i) => i.id === selected) ?? infos[0];
  const savedOverride = info ? savedFor(kind, info.id, saved) : undefined;
  const savedDraft = useMemo(() => draftOf(savedOverride), [savedOverride]);
  useEffect(() => setDraft(savedDraft), [savedDraft, selected]);

  const overriddenIds = new Set(Object.keys(kind === 'monsters' ? saved.monsters : saved.minions));
  const q = search.trim().toLowerCase();
  const shown = infos.filter((i) => q === '' || i.name.toLowerCase().includes(q) || i.id.includes(q) || i.group.includes(q));
  const groups = [...new Set(shown.map((i) => i.group))];
  const dirty = !sameDraft(draft, savedDraft);
  const hasBad = info?.sections.some((s) => s.fields.some((f) => {
    const v = draft.values[f.path];
    return v !== undefined && outOfRange(f.spec, v);
  })) ?? false;
  const heightBad = draft.height !== null && (draft.height < MODEL_HEIGHT.min || draft.height > MODEL_HEIGHT.max);

  const target = useMemo(() => (info ? stageTarget(kind, info, draft) : null), [kind, info, draft]);

  if (!info) return <p className="muted">Nothing to show.</p>;

  const setValue = (path: string, v: number | undefined) => {
    const values = { ...draft.values };
    if (v === undefined) delete values[path];
    else values[path] = v;
    setDraft({ ...draft, values });
  };

  /** PUT with the draft, or DELETE; either way the server answers with that kind's overrides. */
  const send = async (resetType: boolean) => {
    setBusy(true);
    const id = info.id;
    let next: TuningOverrides | string | null = null;
    if (kind === 'monsters' && isEnemyTypeId(id)) {
      const r = resetType ? await tuningApi.resetMonster(token, id) : await tuningApi.saveMonster(token, id, enemyOverrideOf(id, draft));
      next = r.ok ? { ...saved, monsters: r.data } : r.error;
    } else if (kind === 'minions' && isMinionTypeId(id)) {
      const r = resetType ? await tuningApi.resetMinion(token, id) : await tuningApi.saveMinion(token, id, minionOverrideOf(draft));
      next = r.ok ? { ...saved, minions: r.data } : r.error;
    }
    setBusy(false);
    if (next === null) return;
    if (typeof next === 'string') return notify(next);
    setSaved(next);
    notify(resetType ? `${info.name} is back to the code defaults` : `${info.name} saved; new spawns use it`);
  };

  const effectiveModel = draft.model ?? info.defaultModel;
  const modelAsset = assetById(effectiveModel ?? '');

  return (
    <div className="mon-layout">
      <aside className="mon-list">
        <input type="search" placeholder={`Search ${kind}`} value={search} onChange={(e) => setSearch(e.target.value)} aria-label={`Search ${kind}`} />
        {groups.map((g) => (
          <section key={g}>
            <h3>{g}</h3>
            <ul>
              {shown
                .filter((i) => i.group === g)
                .map((i) => (
                  <li key={i.id}>
                    <button type="button" className={i.id === info.id ? 'on' : ''} onClick={() => setSelected(i.id)} data-search-id={searchId(kind, i.id)}>
                      {i.name}
                      {overriddenIds.has(i.id) && <span className="mon-dot" title="Has overrides" />}
                    </button>
                  </li>
                ))}
            </ul>
          </section>
        ))}
        <button type="button" className="wide" onClick={() => setExported(exportOverrides(saved))}>
          Export overrides
        </button>
      </aside>

      <ModelStage target={target} note={modelAsset ? `${modelAsset.label}, ${draft.height ?? modelAsset.height} tall` : 'Built in code (models.ts)'} />

      <section className="mon-edit">
        <header>
          <h2>{info.name}</h2>
          <span className="muted small mono">{info.id}</span>
          {overriddenIds.has(info.id) && <span className="badge gold">overridden</span>}
        </header>
        {!editable && <p className="muted small">Your role can look but not change numbers; that takes the settings permission.</p>}
        {editable && (
          <div className="mon-actions">
            <button type="button" className="primary" disabled={!dirty || hasBad || heightBad || busy} onClick={() => void send(false)}>
              Save
            </button>
            <button type="button" disabled={!dirty || busy} onClick={() => setDraft(savedDraft)}>
              Revert
            </button>
            <button type="button" className="danger" disabled={!overriddenIds.has(info.id) || busy} onClick={() => void send(true)} title="Delete every override on this type">
              Reset type
            </button>
          </div>
        )}
        <p className="muted small">New spawns use saved numbers at once; monsters already alive keep theirs.</p>

        <h3>Model</h3>
        <table className="mon-table">
          <tbody>
            <tr className={savedDraft.model ? 'mon-over' : ''}>
              <th scope="row">Model</th>
              <td colSpan={2}>
                <select
                  value={draft.model ?? ''}
                  disabled={!editable}
                  aria-label="Model"
                  onChange={(e) => {
                    const v = e.target.value;
                    setDraft({ ...draft, model: isMonsterModelId(v) && v !== info.defaultModel ? v : null });
                  }}
                >
                  <option value="">Code default: {info.defaultModel ? (assetById(info.defaultModel)?.label ?? info.defaultModel) : 'built in code'}</option>
                  {MONSTER_MODEL_IDS.map((m) => (
                    <option key={m} value={m}>
                      {assetById(m)?.label ?? m}
                    </option>
                  ))}
                </select>
              </td>
              <td className="mon-mark">
                {savedDraft.model && <span className="badge gold">override</span>}
                {draft.model !== savedDraft.model && <span className="badge">unsaved</span>}
              </td>
            </tr>
            <tr className={savedDraft.height !== null ? 'mon-over' : ''}>
              <th scope="row">Height</th>
              <td>
                <input
                  type="number"
                  step="any"
                  disabled={!editable || !modelAsset}
                  value={draft.height ?? ''}
                  placeholder={modelAsset ? String(modelAsset.height) : 'no model file'}
                  aria-label="Model height"
                  className={heightBad ? 'mon-bad' : ''}
                  onChange={(e) => {
                    const n = e.target.value.trim() === '' ? null : Number(e.target.value);
                    setDraft({ ...draft, height: n === null || !Number.isFinite(n) || n === modelAsset?.height ? null : n });
                  }}
                />
              </td>
              <td className="muted small">{modelAsset ? `model ${modelAsset.height}` : 'procedural'}</td>
              <td>
                <div className="mon-mark">
                  {savedDraft.height !== null && <span className="badge gold">override</span>}
                  {draft.height !== savedDraft.height && <span className="badge">unsaved</span>}
                </div>
              </td>
            </tr>
          </tbody>
        </table>

        {info.sections.map((s) => (
          <div key={s.title}>
            <h3>
              {s.title} {s.note ? <span className="muted small">{s.note}</span> : null}
            </h3>
            <table className="mon-table">
              <tbody>
                {s.fields.map((f) => (
                  <NumberRow key={f.path} field={f} value={draft.values[f.path]} saved={savedDraft.values[f.path]} editable={editable} onChange={(v) => setValue(f.path, v)} />
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </section>

      {exported !== null && (
        <div className="mon-modal" role="dialog" aria-label="Exported overrides">
          <div className="mon-modal-box">
            <h2>Export</h2>
            <p className="muted small">Paste into the files named in the comments, commit, deploy, then reset the listed types here.</p>
            <textarea readOnly value={exported} rows={22} spellCheck={false} className="mono" />
            <div className="mon-actions">
              <button
                type="button"
                className="primary"
                onClick={() =>
                  void navigator.clipboard.writeText(exported).then(
                    () => notify('Copied to the clipboard'),
                    () => notify('The browser refused the clipboard; use Download'),
                  )
                }
              >
                Copy
              </button>
              <button type="button" onClick={() => download(`tuning-${new Date().toISOString().slice(0, 10)}.ts.txt`, exported)}>
                Download
              </button>
              <button type="button" onClick={() => setExported(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
