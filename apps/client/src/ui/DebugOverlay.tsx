import { itemByUid, compileFor, useUi } from './store.js';

export function DebugOverlay() {
  const visible = useUi((s) => s.debugVisible);
  const d = useUi((s) => s.debug);
  const inv = useUi((s) => s.inventory);
  const classId = useUi((s) => s.classId);
  if (!visible) return null;
  return (
    <div className="debug">
      <dl>
        <dt>tick</dt>
        <dd>{d.tick}</dd>
        <dt>rtt</dt>
        <dd>
          {d.rttMs ?? '?'} ms{d.addedRttMs > 0 ? ` (incl. ${d.addedRttMs} artificial)` : ''}
        </dd>
        <dt>entities</dt>
        <dd>
          {d.visibleEntities} visible / {d.roomEntities} room
        </dd>
        <dt>fps / draws</dt>
        <dd>
          {d.fps} / {d.drawCalls}
        </dd>
        <dt>pending inputs</dt>
        <dd>{d.pendingInputs}</dd>
        <dt>keys held</dt>
        <dd>{d.heldKeys || 'none'}</dd>
        <dt>last correction</dt>
        <dd>{d.correctionPx} px</dd>
        <dt>force (heat)</dt>
        <dd>{d.heat}</dd>
        <dt>last fizzle</dt>
        <dd>{d.lastFizzle ?? '-'}</dd>
      </dl>
      {inv && classId && (
        <ol className="sigil-debug">
          {inv.sigils.map((uid, slot) => {
            const item = itemByUid(inv, uid);
            if (!item || item.kind !== 'sigil') return <li key={slot}>-</li>;
            const r = compileFor(item, classId);
            return <li key={slot}>{r.ok ? `ok, ${r.persistent ? `${r.spirit} spirit` : `${r.force} force`}, ${r.peakEntities} ent` : `dud: ${r.errors[0]?.rule ?? '?'}`}</li>;
          })}
        </ol>
      )}
    </div>
  );
}
