import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AssetsTab } from './AssetsTab.js';
import { LootTab } from './LootTab.js';
import { ReplayTab } from './ReplayTab.js';
import { SpellStudioTab } from './SpellStudioTab.js';

type Tab = 'assets' | 'studio' | 'loot' | 'replay';

function DevApp() {
  const [tab, setTab] = useState<Tab>('assets');
  return (
    <div className="dev-app">
      <header className="dev-header">
        <h1>Rune dev tools</h1>
        <nav>
          <button type="button" className={tab === 'assets' ? 'on' : ''} onClick={() => setTab('assets')}>
            Assets
          </button>
          <button type="button" className={tab === 'studio' ? 'on' : ''} onClick={() => setTab('studio')}>
            Spell Studio
          </button>
          <button type="button" className={tab === 'loot' ? 'on' : ''} onClick={() => setTab('loot')}>
            Loot
          </button>
          <button type="button" className={tab === 'replay' ? 'on' : ''} onClick={() => setTab('replay')}>
            Replay
          </button>
        </nav>
        <a href="/">Back to game</a>
      </header>
      <main className="dev-main">{tab === 'assets' && <AssetsTab />}
        {tab === 'studio' && <SpellStudioTab />}
        {tab === 'loot' && <LootTab />}
        {tab === 'replay' && <ReplayTab />}</main>
    </div>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('#root missing from dev.html');
createRoot(root).render(
  <StrictMode>
    <DevApp />
  </StrictMode>,
);
