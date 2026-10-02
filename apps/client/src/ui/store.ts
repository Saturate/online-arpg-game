import {
  compileSigilItem,
  type AffixId,
  type ArenaResult,
  type ArenaStatus,
  type CharacterSummary,
  type ClassId,
  type PartyInfo,
  type PartyMemberStatus,
  type TraderEntry,
  type WorldInfo,
  type MapTheme,
  type ClientMessage,
  type SigilCompile,
  type EntityId,
  type InscribeReply,
  type InventoryMessage,
  type Item,
  type ItemUid,
  type SigilItem,
  type Snapshot,
  type Stance,
  type StagingMessage,
  type PlayerStats,
} from '@rune/shared';
import { initialRestart, nextRestart, RESTART_RETRY_MS, takeUpdating, waitingForServer, type RestartEvent, type RestartState } from '../game/restart.js';
import { create } from 'zustand';
import { closeStation, openStation, openWaypointMenu, type ItemStation, type WaypointMenu } from './stations.js';

export interface DebugStats {
  tick: number;
  rttMs: number | null;
  roomEntities: number;
  visibleEntities: number;
  fps: number;
  pendingInputs: number;
  heldKeys: string;
  correctionPx: number;
  addedRttMs: number;
  drawCalls: number;
  heat: number;
  lastFizzle: string | null;
}

export interface ChatLine {
  id: number;
  kind: 'game' | 'party' | 'whisper' | 'system';
  from: string;
  to: string | null;
  text: string;
  /** Display-only copies of linked items; `{n}` in the text shows `items[n - 1]`. */
  items: Item[];
  at: number;
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
  /** 'elsewhere': another tab took the game over; this one waits to be told to play here. */
  phase: 'login' | 'characters' | 'playing' | 'elsewhere';
  /** Session token from the HTTP login, kept in localStorage so a reload stays logged in. */
  token: string | null;
  username: string;
  character: CharacterSummary | null;
  classId: ClassId | null;
  name: string;
  roomName: string;
  /** Where a death sends you back to: the town in the world. */
  spawnName: string;
  roomTheme: MapTheme;
  /** Seed of the current Wilds instance, or null outside the wilds. */
  roomSeed: number | null;
  canPause: boolean;
  paused: boolean;
  editorAllowed: boolean;
  menuOpen: boolean;
  settingsOpen: boolean;
  minimapVisible: boolean;
  /** Which copy of the world this character is in. */
  world: WorldInfo | null;
  partyInfo: PartyInfo | null;
  /** The other party members, wherever they are, refreshed by the server about once a second. */
  partyStatus: PartyMemberStatus[];
  /** The teleport to a party member being channelled; `endsAt` is on the performance clock. */
  teleport: { to: string; endsAt: number; seconds: number } | null;
  /** Name of whoever invited us, while the invite is unanswered. */
  partyInvite: string | null;
  /** Antechamber ready check, while standing in one. */
  staging: StagingMessage | null;
  /** Live wave and score, while in an Arena run. */
  arena: ArenaStatus | null;
  /** The score screen of the run that just ended, until closed. */
  arenaResult: ArenaResult | null;
  /** The Arena leaderboard window. */
  boardOpen: boolean;
  /** Open waypoint menu: the waypoint underfoot and every one this character has found. */
  waypointMenu: WaypointMenu | null;
  banner: { id: number; title: string; text: string } | null;
  chat: ChatLine[];
  chatOpen: boolean;
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
  /** Full length of the cooldown the last cast set, so the skill bar sweep has a denominator. */
  castCooldownFull: number;
  stance: Stance;
  minionRespawn: number[];
  /** Gates this character has opened; the waypoint menu marks the waypoints behind the others. */
  gates: string[];
  wave: number;
  party: Snapshot['players'];

  inventory: InventoryMessage | null;
  inventoryOpen: boolean;
  /** Skill slots the left and right mouse buttons cast, D2 style; saved per character. */
  leftSkill: number;
  rightSkill: number;
  /**
   * The one open station window (see stations.ts). At the stash right-click moves items across, at
   * the trader it sells, at the forge the sigil editor spends runes from the bag.
   */
  station: ItemStation | null;
  traderStock: TraderEntry[];
  characterOpen: boolean;
  devOpen: boolean;
  devTools: boolean;
  /** God mode as last sent from the dev tools. The server resets it with every new room. */
  godMode: boolean;
  stats: PlayerStats | null;
  heatMax: number;
  level: number;
  xp: number;
  xpNext: number;
  editorOpen: boolean;
  editorUid: ItemUid | null;
  /**
   * The inscribe in flight, until the server's reply to this attempt comes back. The server sends
   * the new inventory before an accepted reply, so by then the forge already shows the new slots.
   */
  inscribing: { attempt: number } | null;
  /** The server's reason for refusing the last inscribe, shown in the forge until the next try. */
  forgeError: string | null;

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
  /** The restart countdown and the "Updating game server" overlay (game/restart.ts). */
  restart: RestartState;
  restartEvent: (ev: RestartEvent) => void;
  connected: () => void;
  recording: boolean;

  setSession: (token: string, username: string) => void;
  logout: () => void;
  play: (character: CharacterSummary) => void;
  toggleMenu: () => void;
  leave: (error: string | null) => void;
  toggleDebug: () => void;
  toggleInventory: () => void;
  openStation: (kind: ItemStation) => void;
  openWaypointMenu: (menu: WaypointMenu) => void;
  /** Closes the station window (and the waypoint menu) without touching the bag. */
  closeStation: () => void;
  toggleEditor: () => void;
  openEditor: (uid: ItemUid) => void;
  notify: (text: string) => void;
  inscribed: (reply: InscribeReply) => void;
  /** Marks a new inscribe attempt in flight and returns its id for the message. */
  startInscribe: () => number;
}

let noticeId = 1;
let inscribeAttempt = 0;

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

/** The next reconnect try; a failed connect reports both its error and its close, and only one try may follow. */
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

export const useUi = create<UiState>((set, get) => ({
  phase: initialToken ? 'characters' : 'login',
  token: initialToken,
  username: '',
  character: null,
  classId: null,
  name: '',
  roomName: '',
  spawnName: '',
  roomTheme: 'town',
  roomSeed: null,
  canPause: false,
  paused: false,
  editorAllowed: false,
  menuOpen: false,
  settingsOpen: false,
  minimapVisible: true,
  world: null,
  partyInfo: null,
  partyStatus: [],
  teleport: null,
  partyInvite: null,
  staging: null,
  arena: null,
  arenaResult: null,
  boardOpen: false,
  waypointMenu: null,
  banner: null,
  chat: [],
  chatOpen: false,
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
  castCooldownFull: 0,
  stance: 'aggressive',
  minionRespawn: [],
  gates: [],
  wave: 0,
  party: [],
  inventory: null,
  inventoryOpen: false,
  leftSkill: 0,
  rightSkill: 1,
  station: null,
  traderStock: [],
  characterOpen: false,
  devOpen: false,
  devTools: false,
  godMode: false,
  stats: null,
  heatMax: 1000,
  level: 1,
  xp: 0,
  xpNext: 1,
  editorOpen: false,
  editorUid: null,
  inscribing: null,
  forgeError: null,
  debugVisible: false,
  debug: {
    tick: 0,
    rttMs: null,
    roomEntities: 0,
    visibleEntities: 0,
    fps: 0,
    pendingInputs: 0,
    heldKeys: '',
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
    if (reconnectTimer !== null) return;
    const now = performance.now();
    const restart = get().restart;
    const attempt = get().reconnectAttempt + 1;
    if (restart.overlay === 'waiting' && !waitingForServer(restart, now)) {
      set({ reconnectAttempt: 0 });
      get().leave('The server is taking longer than usual to come back. Try again in a minute.');
      return;
    }
    const waiting = waitingForServer(restart, now);
    // About half a minute in all: long enough for a dev server restart or a short network blip. A
    // restart for an update is waited out longer (RESTART_WAIT_MS).
    if (!waiting && attempt > RECONNECT_ATTEMPTS) {
      set({ reconnectAttempt: 0 });
      get().leave(reason);
      return;
    }
    set({ reconnectAttempt: attempt, send: null });
    reconnectTimer = setTimeout(
      () => {
        reconnectTimer = null;
        if (get().phase === 'playing') set((s) => ({ reconnectKey: s.reconnectKey + 1 }));
      },
      waiting ? RESTART_RETRY_MS : Math.min(5000, 500 * 2 ** (attempt - 1)),
    );
  },
  restart: initialRestart(takeUpdating(), performance.now()),
  restartEvent: (ev) => set((s) => ({ restart: nextRestart(s.restart, ev) })),
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
  play: (character) => set({ phase: 'playing', character, classId: character.classId, name: character.name, connectionError: null }),
  toggleMenu: () => {
    const s = get();
    const open = !s.menuOpen;
    set({ menuOpen: open });
    // Opening the menu pauses when the server allows it (alone, outside town); closing resumes.
    s.send?.({ t: 'pause', paused: open && s.canPause });
  },
  leave: (error) => set({ phase: get().token ? 'characters' : 'login', character: null, classId: null, connectionError: error, inventory: null, playerId: null, send: null, world: null, partyInfo: null, partyStatus: [], teleport: null, partyInvite: null, arena: null, arenaResult: null, boardOpen: false, station: null, waypointMenu: null, menuOpen: false, paused: false, reconnectAttempt: 0, restart: nextRestart(get().restart, { e: 'done', now: performance.now() }) }),
  toggleDebug: () => set((s) => ({ debugVisible: !s.debugVisible })),
  // Like D2, the bag opens with the character sheet beside it, so gear can be dragged straight on.
  // Closing the bag closes the station too, so the next I opens only the bag.
  toggleInventory: () => set((s) => (s.inventoryOpen ? { ...closeStation(s), inventoryOpen: false, characterOpen: false } : { inventoryOpen: true, characterOpen: true })),
  openStation: (kind) => set((s) => openStation(s, kind)),
  openWaypointMenu: (menu) => set((s) => openWaypointMenu(s, menu)),
  closeStation: () => set((s) => closeStation(s)),
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
  startInscribe: () => {
    const attempt = inscribeAttempt++;
    set({ inscribing: { attempt }, forgeError: null });
    return attempt;
  },
  inscribed: (reply) => {
    const s = get();
    // Only the latest attempt counts: a late answer to one that timed out must not free the button
    // for the retry still in flight, nor show a refusal that no longer applies.
    if (s.inscribing?.attempt !== reply.attempt) {
      // A refusal that outlived its timeout still tells the player why nothing changed.
      if (!reply.ok && s.inscribing === null) s.notify(reply.error);
      return;
    }
    set({ inscribing: null });
    if (reply.ok) {
      if (s.editorUid === reply.uid) set({ forgeError: null });
      return;
    }
    if (s.editorOpen && s.editorUid === reply.uid) set({ forgeError: reply.error });
    else s.notify(reply.error);
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
const PICKS_KEY = 'rune.skillPicks';

/** Mouse skill picks per character id, in localStorage like other per-browser preferences. */
function readPicks(): Record<string, { left: number; right: number }> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(PICKS_KEY) ?? '{}');
    if (typeof v !== 'object' || v === null) return {};
    const out: Record<string, { left: number; right: number }> = {};
    for (const [k, pick] of Object.entries(v)) {
      if (typeof pick !== 'object' || pick === null) continue;
      const left: unknown = Reflect.get(pick, 'left');
      const right: unknown = Reflect.get(pick, 'right');
      if (isSlot(left) && isSlot(right)) out[k] = { left, right };
    }
    return out;
  } catch {
    return {};
  }
}

function isSlot(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 3;
}

/** Swaps two skill slots; the mouse picks follow their skills rather than staying on the slot. */
export function swapSkills(a: number, b: number): void {
  if (a === b) return;
  sendCommand({ t: 'swapSigils', a, b });
  const { leftSkill, rightSkill } = useUi.getState();
  const moved = (slot: number) => (slot === a ? b : slot === b ? a : slot);
  pickSkill('left', moved(leftSkill));
  pickSkill('right', moved(rightSkill));
}

/** Sets which slot a mouse button casts, and remembers it for this character. */
export function pickSkill(side: 'left' | 'right', slot: number): void {
  useUi.setState(side === 'left' ? { leftSkill: slot } : { rightSkill: slot });
  const { character, leftSkill, rightSkill } = useUi.getState();
  if (!character) return;
  try {
    localStorage.setItem(PICKS_KEY, JSON.stringify({ ...readPicks(), [character.id]: { left: leftSkill, right: rightSkill } }));
  } catch {
    // Blocked storage: the picks last for this session only.
  }
}

/**
 * On the first inventory of a session: the saved picks, or else the first two skills that are cast
 * rather than kept up (an aura on the left mouse button would do nothing useful when clicked).
 */
export function initSkillPicks(inv: InventoryMessage): void {
  const { character, classId } = useUi.getState();
  if (!character || !classId) return;
  const saved = readPicks()[character.id];
  if (saved) {
    useUi.setState({ leftSkill: saved.left, rightSkill: saved.right });
    return;
  }
  const castable = inv.sigils.flatMap((uid, slot) => {
    const item = inv.items.find((i) => i.uid === uid);
    if (item?.kind !== 'sigil') return [];
    const r = compileFor(item, classId);
    return r.ok && !r.persistent ? [slot] : [];
  });
  useUi.setState({ leftSkill: castable[0] ?? 0, rightSkill: castable[1] ?? castable[0] ?? 1 });
}

export function compileFor(item: SigilItem, classId: ClassId): SigilCompile {
  return compileSigilItem(item, classId);
}

// Game state lives in module scope. A hot update would split it between an old and a new copy
// (the symptom: panels that stop opening), so edits to this module reload the page instead.
import.meta.hot?.accept(() => location.reload());
