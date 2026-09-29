import type { TraderEntry } from '../protocol/messages.js';
import type { RuneId } from '../runes/v2/runes.js';
import type { StashSave } from '../sim/inventory.js';
import type { PlayerSave } from '../sim/simulation.js';

/**
 * One-time conversion of v1 data (rune ids from the old compiler; sigils holding a rune id list,
 * a prebaked skill id and per-slot binding flags) to the v2 items. Anything stored without
 * `runeFormat: 2` comes through here before anything else reads it. Input is whatever JSON.parse
 * gave, so it is checked, not trusted.
 */

/** What one conversion did, for the server log and the conversion check against live data. */
export interface ConversionReport {
  /** Built-in skill sigils rebuilt as starter sigils, by starter id. */
  starterSigils: string[];
  /** Loose runes carried over one to one (Link becomes Bond). */
  runesMapped: { from: string; to: RuneId; count: number }[];
  /** Runes with no v2 counterpart (Linger, Pierce), paid out at their sell value. */
  runesRefunded: { from: string; count: number; gold: number }[];
  /** Total gold owed for refunded runes. */
  gold: number;
  /** Runes a hand-inscribed sigil could not keep, returned to the bag or pending. */
  runesReturned: number;
  /** Anything a human should look at. */
  warnings: string[];
}

export interface CharacterConversion {
  save: PlayerSave;
  report: ConversionReport;
}

export interface StashConversion {
  stash: StashSave;
  report: ConversionReport;
}

/** The trader's shared shelf as stored. */
export interface TraderShelfSave {
  nextId: number;
  stock: TraderEntry[];
  runeFormat: 2;
}

export interface TraderShelfConversion {
  shelf: TraderShelfSave;
  report: ConversionReport;
}

export function emptyReport(): ConversionReport {
  return { starterSigils: [], runesMapped: [], runesRefunded: [], gold: 0, runesReturned: 0, warnings: [] };
}

function notWritten(what: string): Error {
  return new Error(`v1 ${what} found, but the v1 to v2 conversion is not written yet (packages/shared/src/items/convertV2.ts). Move the v1 database aside or finish the conversion.`);
}

export function convertCharacterSave(raw: unknown): CharacterConversion {
  throw notWritten('character save');
}

export function convertStash(raw: unknown): StashConversion {
  throw notWritten('account stash');
}

export function convertTraderShelf(raw: unknown): TraderShelfConversion {
  throw notWritten('trader shelf');
}

/** Stored JSON carries this marker once it is v2; anything without it is v1. */
export function isRuneFormat2(raw: unknown): boolean {
  return typeof raw === 'object' && raw !== null && Reflect.get(raw, 'runeFormat') === 2;
}
