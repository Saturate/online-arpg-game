import { CLASSES, type LeaderboardResponse } from '@rune/shared';
import { useEffect, useState } from 'react';
import { api } from '../net/api.js';
import { cssColor } from '../render/config.js';
import { LeaderboardTables, runTime, seasonName } from './ArenaBoard.js';
import { useMovablePanel } from './GamePanel.js';
import { useUi } from './store.js';

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

/** The champions' stone in the Arena gate: this season's boards, fetched fresh each time it opens. */
export function LeaderboardPanel() {
  const open = useUi((s) => s.boardOpen);
  const { ref: panelRef, handleProps } = useMovablePanel('leaderboard');
  const [board, setBoard] = useState<LeaderboardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    setError(null);
    void api.leaderboard().then((r) => {
      if (!live) return;
      if (r.ok) setBoard(r.data);
      else setError(r.error);
    });
    return () => {
      live = false;
    };
  }, [open]);
  if (!open) return null;
  return (
    <section ref={panelRef} className="panel leaderboard-panel" aria-label="Arena leaderboard">
      <header {...handleProps}>
        <h2>Champions of the Pit</h2>
        <button type="button" className="close" onClick={() => useUi.setState({ boardOpen: false })} aria-label="Close leaderboard">
          ×
        </button>
      </header>
      {error ? <p className="error">{error}</p> : board ? <LeaderboardTables board={board} /> : <p className="muted">Reading the stone</p>}
      <p className="muted small">Seasons run by calendar month (UTC). One life per run; score is kills plus a bonus for every wave cleared.</p>
    </section>
  );
}

/** The score screen when a run ends. It outlasts the trip back to the gate, until closed. */
export function ArenaResultPanel() {
  const result = useUi((s) => s.arenaResult);
  const { ref: panelRef, handleProps } = useMovablePanel('arena-result');
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (!result) return;
    const until = performance.now() + result.returnIn * 1000;
    setLeft(result.returnIn);
    const timer = setInterval(() => setLeft(Math.max(0, Math.ceil((until - performance.now()) / 1000))), 250);
    return () => clearInterval(timer);
  }, [result]);
  if (!result) return null;
  const place = result.rank === null ? 'Ended before the first wave, so it was not recorded.' : `${ordinal(result.rank)} on the ${result.board} board for ${seasonName(result.season)}.`;
  return (
    <section ref={panelRef} className="panel arena-result" aria-label="Arena run over">
      <header {...handleProps}>
        <h2>The pit has claimed you</h2>
      </header>
      <p className="arena-score">{result.score.toLocaleString()}</p>
      <dl>
        <div>
          <dt>Wave</dt>
          <dd>{result.wave}</dd>
        </div>
        <div>
          <dt>Kills</dt>
          <dd>{result.kills}</dd>
        </div>
        <div>
          <dt>Time</dt>
          <dd>{runTime(result.seconds)}</dd>
        </div>
      </dl>
      <ul>
        {result.party.map((p) => (
          <li key={p.name}>
            <span className="dot" style={{ background: cssColor(CLASSES[p.cls].color) }} />
            {p.name} <small className="muted">{CLASSES[p.cls].name}</small>
          </li>
        ))}
      </ul>
      <p className="arena-rank">{place}</p>
      {left > 0 && <p className="muted small">Back to the Arena gate in {left}</p>}
      <div className="row-actions">
        <button type="button" onClick={() => useUi.setState({ boardOpen: true })}>
          Leaderboard
        </button>
        <button type="button" onClick={() => useUi.setState({ arenaResult: null })}>
          Close
        </button>
      </div>
    </section>
  );
}
