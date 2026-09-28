import { isServerMessage, jsonCodec, type ClientMessage, type Codec, type ServerMessage } from '@rune/shared';

export interface ConnectionOptions {
  url: string;
  /** Artificial one-way delay applied to both directions, for testing prediction under latency. */
  oneWayLagMs: number;
  onMessage: (msg: ServerMessage) => void;
  onClose: () => void;
}

export class Connection {
  private readonly socket: WebSocket;
  private readonly codec: Codec<string> = jsonCodec;
  private readonly opts: ConnectionOptions;
  private readonly opened: Promise<void>;

  constructor(opts: ConnectionOptions) {
    this.opts = opts;
    this.socket = new WebSocket(opts.url);
    this.opened = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', () => resolve(), { once: true });
      this.socket.addEventListener('error', () => reject(new Error(`Could not connect to ${opts.url}`)), {
        once: true,
      });
    });
    // A Game torn down mid-connect (React StrictMode remount) never awaits this; don't report it as unhandled.
    this.opened.catch(() => undefined);
    this.socket.addEventListener('message', (ev) => this.delay(() => this.receive(ev.data)));
    this.socket.addEventListener('close', () => opts.onClose());
  }

  ready(): Promise<void> {
    return this.opened;
  }

  send(msg: ClientMessage): void {
    const encoded = this.codec.encode(msg);
    this.delay(() => {
      if (this.socket.readyState === WebSocket.OPEN) this.socket.send(encoded);
    });
  }

  close(): void {
    this.socket.close();
  }

  private receive(data: unknown): void {
    if (typeof data !== 'string') return;
    const decoded = this.codec.decode(data);
    if (isServerMessage(decoded)) this.opts.onMessage(decoded);
  }

  /** setTimeout with equal delays keeps FIFO order, so lag simulation never reorders messages. */
  private delay(fn: () => void): void {
    if (this.opts.oneWayLagMs <= 0) fn();
    else setTimeout(fn, this.opts.oneWayLagMs);
  }
}
