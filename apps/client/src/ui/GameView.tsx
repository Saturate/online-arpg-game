import type { CharacterSummary, GameMode } from '@rune/shared';
import { useEffect, useRef } from 'react';
import { Game } from '../game/game.js';
import { guardLeaving } from '../game/leaveGuard.js';
import { CharacterPanel } from './CharacterPanel.js';
import { DebugOverlay } from './DebugOverlay.js';
import { ChatBox } from './ChatBox.js';
import { DevPanel } from './DevPanel.js';
import { EscMenu } from './EscMenu.js';
import { SettingsPanel } from './SettingsPanel.js';
import { useSettings } from './settings.js';
import { useUi } from './store.js';
import { Banner, Hud, Notices, Party, RecordingBadge, TargetFrame } from './Hud.js';
import { Inventory, ItemTooltip } from './Inventory.js';
import { SigilEditor } from './SigilEditor.js';
import { StagingPanel } from './StagingPanel.js';
import { WaypointPanel } from './WaypointPanel.js';
import { TownEditorPanel } from './TownEditorPanel.js';

export function GameView({ token, character, mode }: { token: string; character: CharacterSummary; mode: GameMode }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const fxRef = useRef<HTMLDivElement>(null);
  const minimapRef = useRef<HTMLCanvasElement>(null);
  const minimapVisible = useUi((s) => s.minimapVisible);
  const roomName = useUi((s) => s.roomName);
  const uiScale = useSettings((s) => s.options.uiScale);
  const reconnectKey = useUi((s) => s.reconnectKey);
  const reconnecting = useUi((s) => s.reconnectAttempt > 0);

  useEffect(() => {
    const host = hostRef.current;
    const fx = fxRef.current;
    if (!host || !fx) return;
    const game = new Game({ host, fxLayer: fx, minimap: minimapRef.current }, { kind: 'live', token, character, mode });
    void game.start();
    return () => game.destroy();
  }, [token, character, mode, reconnectKey]);

  useEffect(guardLeaving, []);

  return (
    <div className="game">
      <div className="canvas-host" ref={hostRef} />
      <div className="fx-layer" ref={fxRef} aria-hidden="true" />
      {/* Everything scalable lives in one layer; the tooltip stays outside because it is placed at mouse coordinates. */}
      <div className="ui-layer" style={{ zoom: uiScale }}>
        <div className={`minimap${minimapVisible ? '' : ' hidden'}`}>
          <canvas ref={minimapRef} aria-label="Minimap" />
          <span>{roomName}</span>
        </div>
        <Party />
        <Notices />
        <ChatBox />
        <Banner />
        <RecordingBadge />
        <TargetFrame />
        <Hud />
        <Inventory />
        <CharacterPanel />
        <SigilEditor />
        <DebugOverlay />
        <EscMenu />
        <TownEditorPanel />
        <DevPanel />
        <StagingPanel />
        <WaypointPanel />
        <SettingsPanel />
      </div>
      {reconnecting && (
        <div className="reconnecting" role="status">
          Connection lost. Reconnecting...
        </div>
      )}
      <ItemTooltip />
    </div>
  );
}
