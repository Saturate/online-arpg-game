import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App.js';
import { installUiSounds } from './ui/uiSound.js';

// Game-only rules in styles.css (no text selection, the game cursors) hang off this class, so the
// admin page, which shares the stylesheet, keeps normal browser behaviour.
document.documentElement.classList.add('game-app');

// Images and links in the UI are not meant to be dragged out as files or URLs. Item and skill
// drags set draggable on their own element, and chat and text fields keep their text drags.
document.addEventListener('dragstart', (e) => {
  const t = e.target;
  const el = t instanceof Element ? t : t instanceof Node ? t.parentElement : null;
  if (!el?.closest('[draggable="true"], input, textarea, .chat')) e.preventDefault();
});

installUiSounds();

const root = document.getElementById('root');
if (!root) throw new Error('#root missing from index.html');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
