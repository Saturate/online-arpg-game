import { guildCan, itemSize, MANAGED_RANKS, GUILD_RANK_NAMES, placements, STASH, type GuildStashView, type GuildTabView, type InventoryMessage, type ManagedRank, type TabPerms } from '@rune/shared';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { CELL, ItemCell, useDrag, useHover } from './Inventory.js';
import { DRAG_TYPE, parseDrag, type ItemPlace } from './itemActions.js';
import { accessText, canDragFrom, canSendBuy, currentGuildTab, draggedItem, guildDropAction, guildItem, involvesGuild, nextPendingPerms, PERM_KEYS, PERM_LABELS, type PermKey } from './guildStashView.js';
import { colorHex, TabEditor } from './StashTabEditor.js';
import { useStashView } from './stashView.js';
import { sendCommand, useUi } from './store.js';
import { tip } from './Tip.js';

/**
 * The guild side of the stash window (docs/features/guilds.md): the guild's tabs, a locked look for
 * the ones the viewer's rank cannot see inside, the grid, and for the Leader and Officers buying,
 * renaming, recolouring and per-rank permissions. Items move with the same drags and quick clicks
 * as the account stash; guildStashView.ts says what each sends.
 */

/** Whether the drag in progress would be taken by `target`, for the drop highlight. */
function useGuildAccepts(target: ItemPlace): boolean {
  const drag = useDrag((s) => s.drag);
  const inv = useUi((s) => s.inventory);
  const view = useUi((s) => s.guildStash);
  if (!drag || !involvesGuild(drag, target)) return false;
  const item = draggedItem(drag, inv, view);
  const action = item ? guildDropAction(view, item, drag, target) : null;
  return action !== null && 'send' in action;
}

function AccessIcons({ access }: { access: TabPerms }) {
  return (
    <span className="gstash-access" role="img" aria-label={accessText(access)} {...tip(accessText(access))}>
      {PERM_KEYS.map((k) => (
        <span key={k} className={`gstash-perm${access[k] ? ' on' : ''}`} title={`${PERM_LABELS[k]}: ${access[k] ? 'yes' : 'no'}`}>
          {PERM_LABELS[k][0]}
        </span>
      ))}
    </span>
  );
}

function GuildTabButton({ tab, active }: { tab: GuildTabView; active: boolean }) {
  const [over, setOver] = useState(false);
  const accepts = useGuildAccepts({ at: 'guildTab', tab: tab.id });
  const hoverTimer = useRef<number | null>(null);
  const clear = () => {
    if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
  };
  useEffect(() => clear, []);
  const locked = tab.cells === null;
  const style: CSSProperties & Record<'--tab', string> = { '--tab': colorHex(tab.color) };
  const count = tab.cells ? placements(tab.cells, STASH).length : null;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={`bare stash-tab${active ? ' active' : ''}${locked ? ' locked' : ''}${over ? (accepts ? ' drop-ok' : ' drop-no') : ''}`}
      style={style}
      onClick={() => useStashView.setState({ guildTab: tab.id })}
      onDragEnter={() => {
        setOver(true);
        clear();
        if (!locked) hoverTimer.current = window.setTimeout(() => useStashView.setState({ guildTab: tab.id }), 450);
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(DRAG_TYPE)) e.preventDefault();
      }}
      onDragLeave={() => {
        setOver(false);
        clear();
      }}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        clear();
        useDrag.setState({ drag: null });
        const drag = parseDrag(e.dataTransfer.getData(DRAG_TYPE));
        const ui = useUi.getState();
        const item = drag ? draggedItem(drag, ui.inventory, ui.guildStash) : undefined;
        if (!drag || !item) return;
        const action = guildDropAction(ui.guildStash, item, drag, { at: 'guildTab', tab: tab.id });
        if (action && 'send' in action) sendCommand(action.send);
        else if (action) ui.notify(action.refuse);
      }}
      {...tip(`${tab.name}: ${accessText(tab.access)}`)}
    >
      {locked && <span className="sr-only">Locked: </span>}
      <span className="stash-tab-name">{tab.name}</span>
      {count !== null && <span className="stash-tab-count">{count}</span>}
    </button>
  );
}

function BuyGuildTab({ view, gold }: { view: GuildStashView; gold: number }) {
  const [asking, setAsking] = useState(false);
  // The tab count the last Buy was sent at: a double click must not buy two tabs.
  const sent = useRef<number | null>(null);
  const price = view.tabPrice;
  useEffect(() => setAsking(false), [view.tabs.length]);
  const buy = () => {
    setAsking(false);
    if (!canSendBuy(sent.current, view.tabs.length)) return;
    sent.current = view.tabs.length;
    sendCommand({ t: 'guildBuyTab' });
  };
  if (price === null) return null;
  if (asking)
    return (
      <span className="stash-buy-ask">
        <span>
          Guild tab {view.tabs.length + 1} for <span className="gold">{price} gold</span> of yours?
        </span>
        <button type="button" onClick={buy}>
          Buy
        </button>
        <button type="button" onClick={() => setAsking(false)}>
          No
        </button>
      </span>
    );
  return (
    <span className="tip-host" {...tip(gold < price ? `You have ${gold} gold` : 'Paid from your own gold, owned by the guild')}>
      <button type="button" className="stash-buy" disabled={gold < price} onClick={() => setAsking(true)}>
        + Buy guild tab ({price} gold)
      </button>
    </span>
  );
}

/**
 * Per tab, what Officers and Members may do; the Leader can always do everything. A popover over
 * the grid, so opening it never moves the grid or grows the window.
 */
function PermEditor({ tab, onClose }: { tab: GuildTabView; onClose: () => void }) {
  const base = tab.perms;
  const [pending, setPending] = useState<Record<ManagedRank, TabPerms> | null>(null);
  // The server's next view of the tab is the truth again.
  useEffect(() => setPending(null), [base]);
  if (!base) return null;
  const shown = pending ?? base;
  const set = (rank: ManagedRank, key: PermKey, on: boolean) => {
    const next = nextPendingPerms(base, pending, rank, key, on);
    setPending(next);
    sendCommand({ t: 'guildTabPerms', tab: tab.id, rank, perms: next[rank] });
  };
  return (
    <div className="gstash-perms-pop" role="dialog" aria-label={`Permissions for ${tab.name}`}>
      <table className="gstash-perms">
        <thead>
          <tr>
            <th scope="col">Rank</th>
            {PERM_KEYS.map((k) => (
              <th key={k} scope="col">
                {PERM_LABELS[k]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr className="muted">
            <th scope="row">Leader</th>
            <td colSpan={3}>always all</td>
          </tr>
          {MANAGED_RANKS.map((rank) => (
            <tr key={rank}>
              <th scope="row">{GUILD_RANK_NAMES[rank]}</th>
              {PERM_KEYS.map((k) => (
                <td key={k}>
                  <input type="checkbox" checked={shown[rank][k]} aria-label={`${GUILD_RANK_NAMES[rank]} ${PERM_LABELS[k].toLowerCase()}`} onChange={(e) => set(rank, k, e.target.checked)} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" className="small" onClick={onClose}>
        Done
      </button>
    </div>
  );
}

/** A locked tab keeps the grid's size, so switching to it never makes the window jump. */
function LockedGrid() {
  const style: CSSProperties = { gridTemplateColumns: `repeat(${STASH.w}, ${CELL}px)`, gridTemplateRows: `repeat(${STASH.h}, ${CELL}px)` };
  return (
    <div className="inv-bag stash-grid gstash-locked-grid">
      <div className="inv-grid" style={style} aria-hidden="true">
        {Array.from({ length: STASH.w * STASH.h }, (_, i) => (
          <span key={i} className="inv-cell grid-free gstash-locked-cell" />
        ))}
      </div>
      <p className="gstash-locked">Your rank cannot see inside this tab. The Leader or an Officer can open it to you.</p>
    </div>
  );
}

function GuildGrid({ view, tab }: { view: GuildStashView; tab: GuildTabView }) {
  const cells = tab.cells ?? [];
  const draggable = canDragFrom(tab);
  const byUid = useMemo(() => new Map(view.items.map((i) => [i.uid, i])), [view.items]);
  const style: CSSProperties = { gridTemplateColumns: `repeat(${STASH.w}, ${CELL}px)`, gridTemplateRows: `repeat(${STASH.h}, ${CELL}px)` };
  const at = (x: number, y: number): ItemPlace => ({ at: 'guild', tab: tab.id, x, y });
  return (
    <div className="inv-grid" style={style}>
      {cells.map((uid, i) =>
        uid === null ? <ItemCell key={`free-${i}`} item={undefined} place={at(i % STASH.w, Math.floor(i / STASH.w))} className="inv-cell grid-free" style={{ gridColumn: (i % STASH.w) + 1, gridRow: Math.floor(i / STASH.w) + 1 }} /> : null,
      )}
      {placements(cells, STASH).map(({ uid, x, y }) => {
        const item = byUid.get(uid);
        if (!item) return null;
        const s = itemSize(item);
        return (
          <ItemCell
            key={uid}
            item={item}
            place={at(x, y)}
            gridCell={CELL}
            canDrag={draggable}
            className={`inv-cell grid-item${tab.access.withdraw ? '' : ' gstash-held'}`}
            iconSize={Math.min(s.w, s.h) * CELL - 4}
            style={{ gridColumn: `${x + 1} / span ${s.w}`, gridRow: `${y + 1} / span ${s.h}` }}
          />
        );
      })}
    </div>
  );
}

/** The guild tabs and the open tab; mounted only while the stash window shows the guild side. */
export function GuildStashPane({ inv }: { inv: InventoryMessage }) {
  const view = useUi((s) => s.guildStash);
  const rank = useUi((s) => s.guild?.rank ?? null);
  const wanted = useStashView((s) => s.guildTab);
  const [editing, setEditing] = useState(false);
  const [perms, setPerms] = useState(false);
  useEffect(() => {
    setEditing(false);
    setPerms(false);
  }, [wanted]);
  // A cell that changes under the mouse never sends mouseleave; drop a tooltip whose item left its cell.
  useEffect(() => {
    const { item, place, set } = useHover.getState();
    if (!item || place?.at !== 'guild') return;
    const tab = view?.tabs.find((t) => t.id === place.tab);
    const still = tab?.cells?.[place.y * STASH.w + place.x] === item.uid ? guildItem(view, item.uid) : undefined;
    if (!still) set(null, 0, 0);
  }, [view]);
  if (!view) return <p className="stash-empty gstash-wait">Opening the guild stash</p>;
  const tab = currentGuildTab(view, wanted);
  const manager = rank !== null && guildCan(rank, 'manageTabs');
  // Someone else's change can take the power away while an editor is open.
  const editOpen = editing && manager;
  const permsOpen = perms && manager;
  const style: CSSProperties & Record<'--tab', string> = { '--tab': tab ? colorHex(tab.color) : '#6e6a62' };
  const used = tab?.cells ? placements(tab.cells, STASH).length : 0;
  return (
    <>
      <div className="stash-tabs" role="tablist" aria-label="Guild stash tabs">
        {view.tabs.map((t) => (
          <GuildTabButton key={t.id} tab={t} active={t.id === tab?.id} />
        ))}
        {manager && <BuyGuildTab view={view} gold={inv.gold} />}
      </div>
      <div className="stash-pane">
        {tab && (
          <div className="stash-toolbar">
            <span className="stash-title general" style={style}>
              {tab.name}
            </span>
            {tab.cells && <span className="muted">{used} items</span>}
            <AccessIcons access={tab.access} />
            <span className="stash-spacer" />
            {manager && (
              <>
                <button type="button" onClick={() => setEditing(true)}>
                  Rename
                </button>
                <button type="button" className={permsOpen ? 'on' : ''} aria-pressed={permsOpen} onClick={() => setPerms((p) => !p)}>
                  Permissions
                </button>
              </>
            )}
          </div>
        )}
        {tab && permsOpen && <PermEditor tab={tab} onClose={() => setPerms(false)} />}
        {tab?.cells ? (
          <div className="inv-bag stash-grid">
            <GuildGrid view={view} tab={tab} />
          </div>
        ) : (
          <LockedGrid />
        )}
        {view.unplaced > 0 && <p className="muted small">{view.unplaced} items wait for room in the guild stash; they are placed as soon as a tab has space.</p>}
        {editOpen && tab && <TabEditor key={tab.id} name={tab.name} color={tab.color} onSave={(name, color) => sendCommand({ t: 'guildEditTab', tab: tab.id, name, color })} onClose={() => setEditing(false)} />}
      </div>
    </>
  );
}
