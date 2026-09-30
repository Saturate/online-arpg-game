import type { ServerEvent, ServerEventKind, ServerLogResponse } from '@rune/shared';

/**
 * Recent server events kept in memory for `GET /api/admin/log`, so the owner (or a script with a
 * token) can see conversions, unreadable saves, errors and staff actions without the pod log. Every
 * entry also goes to stdout as before. Nothing is stored: a restart starts the buffer empty.
 */

/** A few hours of a busy server; each entry is one short line. */
const CAPACITY = 4000;
/** At most this many entries per response, so one poll after a long gap stays small. */
const PAGE = 1000;

/**
 * Secrets never reach a line on purpose; this is the net under that, for a token pasted into an
 * announcement or an error message that quotes a header. Admin tokens, then anything shaped like a
 * session token (43 base64url characters standing alone).
 */
const SECRETS = [/arpg_[0-9a-f]{16}_[A-Za-z0-9_-]{43}/g, /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g];

export function redact(text: string): string {
  let out = text;
  for (const pattern of SECRETS) out = out.replace(pattern, '[redacted]');
  return out;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class EventLog {
  private readonly entries: ServerEvent[] = [];
  private nextId = 1;
  readonly startedAt = Date.now();

  constructor(private readonly capacity = CAPACITY) {}

  private push(kind: ServerEventKind, text: string): string {
    const clean = redact(text);
    this.entries.push({ id: this.nextId++, at: Date.now(), kind, text: clean });
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity);
    return clean;
  }

  log(kind: ServerEventKind, text: string): void {
    console.log(this.push(kind, text));
  }

  warn(kind: ServerEventKind, text: string): void {
    console.warn(this.push(kind, text));
  }

  /** The buffer gets the message only; stdout also gets the stack. */
  error(kind: ServerEventKind, text: string, err?: unknown): void {
    const clean = this.push(kind, err === undefined ? text : `${text}: ${message(err)}`);
    if (err === undefined) console.error(clean);
    else console.error(redact(text), err);
  }

  since(cursor: number): ServerLogResponse {
    const first = this.entries[0]?.id ?? this.nextId;
    const entries = this.entries.filter((e) => e.id > cursor).slice(0, PAGE);
    const last = entries[entries.length - 1];
    return { startedAt: this.startedAt, next: last ? last.id : Math.min(cursor, this.nextId - 1), missed: cursor + 1 < first, entries };
  }
}

/** One per process, like stdout. */
export const events = new EventLog();
