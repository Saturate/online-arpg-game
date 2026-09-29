import { CLASSES, type LeaderboardEntry, type LeaderboardResponse } from '@rune/shared';

export function runTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** '2026-09' reads as 'September 2026'. */
export function seasonName(season: string): string {
  const month = MONTHS[Number(season.slice(5)) - 1];
  return month ? `${month} ${season.slice(0, 4)}` : season;
}

function who(e: LeaderboardEntry): string {
  const names = e.names.map((n, i) => { const c = e.classes[i]; return c ? `${n} (${CLASSES[c].name})` : n; }).join(', ');
  // Staff can give themselves gear, so their runs are marked rather than hidden.
  return e.staff ? `${names} [staff]` : names;
}

function Board({ title, entries }: { title: string; entries: LeaderboardEntry[] }) {
  return (
    <section>
      <h3>{title}</h3>
      {entries.length === 0 ? (
        <p className="muted small">No runs yet this season.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Champions</th>
              <th>Score</th>
              <th>Wave</th>
              <th>Time</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e, i) => (
              <tr key={`${e.finishedAt}-${i}`}>
                <td>{i + 1}</td>
                <td>{who(e)}</td>
                <td className="num">{e.score.toLocaleString()}</td>
                <td className="num">{e.wave}</td>
                <td className="num">{runTime(e.seconds)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** Both boards for one season and the past winners. Shared by the in-game stone and the admin page. */
export function LeaderboardTables({ board }: { board: LeaderboardResponse }) {
  return (
    <div className="arena-board">
      <Board title={`Solo, ${seasonName(board.season)}`} entries={board.solo} />
      <Board title={`Party, ${seasonName(board.season)}`} entries={board.party} />
      <section>
        <h3>Past champions</h3>
        {board.winners.length === 0 ? (
          <p className="muted small">This is the first season.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Season</th>
                <th>Solo</th>
                <th>Party</th>
              </tr>
            </thead>
            <tbody>
              {board.winners.map((w) => (
                <tr key={w.season}>
                  <td>{seasonName(w.season)}</td>
                  <td>{w.solo ? `${who(w.solo)}: ${w.solo.score.toLocaleString()}` : 'none'}</td>
                  <td>{w.party ? `${who(w.party)}: ${w.party.score.toLocaleString()}` : 'none'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
