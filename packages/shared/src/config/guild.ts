/**
 * Guilds (docs/features/guilds.md). The founding price, the tab cap and the tab prices are live
 * tuning numbers (the Guilds category): `applyTunables` overwrites them in place, so code reads
 * `GUILD.foundPrice` where it is needed, never a copy taken at load.
 *
 * Founding (1000) is about four second stash tabs' worth at level 10, a goal for a group rather
 * than for one character's first hour. Guild tabs cost twice a personal tab (500, then 500 more
 * each: 4500 for the tenth, 22500 for all nine extra), since a whole guild shares them and they
 * are the guild's gold sink for the whole game.
 */
export const GUILD = {
  /** Gold the founding character pays. */
  foundPrice: 1000,
  /** Stash tabs a guild can own at most, the free first one included. */
  maxTabs: 10,
  /** Price of the first tab bought (the guild's second). */
  firstTabPrice: 500,
  /** Each further tab costs this much more than the one before. */
  tabPriceStep: 500,
};

/**
 * Fixed limits, not tunable. Members: the owner's brief. Tab ids: the most a tuned cap may reach,
 * so a message naming a tab can be checked before any guild is looked up.
 */
export const GUILD_LIMITS = {
  maxMembers: 50,
  tabIdMax: 20,
  tagMin: 2,
  tagMax: 5,
  nameMin: 3,
  nameMax: 24,
  motdMax: 200,
  /** Log rows kept per guild; older ones go, oldest first. Enough to trace weeks of stash use. */
  logKeep: 2000,
  /** Log rows per page in the guild window. */
  logPage: 100,
} as const;

/** Gold for the next guild tab when the guild owns `owned`; null at the cap. */
export function guildTabPrice(owned: number): number | null {
  if (owned >= GUILD.maxTabs) return null;
  const bought = Math.max(0, owned - 1);
  return GUILD.firstTabPrice + GUILD.tabPriceStep * bought;
}
