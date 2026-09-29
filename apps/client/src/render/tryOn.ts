import { isEnemyTypeId, isMinionTypeId, type EnemyTypeId, type MinionTypeId } from '@rune/shared';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { registerFile, type AnimRole, type AssetDef } from './assets.js';
import { clearTryOns, setTryOn } from './characters.js';

/**
 * "Try on monster" from the admin page's Model check: a local .glb drawn in place of a monster type,
 * in this browser only. The file sits in IndexedDB (same origin as the game), never on the server,
 * and a BroadcastChannel tells an open game tab to pick up the change.
 */

export type TryOnKey = `monsters:${EnemyTypeId}` | `minions:${MinionTypeId}`;

export interface TryOnEntry {
  key: TryOnKey;
  fileName: string;
  bytes: ArrayBuffer;
  height: number;
  clips: Partial<Record<AnimRole, string>>;
  savedAt: number;
}

const DB_NAME = 'rune-model-check';
const STORE = 'tryon';
const CHANNEL = 'rune-model-check';

const ROLES: readonly AnimRole[] = ['idle', 'walk', 'run', 'attack', 'cast', 'shoot', 'hit', 'death', 'dormant', 'awaken', 'spawn'];

export function isTryOnKey(v: unknown): v is TryOnKey {
  if (typeof v !== 'string') return false;
  const [kind, id] = v.split(':');
  return (kind === 'monsters' && isEnemyTypeId(id)) || (kind === 'minions' && isMinionTypeId(id));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Rows come back from storage as plain data; anything that does not look right is skipped. */
function toEntry(v: unknown): TryOnEntry | null {
  if (!isRecord(v) || !isTryOnKey(v.key) || typeof v.fileName !== 'string' || !(v.bytes instanceof ArrayBuffer)) return null;
  if (typeof v.height !== 'number' || !Number.isFinite(v.height) || typeof v.savedAt !== 'number' || !isRecord(v.clips)) return null;
  const clips: Partial<Record<AnimRole, string>> = {};
  for (const role of ROLES) {
    const name = v.clips[role];
    if (typeof name === 'string') clips[role] = name;
  }
  return { key: v.key, fileName: v.fileName, bytes: v.bytes, height: v.height, clips, savedAt: v.savedAt };
}

function open(): Promise<IDBDatabase> {
  return new Promise((ok, fail) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'key' });
    req.onsuccess = () => ok(req.result);
    req.onerror = () => fail(req.error ?? new Error('IndexedDB unavailable'));
  });
}

async function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((ok, fail) => {
      const req = work(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => ok(req.result);
      req.onerror = () => fail(req.error ?? new Error('IndexedDB request failed'));
    });
  } finally {
    db.close();
  }
}

function announce(): void {
  const ch = new BroadcastChannel(CHANNEL);
  ch.postMessage('changed');
  ch.close();
}

export async function saveTryOn(entry: TryOnEntry): Promise<void> {
  await run('readwrite', (s) => s.put(entry));
  announce();
}

export async function removeTryOn(key: TryOnKey): Promise<void> {
  await run('readwrite', (s) => s.delete(key));
  announce();
}

export async function listTryOns(): Promise<TryOnEntry[]> {
  const rows = await run('readonly', (s) => s.getAll());
  return rows.map(toEntry).filter((e): e is TryOnEntry => e !== null);
}

/** Calls back whenever the admin page saves or removes a try-on. Returns the unsubscribe. */
export function watchTryOns(onChange: () => void): () => void {
  const ch = new BroadcastChannel(CHANNEL);
  ch.onmessage = () => onChange();
  return () => ch.close();
}

/** The registry entry a try-on is drawn with: a monster model, so it gets the game's +z to +x turn. */
export function tryOnAsset(entry: TryOnEntry): AssetDef {
  // A new id per save: the fit and material caches are keyed by id and must not reuse the old file's.
  const id = `tryon_${entry.key.replace(':', '_')}_${entry.savedAt}`;
  return { id, label: entry.fileName, category: 'monster', url: `tryon:${id}`, height: entry.height, clips: entry.clips };
}

/** Loads every stored try-on into the game's model lookup. Returns what is being tried on, for a notice. */
export async function applyTryOns(): Promise<string[]> {
  const entries = await listTryOns();
  clearTryOns();
  const loader = new GLTFLoader();
  const applied: string[] = [];
  for (const entry of entries) {
    try {
      const gltf = await loader.parseAsync(entry.bytes.slice(0), '');
      const def = tryOnAsset(entry);
      registerFile(def.url, gltf.scene, gltf.animations);
      setTryOn(entry.key, def);
      applied.push(`${entry.fileName} on ${entry.key.split(':')[1] ?? ''}`);
    } catch {
      // A file that no longer parses is skipped; the Model check shows why when it is opened again.
    }
  }
  return applied;
}
