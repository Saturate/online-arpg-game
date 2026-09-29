import type { CharacterSummary } from '@rune/shared';
import { useEffect, useRef } from 'react';
import { Game } from '../game/game.js';
import { guardLeaving } from '../game/leaveGuard.js';
import { claimGame } from '../game/tabLock.js';
import { CharacterPanel } from './CharacterPanel.js';
import { DebugOverlay } from './DebugOverlay.js';
import { ChatBox } from './ChatBox.js';
import { DevPanel } from './DevPanel.js';
import { EscMenu, PartyInvitePrompt } from './EscMenu.js';
import { SettingsPanel } from './SettingsPanel.js';
import { useSettings } from './settings.js';
import { useUi } from './store.js';
import { DRAG_TYPE, parseDrag } from './itemActions.js';
import { Banner, Hud, Notices, Party, RecordingBadge, TargetFrame } from './Hud.js';
import { Inventory, ItemTooltip, requestDrop, StashWindow, TraderWindow } from './Inventory.js';
import { ForgeEditor } from './ForgeEditor.js';
import { StagingPanel } from './StagingPanel.js';
import { ArenaResultPanel, LeaderboardPanel } from './ArenaPanels.js';
import { WaypointPanel } from './WaypointPanel.js';
import { TownEditorPanel } from './TownEditorPanel.js';

export function GameView({ token, character }: { token: string; character: CharacterSummary }) {
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
    const game = new Game({ host, fxLayer: fx, minimap: minimapRef.current }, { kind: 'live', token, character });
    void game.start();
    return () => game.destroy();
  }, [token, character, reconnectKey]);

  useEffect(guardLeaving, []);
  useEffect(() => claimGame(() => useUi.setState({ phase: 'elsewhere' })), []);

  return (
    <div className="game">
      <div
        className="canvas-host"
        ref={hostRef}
        // Dragging an item out of the bag onto the world drops it on the ground, D2 style.
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes(DRAG_TYPE)) e.preventDefault();
        }}
        onDrop={(e) => {
          e.preventDefault();
          const drag = parseDrag(e.dataTransfer.getData(DRAG_TYPE));
          if (drag?.from.at === 'bag') requestDrop(drag.uid);
          else if (drag) useUi.getState().notify('Only bag items can be dropped; take it off or out of the stash first');
        }}
      />
      {/* Darkened corners pull the eye to the hero, like D2's light radius. Under the damage numbers. */}
      <div className="vignette" aria-hidden="true" />
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
        <StashWindow />
        <TraderWindow />
        <CharacterPanel />
        <ForgeEditor />
        <DebugOverlay />
        <EscMenu />
        <PartyInvitePrompt />
        <TownEditorPanel />
        <DevPanel />
        <StagingPanel />
        <LeaderboardPanel />
        <ArenaResultPanel />
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
