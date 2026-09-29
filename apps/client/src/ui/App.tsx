import { CharacterSelect } from './CharacterSelect.js';
import { GameView } from './GameView.js';
import { Login } from './Login.js';
import { useUi } from './store.js';

export function App() {
  const phase = useUi((s) => s.phase);
  const token = useUi((s) => s.token);
  const character = useUi((s) => s.character);
  const mode = useUi((s) => s.mode);
  if (phase === 'playing' && token && character) return <GameView token={token} character={character} mode={mode} />;
  if (phase === 'elsewhere' && token && character) {
    return (
      <main className="picker">
        <h1>Allan's ARPG</h1>
        <p className="muted">{character.name} is playing in another tab. Only one tab can be in the game at a time.</p>
        <button type="button" className="primary" onClick={() => useUi.setState({ phase: 'playing' })} autoFocus>
          Play here
        </button>
      </main>
    );
  }
  if (phase === 'characters' && token) return <CharacterSelect />;
  return <Login />;
}
