import { CHAT_LINKS, type InventoryMessage, type Item, type ItemUid } from '@rune/shared';

/** A link the player put in the message being typed; the input shows it as `[name]`. */
export interface DraftLink {
  uid: ItemUid;
  name: string;
}

export function linkLabel(name: string): string {
  return `[${name}]`;
}

/**
 * The message to send: each draft link's label becomes a `{n}` token, in the order the links were
 * added. A label the player deleted drops that link, so the server only ever sees links still in the
 * text. Labels never contain braces, so a token cannot be mistaken for a later label.
 */
export function composeChat(text: string, links: readonly DraftLink[]): { text: string; links: ItemUid[] } {
  let out = text;
  const uids: ItemUid[] = [];
  for (const link of links) {
    if (uids.length >= CHAT_LINKS.max) break;
    const label = linkLabel(link.name);
    const at = out.indexOf(label);
    if (at < 0) continue;
    uids.push(link.uid);
    out = `${out.slice(0, at)}{${uids.length}}${out.slice(at + label.length)}`;
  }
  return { text: out, links: uids };
}

/** One of this player's items by uid, including runes inscribed in a sigil (the forge shows those). */
export function ownItem(inv: InventoryMessage | null, uid: ItemUid): Item | undefined {
  if (!inv) return undefined;
  for (const item of inv.items) {
    if (item.uid === uid) return item;
    if (item.kind === 'sigil') {
      const rune = item.slots.find((r) => r.uid === uid);
      if (rune) return rune;
    }
  }
  return undefined;
}

/** The uid an element offers for linking, from its `data-link-uid`, or null. */
export function linkUidAt(target: EventTarget | null): ItemUid | null {
  if (!(target instanceof Element)) return null;
  const el = target.closest('[data-link-uid]');
  const raw = el?.getAttribute('data-link-uid');
  if (raw === null || raw === undefined || !/^\d{1,15}$/.test(raw)) return null;
  return Number(raw);
}
