import {
  compileSigilItem,
  type AffixId,
  type CharacterSummary,
  type ClassId,
  type GameMode,
  type InstanceInfo,
  type MapTheme,
  type ClientMessage,
  type CompileResult,
  type EntityId,
  type InventoryMessage,
  type Item,
  type ItemUid,
  type RuneId,
  type SigilItem,
  type Snapshot,
  type Stance,
  type StagingMessage,
  type PlayerStats,
} from '@rune/shared';
import { create } from 'zustand';

export interface DebugStats {
  tick: number;
  rttMs: number | null;
  roomEntities: number;
  visibleEntities: number;
  fps: number;
  pendingInputs: number;
  correctionPx: number;
  addedRttMs: number;
  drawCalls: number;
  heat: number;
  lastFizzle: string | null;
}

export interface TargetInfo {
  id: EntityId;
  name: string;
  level: number;
  life: number;
  maxLife: number;
  rare: boolean;
  boss: boolean;
  affixes: AffixId[];
}

export interface Notice {
  id: number;
  text: string;
}

interface UiState {
  phase: 'login' | 'characters' | 'playing';
  /** Session token from the HTTP login, kept in localStorage so a reload stays logged in. */
  token: string | null;
  username: string;
  character: CharacterSummary | null;
  classId: ClassId | null;
  name: string;
  mode: GameMode;
  roomName: string;
  roomTheme: MapTheme;
  /** Seed of the current Wilds instance, or null outside the wilds. */
  roomSeed: number | null;
  canPause: boolean;
  paused: boolean;
  editorAllowed: boolean;
  menuOpen: boolean;
  settingsOpen: boolean;
  minimapVisible: boolean;
  instances: InstanceInfo[];
  /** Antechamber ready check, while standing in one. */
  staging: StagingMessage | null;
  banner: { id: number; title: string; text: string } | null;
  /** Monster under the cursor, for the target frame. */
  target: TargetInfo | null;
  /** Landing spots beside each portal in the current room, for the sandbox's quick travel list. */
  roomPortals: { label: string; x: number; y: number }[];
  connectionError: string | null;
  playerId: EntityId | null;

  life: number;
  maxLife: number;
  respawnIn: number | null;
  heat: number;
  spiritMax: number;
  spiritReserved: number;
  castCooldown: number;
  stance: Stance;
  minionRespawn: number[];
  wave: number;
  party: Snapshot['players'];

  inventory: InventoryMessage | null;
  inventoryOpen: boolean;
  characterOpen: boolean;
  devOpen: boolean;
  devTools: boolean;
  stats: PlayerStats | null;
  heatMax: number;
  editorOpen: boolean;
  editorUid: ItemUid | null;

  debugVisible: boolean;
  debug: DebugStats;
  notices: Notice[];

  send: ((msg: ClientMessage) => void) | null;
  /** Set by a live game; starts a replay recording, or stops it and downloads the file. */
  toggleRecording: (() => void) | null;
  /** Bumped to make the game view build a fresh connection after a drop. */
  reconnectKey: number;
  reconnectAttempt: number;
  connectionLost: (reason: string) => void;
  connected: () => void;
  recording: boolean;

  setSession: (token: string, username: string) => void;
  logout: () => void;
  play: (character: CharacterSummary, mode: GameMode) => void;
  toggleMenu: () => void;
  leave: (error: string | null) => void;
  toggleDebug: () => void;
  toggleInventory: () => void;
  toggleEditor: () => void;
  openEditor: (uid: ItemUid) => void;
  notify: (text: string) => void;
}

let noticeId = 1;

const TOKEN_KEY = 'rune.session';
const RECONNECT_ATTEMPTS = 8;

function storedToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function storeToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Blocked storage: the session just does not survive a reload.
  }
}

const initialToken = storedToken();

export const useUi = create<UiState>((set, get) => ({
  phase: initialToken ? 'characters' : 'login',
  token: initialToken,
  username: '',
  character: null,
  classId: null,
  name: '',
  mode: 'world',
  roomName: '',
  roomTheme: 'town',
  roomSeed: null,
  canPause: false,
  paused: false,
  editorAllowed: false,
  menuOpen: false,
  settingsOpen: false,
  minimapVisible: true,
  instances: [],
  staging: null,
  banner: null,
  target: null,
  roomPortals: [],
  connectionError: null,
  playerId: null,
  life: 0,
  maxLife: 0,
  respawnIn: null,
  heat: 0,
  spiritMax: 0,
  spiritReserved: 0,
  castCooldown: 0,
  stance: 'aggressive',
  minionRespawn: [],
  wave: 0,
  party: [],
  inventory: null,
  inventoryOpen: false,
  characterOpen: false,
  devOpen: false,
  devTools: false,
  stats: null,
  heatMax: 1000,
  editorOpen: false,
  editorUid: null,
  debugVisible: false,
  debug: {
    tick: 0,
    rttMs: null,
    roomEntities: 0,
    visibleEntities: 0,
    fps: 0,
    pendingInputs: 0,
    correctionPx: 0,
    addedRttMs: 0,
    drawCalls: 0,
    heat: 0,
    lastFizzle: null,
  },
  notices: [],
  send: null,
  toggleRecording: null,
  reconnectKey: 0,
  reconnectAttempt: 0,
  connectionLost: (reason) => {
    const attempt = get().reconnectAttempt + 1;
    // About half a minute in all: long enough for a dev server restart or a short network blip.
    if (attempt > RECONNECT_ATTEMPTS) {
      set({ reconnectAttempt: 0 });
      get().leave(reason);
      return;
    }
    set({ reconnectAttempt: attempt, send: null });
    setTimeout(() => {
      if (get().phase === 'playing') set((s) => ({ reconnectKey: s.reconnectKey + 1 }));
    }, Math.min(5000, 500 * 2 ** (attempt - 1)));
  },
  connected: () => set({ reconnectAttempt: 0 }),
  recording: false,

  setSession: (token, username) => {
    storeToken(token);
    set({ token, username, phase: 'characters', connectionError: null });
  },
  logout: () => {
    storeToken(null);
    set({ token: null, username: '', character: null, phase: 'login' });
  },
  play: (character, mode) => set({ phase: 'playing', character, classId: character.classId, name: character.name, mode, connectionError: null }),
  toggleMenu: () => {
    const s = get();
    const open = !s.menuOpen;
    set({ menuOpen: open });
    // Opening the menu pauses when the server allows it (alone, outside town); closing resumes.
    s.send?.({ t: 'pause', paused: open && s.canPause });
    if (open) s.send?.({ t: 'listInstances' });
  },
  leave: (error) => set({ phase: get().token ? 'characters' : 'login', character: null, classId: null, connectionError: error, inventory: null, playerId: null, send: null, menuOpen: false, paused: false, reconnectAttempt: 0 }),
  toggleDebug: () => set((s) => ({ debugVisible: !s.debugVisible })),
  // Like D2, the bag opens with the character sheet beside it, so gear can be dragged straight on.
  toggleInventory: () => set((s) => ({ inventoryOpen: !s.inventoryOpen, characterOpen: !s.inventoryOpen })),
  toggleEditor: () => {
    const s = get();
    if (s.editorOpen) {
      set({ editorOpen: false });
      return;
    }
    const first = s.inventory?.sigils.find((u) => u !== null) ?? null;
    set({ editorOpen: true, editorUid: s.editorUid ?? first });
  },
  openEditor: (uid) => set({ editorOpen: true, editorUid: uid }),
  notify: (text) => {
    const id = noticeId++;
    set((s) => ({ notices: [...s.notices, { id, text }].slice(-4) }));
    setTimeout(() => set((s) => ({ notices: s.notices.filter((n) => n.id !== id) })), 3500);
  },
}));

export function sendCommand(msg: ClientMessage): void {
  useUi.getState().send?.(msg);
}

export function itemByUid(inv: InventoryMessage | null, uid: ItemUid | null): Item | undefined {
  if (!inv || uid === null) return undefined;
  return inv.items.find((i) => i.uid === uid);
}

/** The client runs the same compiler as the server, so the editor can preview cost and stability instantly. */
export function compileFor(item: SigilItem, classId: ClassId, draft?: readonly RuneId[]): CompileResult {
  return compileSigilItem(item, classId, draft);
}

// Game state lives in module scope. A hot update would split it between an old and a new copy
// (the symptom: panels that stop opening), so edits to this module reload the page instead.
import.meta.hot?.accept(() => location.reload());
