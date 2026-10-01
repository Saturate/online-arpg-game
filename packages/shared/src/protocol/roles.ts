/**
 * Staff roles. Each role is a fixed set of permissions, ranked so staff can only act on accounts
 * below them (a moderator cannot ban an admin). The owner comes from ADMIN_USERS on the server,
 * never from the database, so nobody can grant it through the admin page.
 */

/**
 * `grantItems` makes real, tradeable items out of nothing, so like `manageRoles` only the owner has
 * it: an admin account taken over could otherwise mint items for anyone. `backup` is owner only for
 * the same reason: the copy holds every account's password hash. `apiTokens` makes admin API tokens
 * and `serverLog` reads the server's recent events. `tuning` changes live balance numbers (spell
 * shapes, rune prices; docs/features/live-tuning.md), so like `settings` it is the owner's and admins'.
 */
export const PERMISSIONS = ['viewAdmin', 'announce', 'kick', 'ban', 'teleport', 'settings', 'townEdit', 'devTools', 'manageRoles', 'grantItems', 'apiTokens', 'serverLog', 'backup', 'tuning'] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Lowest to highest; the index is the rank. */
export const ROLES = ['player', 'builder', 'moderator', 'admin', 'owner'] as const;
export type Role = (typeof ROLES)[number];
/** What the owner can hand out from the admin page. */
export type AssignableRole = Exclude<Role, 'owner'>;
export const ASSIGNABLE_ROLES: readonly AssignableRole[] = ['player', 'builder', 'moderator', 'admin'];

const GRANTS: Record<Role, readonly Permission[]> = {
  player: [],
  builder: ['viewAdmin', 'townEdit', 'devTools'],
  moderator: ['viewAdmin', 'announce', 'kick', 'ban', 'teleport'],
  admin: ['viewAdmin', 'announce', 'kick', 'ban', 'teleport', 'settings', 'townEdit', 'devTools', 'apiTokens', 'serverLog', 'tuning'],
  owner: PERMISSIONS,
};

export const ROLE_INFO: Record<Role, { name: string; blurb: string }> = {
  player: { name: 'Player', blurb: 'No staff powers' },
  builder: { name: 'Builder', blurb: 'Town editor and F3 dev tools; can look at the admin page' },
  moderator: { name: 'Moderator', blurb: 'Announce, kick, ban and teleport to players' },
  admin: { name: 'Admin', blurb: 'Everything except handing out roles, granting items and backups' },
  owner: { name: 'Owner', blurb: 'Everything; set with ADMIN_USERS on the server' },
};

export function can(role: Role, permission: Permission): boolean {
  return GRANTS[role].includes(permission);
}

export function rank(role: Role): number {
  return ROLES.indexOf(role);
}

export function isRole(v: unknown): v is Role {
  return typeof v === 'string' && ROLES.some((r) => r === v);
}

export function isAssignableRole(v: unknown): v is AssignableRole {
  return typeof v === 'string' && ASSIGNABLE_ROLES.some((r) => r === v);
}
