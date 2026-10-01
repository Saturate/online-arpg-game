import { can, type Permission, type Role } from '@rune/shared';

/** The admin page's tabs, in the order the header shows them. */
export const TABS = ['live', 'players', 'arena', 'settings', 'tuning', 'monsters', 'minions', 'modelCheck', 'log', 'grant', 'tokens'] as const;
export type Tab = (typeof TABS)[number];

export const TAB_NAMES: Record<Tab, string> = {
  live: 'Live',
  players: 'Players',
  arena: 'Arena',
  settings: 'Settings',
  tuning: 'Tuning',
  monsters: 'Monsters',
  minions: 'Minions',
  modelCheck: 'Model check',
  log: 'Server log',
  grant: 'Grant item',
  tokens: 'API tokens',
};

/**
 * Tabs only some roles see, by the permission the server checks on their routes. The rest need
 * `viewAdmin` only, which every role that reaches this page has.
 */
const TAB_PERMISSION: Partial<Record<Tab, Permission>> = { log: 'serverLog', grant: 'grantItems', tokens: 'apiTokens' };

export function tabVisible(role: Role, tab: Tab): boolean {
  if (!can(role, 'viewAdmin')) return false;
  const p = TAB_PERMISSION[tab];
  return p === undefined || can(role, p);
}

export function visibleTabs(role: Role): Tab[] {
  return TABS.filter((t) => tabVisible(role, t));
}

/** Where a search result lands: the tab, and the `data-search-id` of the element to focus there. */
export interface Jump {
  tab: Tab;
  target: string;
  /** Bumped on every jump, so jumping to the same place twice still scrolls and flashes it. */
  seq: number;
}

export function searchId(tab: Tab, target: string): string {
  return `${tab}:${target}`;
}
