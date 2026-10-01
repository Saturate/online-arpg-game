import type { Permission } from './roles.js';

/**
 * Admin API tokens: a script or agent calls the same /api/admin routes as the admin page, with
 * `Authorization: Bearer <token>`. What a token may do is its scopes, and never more than its
 * creator's role allows at the time of the call.
 *
 * `townEdit` is a scope since `PUT /api/admin/town` saves the layout the editor saves. `devTools` is
 * left out because it gates the game socket only, which a token cannot open. `apiTokens` is left
 * out so a leaked token can never mint more tokens.
 */
export const TOKEN_SCOPES = ['viewAdmin', 'announce', 'kick', 'ban', 'teleport', 'settings', 'townEdit', 'manageRoles', 'grantItems', 'serverLog', 'backup'] as const satisfies readonly Permission[];
export type TokenScope = (typeof TOKEN_SCOPES)[number];

export const TOKEN_SCOPE_INFO: Record<TokenScope, string> = {
  viewAdmin: 'Read the overview, accounts, settings and tuning (every token has it)',
  announce: 'Send announcements',
  kick: 'Kick players',
  ban: 'Ban and unban accounts',
  teleport: "Move the creator's live character to a player",
  settings: 'Change server settings and monster and minion tuning',
  townEdit: 'Save the town layout, like the town editor (pnpm town:push)',
  manageRoles: 'Hand out roles',
  grantItems: 'Grant items to offline characters',
  serverLog: 'Read the recent server log',
  backup: 'Download a copy of the database',
};

export const TOKEN_RULES = {
  /** Shown in the staff log line of every call, so it is kept to characters that cannot fake a line. */
  namePattern: /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,31}$/,
  minDays: 1,
  maxDays: 90,
  maxPerAccount: 20,
  /** Calls per token per minute, on top of the per-address limit every request has. */
  perMinute: 60,
} as const;

/** `arpg_`, a 16-hex id used to look the token up, and 32 random bytes in base64url. */
export const ADMIN_TOKEN_PATTERN = /^arpg_([0-9a-f]{16})_([A-Za-z0-9_-]{43})$/;

export function isAdminToken(v: unknown): v is string {
  return typeof v === 'string' && ADMIN_TOKEN_PATTERN.test(v);
}

export function isTokenScope(v: unknown): v is TokenScope {
  return typeof v === 'string' && TOKEN_SCOPES.some((s) => s === v);
}

export interface NewAdminToken {
  name: string;
  scopes: TokenScope[];
  days: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** `viewAdmin` is always added: every admin route sits behind it. */
export function parseNewAdminToken(v: unknown): NewAdminToken | string {
  if (!isRecord(v)) return 'Expected a JSON object';
  const unknown = Object.keys(v).filter((k) => k !== 'name' && k !== 'scopes' && k !== 'days');
  if (unknown.length > 0) return `Unknown field ${unknown[0]}`;
  const { name, scopes, days } = v;
  if (typeof name !== 'string' || !TOKEN_RULES.namePattern.test(name)) return 'Names are 1 to 32 letters, digits, spaces, _ . or -, starting with a letter or digit';
  if (!Array.isArray(scopes) || scopes.length > TOKEN_SCOPES.length * 2) return 'scopes must be a list of permissions';
  const picked = new Set<TokenScope>(['viewAdmin']);
  for (const s of scopes) {
    if (!isTokenScope(s)) return `Unknown scope ${typeof s === 'string' ? s.slice(0, 40) : String(s)}`;
    picked.add(s);
  }
  if (typeof days !== 'number' || !Number.isInteger(days) || days < TOKEN_RULES.minDays || days > TOKEN_RULES.maxDays) return `days must be a whole number from ${TOKEN_RULES.minDays} to ${TOKEN_RULES.maxDays}`;
  return { name, scopes: TOKEN_SCOPES.filter((s) => picked.has(s)), days };
}

/** A token as the admin page lists it. The secret is never sent again after creation. */
export interface AdminTokenInfo {
  id: string;
  name: string;
  scopes: TokenScope[];
  createdBy: string;
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number | null;
}

export interface CreatedAdminToken {
  /** The only time the full token is sent. */
  token: string;
  info: AdminTokenInfo;
}

export type ServerEventKind = 'conversion' | 'save' | 'error' | 'staff' | 'players' | 'server';

export interface ServerEvent {
  id: number;
  at: number;
  kind: ServerEventKind;
  text: string;
}

export interface ServerLogResponse {
  /** When this server process started; a change means the ids started again from 1. */
  startedAt: number;
  /** Pass as `since` next time. */
  next: number;
  /** True when entries after `since` had already been pushed out of the buffer. */
  missed: boolean;
  entries: ServerEvent[];
}
