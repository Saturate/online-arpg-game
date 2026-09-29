import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { StaffGate } from '../admin/access.js';
import { AssetsTab } from './AssetsTab.js';
import { LootTab } from './LootTab.js';
import { ReplayTab } from './ReplayTab.js';
import { SpellLabTab } from './SpellLabTab.js';
import { SpellStudioTab } from './SpellStudioTab.js';

type Tab = 'assets' | 'studio' | 'lab' | 'loot' | 'replay';

function DevApp() {
  return (
    <StaffGate title="Allan's ARPG dev tools" permission="devTools">
      {() => <DevTools />}
    </StaffGate>
  );
}

function DevTools() {
  const [tab, setTab] = useState<Tab>('assets');
  return (
    <div className="dev-app">
      <header className="dev-header">
        <h1>Allan's ARPG dev tools</h1>
        <nav>
          <button type="button" className={tab === 'assets' ? 'on' : ''} onClick={() => setTab('assets')}>
            Assets
          </button>
          <button type="button" className={tab === 'studio' ? 'on' : ''} onClick={() => setTab('studio')}>
            Spell Studio
          </button>
          <button type="button" className={tab === 'lab' ? 'on' : ''} onClick={() => setTab('lab')}>
            Spell Lab
          </button>
          <button type="button" className={tab === 'loot' ? 'on' : ''} onClick={() => setTab('loot')}>
            Loot
          </button>
          <button type="button" className={tab === 'replay' ? 'on' : ''} onClick={() => setTab('replay')}>
            Replay
          </button>
        </nav>
        <a href="/admin/">Admin</a>
        <a href="/">Back to game</a>
      </header>
      <main className="dev-main">{tab === 'assets' && <AssetsTab />}
        {tab === 'studio' && <SpellStudioTab />}
        {tab === 'lab' && <SpellLabTab />}
        {tab === 'loot' && <LootTab />}
        {tab === 'replay' && <ReplayTab />}</main>
    </div>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('#root missing from admin/dev/index.html');
createRoot(root).render(
  <StrictMode>
    <DevApp />
  </StrictMode>,
);
