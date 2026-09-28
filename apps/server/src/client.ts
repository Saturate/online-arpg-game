import { jsonCodec, type ServerMessage } from '@rune/shared';
import type { WebSocket } from 'ws';
import type { Room } from './room.js';

/** Generous for 20 Hz input, pings and editor clicks; anything above is a misbehaving client. */
export const MAX_MESSAGES_PER_SECOND = 80;

/** A connection. It outlives rooms: the same client moves between town, arena and instances. */
export class Client {
  room: Room | null = null;
  /** The last Wilds instance this client was in, so the town portal takes them back to it. */
  lastWildsId: string | null = null;
  /** Set once the client joins with a valid session; everything before that is ignored. */
  accountId: number | null = null;
  characterId: number | null = null;
  messageCount = 0;
  messageWindowStart = performance.now();

  constructor(
    readonly id: string,
    readonly socket: WebSocket,
  ) {}

  send(msg: ServerMessage): void {
    if (this.socket.readyState !== this.socket.OPEN) return;
    this.socket.send(jsonCodec.encode(msg));
  }
}
