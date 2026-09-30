import { ENEMIES, ENEMY_TYPE_IDS, isEnemyTypeId, isMinionTypeId, MINION_DEFS, MINION_TYPE_IDS, MODEL_HEIGHT } from '@rune/shared';
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import type { AnimationClip, Group } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { instantiate, registerFile, unregisterFile, type AnimRole, type AssetDef } from '../../render/assets.js';
import { isTryOnKey, listTryOns, removeTryOn, saveTryOn, type TryOnEntry, type TryOnKey } from '../../render/tryOn.js';
import { newAssetEntry } from './exportText.js';
import { checkModel, guessRoles, type ModelFlags } from './modelChecks.js';
import { ModelStage, ROLES, type StageTarget } from './ModelStage.js';
import './monsters.css';

interface Loaded {
  seq: number;
  name: string;
  bytes: ArrayBuffer;
  scene: Group;
  clips: AnimationClip[];
  json: unknown;
}

let fileSeq = 0;

function typeName(key: TryOnKey): string {
  const [kind, id] = key.split(':');
  if (kind === 'monsters' && isEnemyTypeId(id)) return ENEMIES[id].name;
  if (kind === 'minions' && isMinionTypeId(id)) return `${MINION_DEFS[id].name} (minion)`;
  return key;
}

/**
 * Preview and checks for a local .glb before it goes into the repo. The file is read in the browser
 * and never uploaded; "Try on" stores it in this browser's IndexedDB for the game tab to draw.
 */
export function ModelCheckTab({ notify }: { notify: (t: string) => void }) {
  const [file, setFile] = useState<Loaded | null>(null);
  const [error, setError] = useState('');
  const [roles, setRoles] = useState<Partial<Record<AnimRole, string>>>({});
  const [height, setHeight] = useState(54);
  const [flags, setFlags] = useState<ModelFlags>({});
  const [tryKey, setTryKey] = useState<TryOnKey>('monsters:dire_wolf');
  const [tryOns, setTryOns] = useState<TryOnEntry[]>([]);
  const [entry, setEntry] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const refreshTryOns = () =>
    void listTryOns().then(setTryOns, () => {
      setTryOns([]);
    });
  useEffect(refreshTryOns, []);

  const open = async (f: File) => {
    setError('');
    setEntry(null);
    if (!/\.glb$/i.test(f.name)) return setError('Pick a binary glTF (.glb) file.');
    try {
      const bytes = await f.arrayBuffer();
      const gltf = await new GLTFLoader().parseAsync(bytes.slice(0), '');
      const json: unknown = gltf.parser.json;
      // Only the newest file stays registered; the page never shows two at once.
      unregisterFile(`check:${fileSeq}`);
      const seq = ++fileSeq;
      // Registered under a local name so the viewer builds it exactly as the game would.
      registerFile(`check:${seq}`, gltf.scene, gltf.animations);
      setFile({ seq, name: f.name, bytes, scene: gltf.scene, clips: gltf.animations, json });
      setRoles(guessRoles(gltf.animations.map((c) => c.name)));
      setFlags({});
    } catch (e) {
      setFile(null);
      setError(`Could not read the file: ${e instanceof Error ? e.message : 'unknown error'}`);
    }
  };

  const report = useMemo(() => (file ? checkModel({ scene: file.scene, clips: file.clips, json: file.json, bytes: file.bytes.byteLength, roles, flags }) : null), [file, roles, flags]);

  const heightOk = Number.isFinite(height) && height >= MODEL_HEIGHT.min && height <= MODEL_HEIGHT.max;
  const target = useMemo<StageTarget | null>(() => {
    if (!file || !heightOk) return null;
    const def: AssetDef = { id: `check_${file.seq}_${height}`, label: file.name, category: 'monster', url: `check:${file.seq}`, height, clips: roles };
    // The key only changes with the file or height; a role change just changes what a button plays.
    return { key: def.id, roles, load: () => instantiate(def) };
  }, [file, height, heightOk, roles]);

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) void open(f);
  };

  const tryOn = async () => {
    if (!file) return;
    try {
      await saveTryOn({ key: tryKey, fileName: file.name, bytes: file.bytes, height, clips: roles, savedAt: Date.now() });
      notify(`Trying ${file.name} on ${typeName(tryKey)} in this browser; new spawns in the game use it`);
      refreshTryOns();
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Could not store the file in this browser');
    }
  };

  const [kind, typeId] = tryKey.split(':');

  return (
    <div className="mon-layout mon-check">
      <aside className="mon-list">
        <div
          className={`mon-drop${dragging ? ' on' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <p>Drop a .glb here</p>
          <button type="button" onClick={() => input.current?.click()}>
            Pick a file
          </button>
          <input
            ref={input}
            type="file"
            accept=".glb,model/gltf-binary"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void open(f);
              e.target.value = '';
            }}
          />
          <p className="muted small">Read in this browser only; nothing is uploaded.</p>
        </div>
        {error && <p className="mon-error">{error}</p>}
        {file && (
          <>
            <h3 className="mon-file-name">{file.name}</h3>
            <label className="mon-field">
              <span>Height in game units (hero 54)</span>
              <input type="number" min={MODEL_HEIGHT.min} max={MODEL_HEIGHT.max} value={height} onChange={(e) => setHeight(Number(e.target.value))} className={heightOk ? '' : 'mon-bad'} />
            </label>
            <label className="mon-check-flag">
              <input type="checkbox" checked={flags.static === true} onChange={(e) => setFlags({ ...flags, static: e.target.checked })} />
              <span>Never moves (tower, totem): no walk needed</span>
            </label>
            <label className="mon-check-flag">
              <input type="checkbox" checked={flags.floats === true} onChange={(e) => setFlags({ ...flags, floats: e.target.checked })} />
              <span>Floats or burrows: its lowest part may hang below the rest</span>
            </label>
            <h3>Roles</h3>
            <table className="mon-table">
              <tbody>
                {ROLES.map((r) => (
                  <tr key={r}>
                    <th scope="row">{r}</th>
                    <td>
                      <select
                        value={roles[r] ?? ''}
                        aria-label={`Clip for ${r}`}
                        onChange={(e) => {
                          const next = { ...roles };
                          if (e.target.value === '') delete next[r];
                          else next[r] = e.target.value;
                          setRoles(next);
                        }}
                      >
                        <option value="">none</option>
                        {file.clips.map((c) => (
                          <option key={c.name} value={c.name}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </aside>

      <ModelStage target={target} arrow allClips note={file ? 'Gold arrow: the file\'s +Z, the way the game faces a model' : 'No file yet'} />

      <section className="mon-edit">
        {!report && <p className="muted">Drop a model to run the checks: triangles, file size, facing, feet, dark colours, looping clips, missing materials, roles, root motion and rig type.</p>}
        {report && (
          <>
            <h2>Checks</h2>
            <ul className="mon-checks">
              {report.checks.map((c) => (
                <li key={c.id} className={c.status}>
                  <span className="mon-pill">{c.status === 'pass' ? 'pass' : 'warn'}</span>
                  <div>
                    <b>{c.title}</b> {c.detail}
                    {c.fix && <div className="muted small">Fix: {c.fix}</div>}
                  </div>
                </li>
              ))}
            </ul>

            <h2>Try on a monster</h2>
            <p className="muted small">This browser only: open the game here (a /sandbox room is handy), and new spawns of the type use this model. Other players see nothing.</p>
            <div className="mon-actions">
              <select value={tryKey} aria-label="Monster type to try it on" onChange={(e) => isTryOnKey(e.target.value) && setTryKey(e.target.value)}>
                <optgroup label="Monsters">
                  {ENEMY_TYPE_IDS.map((id) => (
                    <option key={id} value={`monsters:${id}`}>
                      {ENEMIES[id].name}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Minions">
                  {MINION_TYPE_IDS.map((id) => (
                    <option key={id} value={`minions:${id}`}>
                      {MINION_DEFS[id].name}
                    </option>
                  ))}
                </optgroup>
              </select>
              <button type="button" className="primary" disabled={!heightOk} onClick={() => void tryOn()}>
                Try on
              </button>
            </div>
            {tryOns.length > 0 && (
              <ul className="mon-tryons">
                {tryOns.map((t) => (
                  <li key={t.key}>
                    {t.fileName} on {typeName(t.key)}{' '}
                    <button type="button" className="small" onClick={() => void removeTryOn(t.key).then(refreshTryOns)}>
                      Stop
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <h2>Asset entry</h2>
            <button
              type="button"
              disabled={!heightOk}
              onClick={() => {
                const text = newAssetEntry(file?.name ?? 'model.glb', height, roles, typeId ?? null, kind === 'minions' ? 'minions' : 'monsters');
                setEntry(text);
                void navigator.clipboard.writeText(text).then(
                  () => notify('Asset entry copied'),
                  () => notify('The browser refused the clipboard; copy it from the box'),
                );
              }}
            >
              Copy asset entry
            </button>
            {entry !== null && <textarea readOnly value={entry} rows={12} spellCheck={false} className="mono mon-entry" />}
          </>
        )}
      </section>
    </div>
  );
}
