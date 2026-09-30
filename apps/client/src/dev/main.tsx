import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { StaffGate } from '../admin/access.js';
import { readLink, writeLink } from './deepLink.js';
import { AssetsTab } from './AssetsTab.js';
import { LootTab } from './LootTab.js';
import { ReplayTab } from './ReplayTab.js';
import { RigsTab } from './rigs/RigsTab.js';
import { SpellLabTab } from './SpellLabTab.js';
import { SpellStudioTab, type InjectedSpell } from './SpellStudioTab.js';

const TABS = ['assets', 'monsters', 'studio', 'lab', 'loot', 'replay'] as const;
type Tab = (typeof TABS)[number];

function DevApp() {
  return (
    <StaffGate title="Allan's ARPG dev tools" permission="devTools">
      {() => <DevTools />}
    </StaffGate>
  );
}

function DevTools() {
  const [tab, setTabState] = useState<Tab>(() => {
    const first = readLink()[0];
    return TABS.find((t) => t === first) ?? 'assets';
  });
  const setTab = (next: Tab) => {
    setTabState(next);
    // A tab's own panel writes the rest of the link; switching tabs starts from the bare tab.
    writeLink([next]);
  };
  const [injected, setInjected] = useState<InjectedSpell | null>(null);
  return (
    <div className="dev-app">
      <header className="dev-header">
        <h1>Allan's ARPG dev tools</h1>
        <nav>
          <button type="button" className={tab === 'assets' ? 'on' : ''} onClick={() => setTab('assets')}>
            Assets
          </button>
          <button type="button" className={tab === 'monsters' ? 'on' : ''} onClick={() => setTab('monsters')}>
            Monsters
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
        {tab === 'monsters' && <RigsTab />}
        {tab === 'studio' && <SpellStudioTab injected={injected} onClearInjected={() => setInjected(null)} />}
        {tab === 'lab' && (
          <SpellLabTab
            onCast={(spell) => {
              setInjected(spell);
              setTab('studio');
            }}
          />
        )}
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
