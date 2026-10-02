import { CLASSES, GUILD_LIMITS, GUILD_RANK_NAMES, guildCan, type GuildInfo, type GuildMemberView } from '@rune/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { GamePanel, useMovablePanel } from './GamePanel.js';
import { cleanGuildName, foundProblem, INVITE_LAPSE_MS, pendingInvites, isSelf, LOG_KIND_LABELS, logRequest, memberActions, motdDraftChanged, onlineCount, sortRoster } from './guildView.js';
import { openPlayerMenu } from './playerActions.js';
import { keyLabel, useSettings } from './settings.js';
import { sendCommand, useUi } from './store.js';
import './guild.css';

/** The roster's online and zone columns go stale fast; the server resends the roster on request. */
const REFRESH_MS = 5000;

/** A step that cannot be undone waits for a second click. */
type Pending = { kind: 'kick' | 'transfer'; member: GuildMemberView } | { kind: 'leave' | 'disband' };

function pendingText(p: Pending, g: GuildInfo): string {
  if (p.kind === 'kick') return `Remove ${p.member.name} from the guild?`;
  if (p.kind === 'transfer') return `Make ${p.member.name} the Leader? You become an Officer.`;
  if (p.kind === 'leave') return `Leave ${g.name}?`;
  return `Disband ${g.name} for good? The guild stash must be empty.`;
}

function confirmPending(p: Pending): void {
  if (p.kind === 'kick') sendCommand({ t: 'guildKick', member: p.member.id });
  else if (p.kind === 'transfer') sendCommand({ t: 'guildTransfer', member: p.member.id });
  else if (p.kind === 'leave') sendCommand({ t: 'guildLeave' });
  else sendCommand({ t: 'guildDisband' });
}

function FoundForm() {
  const price = useUi((s) => s.guildFoundPrice);
  const gold = useUi((s) => s.inventory?.gold ?? 0);
  const [name, setName] = useState('');
  const [tag, setTag] = useState('');
  const clean = cleanGuildName(name);
  const problem = foundProblem(clean, tag, gold, price);
  const ready = clean !== '' && tag !== '' && problem === null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    sendCommand({ t: 'guildCreate', name: clean, tag });
  };
  return (
    <form className="guild-found" onSubmit={submit}>
      <p className="muted">You are not in a guild. Found one, or ask a Leader or Officer to invite you.</p>
      <label>
        <span>Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={GUILD_LIMITS.nameMax} placeholder="The Ashen Watch" spellCheck={false} />
      </label>
      <label>
        <span>Tag</span>
        <input className="guild-tag-input" value={tag} onChange={(e) => setTag(e.target.value)} maxLength={GUILD_LIMITS.tagMax} placeholder="ASH" spellCheck={false} />
      </label>
      {problem && <p className="guild-why">{problem}</p>}
      <div className="guild-found-row">
        <span>
          Costs <span className="gold">{price} gold</span> · you have {gold}
        </span>
        <button type="submit" className="primary" disabled={!ready}>
          Found guild
        </button>
      </div>
      <p className="muted small">The guild starts with one stash tab, at the stash chest in town. Tags show before your name.</p>
    </form>
  );
}

function Motd({ guild }: { guild: GuildInfo }) {
  const [draft, setDraft] = useState<string | null>(null);
  const can = guildCan(guild.rank, 'motd');
  if (draft !== null)
    return (
      <form
        className="guild-motd editing"
        onSubmit={(e) => {
          e.preventDefault();
          if (motdDraftChanged(draft, guild.motd)) sendCommand({ t: 'guildMotd', text: draft });
          setDraft(null);
        }}
      >
        <input
          autoFocus
          value={draft}
          maxLength={GUILD_LIMITS.motdMax}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              setDraft(null);
            }
          }}
          aria-label="Message of the day"
          placeholder="Empty clears it"
        />
        <button type="submit">Save</button>
      </form>
    );
  return (
    <div className="guild-motd">
      <p>{guild.motd || <span className="muted">No message of the day.</span>}</p>
      {can && (
        <button type="button" className="small" onClick={() => setDraft(guild.motd)}>
          Edit
        </button>
      )}
    </div>
  );
}

function Roster({ guild, onAsk }: { guild: GuildInfo; onAsk: (p: Pending) => void }) {
  const me = useUi((s) => s.name);
  const rows = sortRoster(guild.members);
  return (
    <div className="guild-roster-wrap">
      <table className="guild-roster">
        <colgroup>
          <col className="c-rank" />
          <col className="c-name" />
          <col className="c-class" />
          <col className="c-level" />
          <col className="c-where" />
          <col className="c-actions" />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">Rank</th>
            <th scope="col">Name</th>
            <th scope="col">Class</th>
            <th scope="col">Lvl</th>
            <th scope="col">Where</th>
            <th scope="col">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => {
            const self = isSelf(m, me);
            const can = memberActions(guild.rank, m, self);
            return (
              <tr
                key={m.id}
                className={`${m.online ? 'online' : 'offline'}${self ? ' self' : ''} rank-${m.rank}`}
                onContextMenu={(e) => {
                  e.preventDefault();
                  if (!self && m.online) openPlayerMenu(m.name, e.clientX, e.clientY);
                }}
              >
                <td className="guild-rank">{GUILD_RANK_NAMES[m.rank]}</td>
                <td className="guild-member-name">{m.name}</td>
                <td>{m.cls ? CLASSES[m.cls].name : ''}</td>
                <td>{m.level}</td>
                <td className="guild-zone">{m.online ? m.zone || 'online' : 'offline'}</td>
                <td className="guild-actions">
                  {can.promote && (
                    <button type="button" className="small" onClick={() => sendCommand({ t: 'guildPromote', member: m.id })} title="Make an Officer">
                      Promote
                    </button>
                  )}
                  {can.demote && (
                    <button type="button" className="small" onClick={() => sendCommand({ t: 'guildDemote', member: m.id })} title="Make a Member">
                      Demote
                    </button>
                  )}
                  {can.transfer && (
                    <button type="button" className="small guild-danger" onClick={() => onAsk({ kind: 'transfer', member: m })}>
                      Make Leader
                    </button>
                  )}
                  {can.kick && (
                    <button type="button" className="small guild-danger" onClick={() => onAsk({ kind: 'kick', member: m })}>
                      Kick
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** The Leader's open invites, each with Cancel; one that lapses drops off without waiting for the server. */
function PendingInvites({ guild }: { guild: GuildInfo }) {
  const [now, setNow] = useState(() => Date.now());
  const list = pendingInvites(guild, now);
  const open = list.length > 0;
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [open]);
  if (!open) return null;
  return (
    <section className="guild-invites" aria-label="Pending invites">
      <h3>Pending invites</h3>
      <ul>
        {list.map((i) => (
          <li key={i.id}>
            <span>{i.name}</span>
            <span className="muted">lapses in {Math.max(0, Math.ceil((i.at + INVITE_LAPSE_MS - now) / 1000))} s</span>
            <button type="button" className="small" onClick={() => sendCommand({ t: 'guildCancelInvite', member: i.id })}>
              Cancel
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function InviteForm() {
  const [name, setName] = useState('');
  return (
    <form
      className="guild-invite-form"
      onSubmit={(e) => {
        e.preventDefault();
        const n = name.trim();
        if (!n) return;
        sendCommand({ t: 'guildInvite', name: n });
        setName('');
      }}
    >
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Character name (online)" maxLength={24} aria-label="Invite to guild" />
      <button type="submit" disabled={!name.trim()}>
        Invite
      </button>
    </form>
  );
}

function when(at: number): string {
  const d = new Date(at);
  return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}

function askLog(older: boolean): void {
  const req = logRequest(useUi.getState().guildLog, older);
  useUi.setState((s) => ({ guildLog: { ...s.guildLog, append: req.append } }));
  sendCommand({ t: 'guildLog', before: req.before });
}

function GuildLog() {
  const log = useUi((s) => s.guildLog);
  useEffect(() => askLog(false), []);
  return (
    <div className="guild-log">
      {!log.loaded ? (
        <p className="muted">Reading the log</p>
      ) : log.entries.length === 0 ? (
        <p className="muted">Nothing logged yet.</p>
      ) : (
        <ol>
          {log.entries.map((e) => (
            <li key={e.id} className={`log-${e.kind}`}>
              <time dateTime={new Date(e.at).toISOString()}>{when(e.at)}</time>
              <span className="guild-log-kind">{LOG_KIND_LABELS[e.kind]}</span>
              <span className="guild-log-text">{e.text}</span>
            </li>
          ))}
        </ol>
      )}
      <div className="guild-log-more">
        <button type="button" className="small" onClick={() => askLog(false)}>
          Newest
        </button>
        {log.more && (
          <button type="button" className="small" onClick={() => askLog(true)} disabled={log.append}>
            Older
          </button>
        )}
      </div>
    </div>
  );
}

function InGuild({ guild }: { guild: GuildInfo }) {
  const [view, setView] = useState<'roster' | 'log'>('roster');
  const [pending, setPending] = useState<Pending | null>(null);
  // A roster change (the member left, a rank moved) makes the question stale; the 5 s refresh alone does not.
  const rosterKey = guild.members.map((m) => `${m.id}:${m.rank}`).join(',') + guild.rank;
  useEffect(() => setPending(null), [rosterKey]);
  const leader = guild.rank === 'leader';
  return (
    <>
      <div className="guild-head">
        <span className="guild-tag">[{guild.tag}]</span>
        <span className="guild-name">{guild.name}</span>
        <span className="muted">
          {onlineCount(guild)} online · {guild.members.length}/{guild.maxMembers} · you are {GUILD_RANK_NAMES[guild.rank]}
        </span>
      </div>
      <Motd guild={guild} />
      <div className="guild-views" role="tablist" aria-label="Guild window">
        <button type="button" role="tab" aria-selected={view === 'roster'} className={`bare${view === 'roster' ? ' on' : ''}`} onClick={() => setView('roster')}>
          Roster
        </button>
        <button type="button" role="tab" aria-selected={view === 'log'} className={`bare${view === 'log' ? ' on' : ''}`} onClick={() => setView('log')}>
          Log
        </button>
      </div>
      {view === 'roster' ? <Roster guild={guild} onAsk={setPending} /> : <GuildLog />}
      {view === 'roster' && guildCan(guild.rank, 'invite') && <InviteForm />}
      {view === 'roster' && <PendingInvites guild={guild} />}
      {pending ? (
        <div className="guild-confirm" role="alertdialog" aria-label="Confirm">
          <span>{pendingText(pending, guild)}</span>
          <button
            type="button"
            className="danger"
            onClick={() => {
              confirmPending(pending);
              setPending(null);
            }}
          >
            Yes
          </button>
          <button type="button" onClick={() => setPending(null)} autoFocus>
            No
          </button>
        </div>
      ) : (
        <div className="guild-foot">
          {/* The server refuses a Leader leaving: leadership is handed on first, or the guild disbanded. */}
          {!leader && (
            <button type="button" className="small" onClick={() => setPending({ kind: 'leave' })}>
              Leave guild
            </button>
          )}
          <span className="muted small">
            <kbd>/g</kbd> guild chat · right-click a name to invite
          </span>
          {/* Apart from everyday controls, at the far end, so it is never hit on the way to Leave. */}
          {guildCan(guild.rank, 'disband') && (
            <button type="button" className="small guild-danger guild-disband" onClick={() => setPending({ kind: 'disband' })}>
              Disband
            </button>
          )}
        </div>
      )}
    </>
  );
}

/** The guild window on G: the founding form outside a guild, the roster, message of the day and log inside one. */
export function GuildWindow() {
  const open = useUi((s) => s.guildOpen);
  const guild = useUi((s) => s.guild);
  const key = useSettings((s) => s.bindings.guild);
  const inGuild = guild !== null;
  // Opening asks once either way, so the founding price is the live one; members keep asking.
  useEffect(() => {
    if (open) sendCommand({ t: 'guildRefresh' });
  }, [open]);
  useEffect(() => {
    if (!open || !inGuild) return;
    const t = setInterval(() => sendCommand({ t: 'guildRefresh' }), REFRESH_MS);
    return () => clearInterval(t);
  }, [open, inGuild]);
  if (!open) return null;
  return (
    <GamePanel
      id="guild"
      className="guild-window"
      title={guild ? 'Guild' : 'Found a guild'}
      headerExtra={<kbd className="guild-key">{keyLabel(key)}</kbd>}
      onClose={() => useUi.setState({ guildOpen: false })}
      closeLabel="Close guild window"
      aria-label="Guild"
      // The game ignores keys typed into fields, so Escape in the invite or founding fields closes the window here.
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || !(e.target instanceof HTMLInputElement)) return;
        e.stopPropagation();
        e.target.blur();
        useUi.setState({ guildOpen: false });
      }}
    >
      {guild ? <InGuild guild={guild} /> : <FoundForm />}
    </GamePanel>
  );
}

/** A guild invite, answered with a click or /gaccept and /gdecline. */
export function GuildInvitePrompt() {
  const invite = useUi((s) => s.guildInvite);
  const { ref, handleProps } = useMovablePanel('guild-invite');
  if (!invite) return null;
  const answer = (accept: boolean) => {
    sendCommand({ t: 'guildAnswer', accept });
    useUi.setState({ guildInvite: null });
  };
  return (
    <div className="panel party-invite guild-invite" role="alertdialog" aria-label="Guild invite" ref={ref} {...handleProps}>
      <p>
        <b>{invite.from}</b> invites you to the guild <b>{invite.guild}</b> <span className="guild-tag">[{invite.tag}]</span>.
      </p>
      <div className="menu-actions row">
        <button type="button" className="primary" onClick={() => answer(true)} autoFocus>
          Join
        </button>
        <button type="button" onClick={() => answer(false)}>
          Decline
        </button>
      </div>
    </div>
  );
}
