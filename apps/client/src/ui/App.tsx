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
  if (phase === 'characters' && token) return <CharacterSelect />;
  return <Login />;
}
