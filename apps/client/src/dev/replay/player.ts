import type { ServerMessage } from '@rune/shared';
import type { ReplaySource } from '../../game/game.js';
import { seekIndex, withoutEvents, type ReplayFile } from '../../game/replay.js';

/**
 * Feeds a recording to a Game on a virtual clock. Seeking builds a fresh player at the target time:
 * it replays from the last room entry before it, all at once and without combat events.
 */
export class ReplayPlayer implements ReplaySource {
  private speed = 1;
  private playing = true;
  /** Virtual time at the last speed or pause change, and the real time it happened. */
  private base: number;
  private anchor = performance.now();
  private next = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly file: ReplayFile,
    startAt: number,
    speed: number,
    playing: boolean,
  ) {
    this.base = startAt;
    this.speed = speed;
    this.playing = playing;
  }

  now(): number {
    return this.playing ? Math.min(this.file.durationMs, this.base + (performance.now() - this.anchor) * this.speed) : this.base;
  }

  get ended(): boolean {
    return this.now() >= this.file.durationMs;
  }

  get isPlaying(): boolean {
    return this.playing && !this.ended;
  }

  start(onMessage: (msg: ServerMessage) => void): void {
    const frames = this.file.frames;
    const t = this.base;
    // Keep the last half second of events so the moment you land on still shows its hits.
    for (let i = seekIndex(frames, t); i < frames.length; i++) {
      const f = frames[i];
      if (!f || f.at > t) break;
      onMessage(f.at < t - 500 ? withoutEvents(f.msg) : f.msg);
      this.next = i + 1;
    }
    this.timer = setInterval(() => {
      const now = this.now();
      for (;;) {
        const f = frames[this.next];
        if (!f || f.at > now) break;
        onMessage(f.msg);
        this.next++;
      }
    }, 8);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  setSpeed(speed: number): void {
    this.base = this.now();
    this.anchor = performance.now();
    this.speed = speed;
  }

  setPlaying(playing: boolean): void {
    this.base = this.now();
    this.anchor = performance.now();
    this.playing = playing;
  }
}
