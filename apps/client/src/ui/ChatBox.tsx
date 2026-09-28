import { CHAT_MAX_LENGTH } from '@rune/shared';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { sendCommand, useUi, type ChatLine } from './store.js';

/** Lines stay readable this long after arriving, then fade; opening the chat shows them all again. */
const VISIBLE_MS = 12_000;

function Line({ line }: { line: ChatLine }) {
  if (line.kind === 'system') return <li className="chat-line system">{line.text}</li>;
  const who = line.kind === 'whisper' ? (line.to && line.from !== line.to ? `${line.from} to ${line.to}` : line.from) : line.from;
  return (
    <li className={`chat-line ${line.kind}`}>
      <b>{who}:</b> {line.text}
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
  const [, force] = useState(0);
  const input = useRef<HTMLInputElement>(null);
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

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
    // Re-render once lines have aged out, so they fade without needing new messages.
    const t = setTimeout(() => force((n) => n + 1), VISIBLE_MS + 50);
    return () => clearTimeout(t);
  }, [lines.length, open]);

  const close = () => {
    setText('');
    useUi.setState({ chatOpen: false });
    input.current?.blur();
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (t) sendCommand({ t: 'chat', text: t });
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
            placeholder="Say something to your game. /help for commands"
            aria-label="Chat message"
          />
        </form>
      ) : (
        lines.length === 0 && <p className="chat-hint">Press Enter to chat</p>
      )}
    </div>
  );
}
