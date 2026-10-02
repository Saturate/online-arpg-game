import { CHAT_LINKS, CHAT_MAX_LENGTH, chatSegments, type Item } from '@rune/shared';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { composeChat, linkLabel, linkUidAt, ownItem, type DraftLink } from './chatCompose.js';
import { useHover } from './Inventory.js';
import { tierColor } from './parts.js';
import { chatPartner, openPlayerMenu } from './playerActions.js';
import { sendCommand, useUi, type ChatLine } from './store.js';
import { chatWho } from './chatLine.js';

/** Lines stay readable this long after arriving, then fade; opening the chat shows them all again. */
const VISIBLE_MS = 12_000;

/** A linked item: its name in tier colour, with the full tooltip on hover. Text only, never markup. */
function ItemLink({ item }: { item: Item }) {
  const set = useHover((h) => h.set);
  // A line that scrolls out of the list takes its link away without a mouseleave.
  useEffect(
    () => () => {
      if (useHover.getState().item === item) useHover.getState().set(null, 0, 0);
    },
    [item],
  );
  return (
    <span
      className="chat-link"
      style={{ color: tierColor(item) }}
      onMouseEnter={(e) => set(item, e.clientX, e.clientY, { at: 'chat' })}
      onMouseMove={(e) => set(item, e.clientX, e.clientY, { at: 'chat' })}
      onMouseLeave={() => set(null, 0, 0)}
    >
      {linkLabel(item.name)}
    </span>
  );
}

function Body({ line }: { line: ChatLine }) {
  if (line.items.length === 0) return <>{line.text}</>;
  return (
    <>
      {chatSegments(line.text, line.items).map((seg, i) => (typeof seg === 'string' ? <span key={i}>{seg}</span> : <ItemLink key={i} item={seg} />))}
    </>
  );
}

function Line({ line }: { line: ChatLine }) {
  const me = useUi((s) => s.name);
  if (line.kind === 'system') return <li className="chat-line system">{line.text}</li>;
  // The server speaks on the guild channel too (the message of the day on entering), with no sender.
  if (line.from === '')
    return (
      <li className={`chat-line ${line.kind} unsigned`}>
        <Body line={line} />
      </li>
    );
  const who = chatWho(line);
  const partner = chatPartner(line, me);
  return (
    <li className={`chat-line ${line.kind}`}>
      <b
        className="chat-who"
        onContextMenu={(e) => {
          e.preventDefault();
          if (partner) openPlayerMenu(partner, e.clientX, e.clientY);
        }}
      >
        {who.tag && <span className="chat-tag">[{who.tag}] </span>}
        {who.name}:
      </b>{' '}
      <Body line={line} />
    </li>
  );
}

/** Enter opens it, Enter sends, Escape closes. Game keys are ignored while the input has focus. */
export function ChatBox() {
  const lines = useUi((s) => s.chat);
  const open = useUi((s) => s.chatOpen);
  // The character sheet occupies the bottom-left corner; chat steps aside instead of hiding under it.
  const shifted = useUi((s) => s.characterOpen);
  const [text, setText] = useState('');
  const [links, setLinks] = useState<DraftLink[]>([]);
  const [, force] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  // The capture listeners read these without being re-attached on every keystroke.
  const draft = useRef({ text, links });
  draft.current = { text, links };
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Enter' || useUi.getState().chatOpen) return;
      const t = e.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return;
      e.preventDefault();
      useUi.setState({ chatOpen: true });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // A whisper started from a player's menu opens the input with "/w name " typed in.
  const chatDraft = useUi((s) => s.chatDraft);
  useEffect(() => {
    if (!open) return;
    const draftText = chatDraft;
    if (draftText === null) return;
    useUi.setState({ chatDraft: null });
    setText(draftText);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(draftText.length, draftText.length);
    });
  }, [open, chatDraft]);

  useEffect(() => {
    if (open) input.current?.focus();
    // Closing turns pointer events off under the cursor, so no mouseleave comes to hide a link's tooltip.
    else if (useHover.getState().place?.at === 'chat') useHover.getState().set(null, 0, 0);
  }, [open]);

  // Shift+click on any item (bag, stash, equipment, forge, skill bar) while typing puts a link in
  // the message. Capture phase, so the item's own shift+click (drop, split a stack) does not run,
  // and the mousedown is cancelled so focus stays in the input and the chat does not close.
  useEffect(() => {
    if (!open) return;
    const linkable = (e: MouseEvent) => (e.shiftKey && e.button === 0 ? linkUidAt(e.target) : null);
    const onDown = (e: MouseEvent) => {
      if (linkable(e) === null) return;
      e.preventDefault();
      e.stopPropagation();
    };
    const onClick = (e: MouseEvent) => {
      const uid = linkable(e);
      if (uid === null) return;
      e.preventDefault();
      e.stopPropagation();
      const ui = useUi.getState();
      const item = ownItem(ui.inventory, uid);
      if (!item) return;
      const { text: cur, links: have } = draft.current;
      if (have.length >= CHAT_LINKS.max) {
        ui.notify(`At most ${CHAT_LINKS.max} item links per message`);
        return;
      }
      const el = input.current;
      const at = el?.selectionStart ?? cur.length;
      const end = el?.selectionEnd ?? at;
      const before = cur.slice(0, at);
      const label = `${before && !before.endsWith(' ') ? ' ' : ''}${linkLabel(item.name)} `;
      const next = before + label + cur.slice(end);
      if (next.length > CHAT_MAX_LENGTH) {
        ui.notify('No room for another link in this message');
        return;
      }
      setText(next);
      setLinks([...have, { uid, name: item.name }]);
      requestAnimationFrame(() => {
        el?.focus();
        el?.setSelectionRange(before.length + label.length, before.length + label.length);
      });
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('click', onClick, true);
    };
  }, [open]);

  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
    // Re-render once lines have aged out, so they fade without needing new messages.
    const t = setTimeout(() => force((n) => n + 1), VISIBLE_MS + 50);
    return () => clearTimeout(t);
  }, [lines.length, open]);

  const close = () => {
    setText('');
    setLinks([]);
    useUi.setState({ chatOpen: false });
    input.current?.blur();
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const msg = composeChat(text.trim(), links);
    if (msg.text) sendCommand(msg.links.length > 0 ? { t: 'chat', text: msg.text, links: msg.links } : { t: 'chat', text: msg.text });
    close();
  };

  const now = performance.now();
  const shown = open ? lines.slice(-30) : lines.filter((l) => now - l.at < VISIBLE_MS).slice(-8);
  return (
    <div className={`chat${open ? ' open' : ''}${shifted ? ' shifted' : ''}`}>
      <ul ref={list} aria-live="polite" aria-label="Chat">
        {shown.map((l) => (
          <Line key={l.id} line={l} />
        ))}
      </ul>
      {open ? (
        <form onSubmit={submit}>
          <input
            ref={input}
            value={text}
            maxLength={CHAT_MAX_LENGTH}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                close();
              }
            }}
            onBlur={() => text.trim() === '' && close()}
            placeholder="Say something to your game. /p party, /g guild. Shift+click an item to link it. /help for commands"
            aria-label="Chat message"
          />
        </form>
      ) : (
        lines.length === 0 && <p className="chat-hint">Press Enter to chat</p>
      )}
    </div>
  );
}
