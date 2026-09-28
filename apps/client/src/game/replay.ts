import { isClassId, isServerMessage, type ClassId, type ServerMessage } from '@rune/shared';

/**
 * A replay is every server message a client received, stamped with milliseconds since recording
 * started. Snapshots are full state, so playing the messages back through the normal client
 * reproduces the session exactly, from the recorder's point of view.
 */
export interface ReplayFrame {
  at: number;
  msg: ServerMessage;
}

export interface ReplayFile {
  version: 1;
  recordedAt: number;
  classId: ClassId;
  name: string;
  durationMs: number;
  frames: ReplayFrame[];
}

/** Ten minutes of 20 Hz snapshots is roughly 10 MB gzipped; past that the tab starts to struggle. */
export const MAX_RECORDING_MS = 10 * 60 * 1000;

export class Recorder {
  private readonly frames: ReplayFrame[] = [];
  private readonly startedAt = performance.now();
  readonly recordedAt = Date.now();

  constructor(
    readonly classId: ClassId,
    readonly name: string,
    /** Room state the session already had, so a recording started mid-room plays back on its own. */
    seed: readonly ServerMessage[],
  ) {
    for (const msg of seed) this.frames.push({ at: 0, msg });
  }

  get elapsedMs(): number {
    return performance.now() - this.startedAt;
  }

  get full(): boolean {
    return this.elapsedMs >= MAX_RECORDING_MS;
  }

  record(msg: ServerMessage): void {
    // Pongs measure the recorder's own latency and mean nothing on playback.
    if (msg.t === 'pong') return;
    this.frames.push({ at: this.elapsedMs, msg });
  }

  finish(): ReplayFile {
    return { version: 1, recordedAt: this.recordedAt, classId: this.classId, name: this.name, durationMs: this.elapsedMs, frames: this.frames };
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isFrame(v: unknown): v is ReplayFrame {
  return isRecord(v) && typeof v.at === 'number' && Number.isFinite(v.at) && isServerMessage(v.msg);
}

/** Replay files come from disk and may be old or hand-edited, so everything is checked before use. */
export function parseReplay(v: unknown): ReplayFile | string {
  if (!isRecord(v)) return 'Not a replay file';
  if (v.version !== 1) return 'Unsupported replay version';
  const { recordedAt, classId, name, durationMs, frames } = v;
  if (typeof recordedAt !== 'number' || !isClassId(classId) || typeof name !== 'string' || typeof durationMs !== 'number') return 'Replay header is malformed';
  if (!Array.isArray(frames) || !frames.every(isFrame)) return 'Replay frames are malformed';
  if (!frames.some((f) => f.msg.t === 'welcome')) return 'Replay has no room to show';
  return { version: 1, recordedAt, classId, name, durationMs, frames };
}

export async function encodeReplay(file: ReplayFile): Promise<Blob> {
  const stream = new Blob([JSON.stringify(file)]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).blob();
}

export async function decodeReplay(blob: Blob): Promise<ReplayFile | string> {
  const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  const gzipped = head[0] === 0x1f && head[1] === 0x8b;
  try {
    const text = gzipped ? await new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).text() : await blob.text();
    const parsed: unknown = JSON.parse(text);
    return parseReplay(parsed);
  } catch {
    return 'Could not read the file';
  }
}

/**
 * Where playback starts for a seek to `t`: the last room entry at or before it. Everything from
 * there up to `t` is delivered at once so the client rebuilds that room's state.
 */
export function seekIndex(frames: readonly ReplayFrame[], t: number): number {
  let idx = 0;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (!f || f.at > t) break;
    if (f.msg.t === 'welcome') idx = i;
  }
  return idx;
}

/** Drops combat events from a snapshot, so fast-forwarding does not replay every hit at once. */
export function withoutEvents(msg: ServerMessage): ServerMessage {
  return msg.t === 'snapshot' ? { ...msg, events: [] } : msg;
}
