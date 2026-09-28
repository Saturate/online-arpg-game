import type { CharacterSummary, GameMode } from '@rune/shared';
import { useEffect, useRef } from 'react';
import { Game } from '../game/game.js';
import { CharacterPanel } from './CharacterPanel.js';
import { DebugOverlay } from './DebugOverlay.js';
import { DevPanel } from './DevPanel.js';
import { EscMenu } from './EscMenu.js';
import { useUi } from './store.js';
import { Banner, Hud, Notices, Party, RecordingBadge } from './Hud.js';
import { Inventory, ItemTooltip } from './Inventory.js';
import { SigilEditor } from './SigilEditor.js';
import { StagingPanel } from './StagingPanel.js';
import { TownEditorPanel } from './TownEditorPanel.js';

export function GameView({ token, character, mode }: { token: string; character: CharacterSummary; mode: GameMode }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const fxRef = useRef<HTMLDivElement>(null);
  const minimapRef = useRef<HTMLCanvasElement>(null);
  const minimapVisible = useUi((s) => s.minimapVisible);
  const roomName = useUi((s) => s.roomName);

  useEffect(() => {
    const host = hostRef.current;
    const fx = fxRef.current;
    if (!host || !fx) return;
    const game = new Game({ host, fxLayer: fx, minimap: minimapRef.current }, { kind: 'live', token, character, mode });
    void game.start();
    return () => game.destroy();
  }, [token, character, mode]);

  return (
    <div className="game">
      <div className="canvas-host" ref={hostRef} />
      <div className="fx-layer" ref={fxRef} aria-hidden="true" />
      <div className={`minimap${minimapVisible ? '' : ' hidden'}`}>
        <canvas ref={minimapRef} aria-label="Minimap" />
        <span>{roomName}</span>
      </div>
      <Party />
      <Notices />
      <Banner />
      <RecordingBadge />
      <Hud />
      <Inventory />
      <CharacterPanel />
      <SigilEditor />
      <DebugOverlay />
      <EscMenu />
      <TownEditorPanel />
      <DevPanel />
      <StagingPanel />
      <ItemTooltip />
    </div>
  );
}
