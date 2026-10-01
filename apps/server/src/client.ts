import { jsonCodec, type Role, type ServerMessage } from '@rune/shared';
import type { WebSocket } from 'ws';
import type { Room } from './room.js';

/** The parts of a ws socket a client uses, so tests can pass a stand-in. */
export type ClientSocket = Pick<WebSocket, 'readyState' | 'OPEN' | 'send' | 'close'> & { readonly bufferedAmount?: number };

/**
 * Past this much unsent data the connection cannot keep up. Snapshots are full state, so skipping
 * some loses nothing lasting, while queueing them without limit grows the server's memory and the
 * client's delay together.
 */
const CONGESTED_BYTES = 256 * 1024;

/** What the room manager listens to on a connection; a ws socket fits, and so does a test double. */
export interface GameSocket extends ClientSocket {
  on(event: 'message', listener: (data: unknown, isBinary: boolean) => void): unknown;
  on(event: 'close' | 'error', listener: () => void): unknown;
}

/** Generous for 20 Hz input, pings and editor clicks; anything above is a misbehaving client. */
export const MAX_MESSAGES_PER_SECOND = 80;

/** A connection. It outlives rooms: the same client moves between town, arena and instances. */
export class Client {
  room: Room | null = null;
  /** The party instance this client plays in (kept while visiting the Arena). */
  instanceId: string | null = null;
  /** Set once the client joins with a valid session; everything before that is ignored. */
  accountId: number | null = null;
  /** For the admin overview. */
  accountName = '';
  /** Staff role, set on join and updated live when an owner changes it. */
  role: Role = 'player';
  characterId: number | null = null;
  lastTownSave = 0;
  messageCount = 0;
  /** Recent chat send times, for the chat rate limit (separate from the general message limit). */
  chatTimes: number[] = [];
  messageWindowStart = performance.now();

  constructor(
    readonly id: string,
    readonly socket: ClientSocket,
  ) {}

  get congested(): boolean {
    return (this.socket.bufferedAmount ?? 0) > CONGESTED_BYTES;
  }

  send(msg: ServerMessage): void {
    if (this.socket.readyState !== this.socket.OPEN) return;
    this.socket.send(jsonCodec.encode(msg));
  }
}
