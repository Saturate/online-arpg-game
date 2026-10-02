import { taggedName } from './guildView.js';

/** How a chat line names its sender: the guild tag apart (it has its own colour) and the name, or "from to to" on a whisper. */
export function chatWho(line: { kind: string; from: string; to: string | null; tag?: string | undefined }): { tag: string | null; name: string } {
  const name = line.kind === 'whisper' && line.to && line.from !== line.to ? `${line.from} to ${line.to}` : line.from;
  return { tag: line.tag && line.kind !== 'system' ? line.tag : null, name };
}

/** The whole sender as plain text, tag included, as a speech bubble or a copy would read it. */
export function chatWhoText(line: { kind: string; from: string; to: string | null; tag?: string | undefined }): string {
  const who = chatWho(line);
  return taggedName(who.name, who.tag ?? undefined);
}

/** Typing /gaccept or /gdecline answers the guild invite, so its prompt goes as if clicked. */
export function answersGuildInvite(text: string): boolean {
  return /^\/g(accept|decline)(\s|$)/i.test(text.trim());
}
