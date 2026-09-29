import { isServerMessage, type ServerMessage } from '@rune/shared';
import type { GameSocket } from '../src/client.js';

function hasTag<T extends ServerMessage['t']>(m: ServerMessage, t: T): m is Extract<ServerMessage, { t: T }> {
  return m.t === t;
}

/** A connection the test drives by hand, recording everything the server sends it. */
export class FakeSocket implements GameSocket {
  readyState: 0 | 1 | 2 | 3 = 1;
  readonly OPEN = 1;
  readonly sent: ServerMessage[] = [];
  private listeners = new Map<string, (data: unknown, isBinary: boolean) => void>();

  on(event: 'message', listener: (data: unknown, isBinary: boolean) => void): this;
  on(event: 'close' | 'error', listener: () => void): this;
  on(event: string, listener: (data: unknown, isBinary: boolean) => void): this {
    this.listeners.set(event, listener);
    return this;
  }
  send(data: unknown): void {
    const msg: unknown = JSON.parse(String(data));
    if (isServerMessage(msg)) this.sent.push(msg);
  }
  close(): void {
    this.readyState = 3;
    this.listeners.get('close')?.(undefined, false);
  }
  emit(msg: object): void {
    this.listeners.get('message')?.(Buffer.from(JSON.stringify(msg)), false);
  }
  last<T extends ServerMessage['t']>(t: T): Extract<ServerMessage, { t: T }> | undefined {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      const m = this.sent[i];
      if (m && hasTag(m, t)) return m;
    }
    return undefined;
  }
  worldName(): string | undefined {
    const w = this.sent.filter((m) => m.t === 'world').at(-1);
    return w?.t === 'world' ? w.world.name : undefined;
  }
  party(): Extract<ServerMessage, { t: 'party' }>['party'] | undefined {
    const p = this.sent.filter((m) => m.t === 'party').at(-1);
    return p?.t === 'party' ? p.party : undefined;
  }
}
