/**
 * Keeps the browser from dropping the player out of a game by accident: Back (the button, a mouse's
 * side buttons, a trackpad swipe) is swallowed, and reloading or closing the tab asks first. The
 * game's own reloads, like picking up a new build, call allowLeave() so they do not ask.
 */

let leaving = false;

export function allowLeave(): void {
  leaving = true;
}

export function guardLeaving(): () => void {
  // One extra history entry to step back into, so Back lands on the game again instead of leaving.
  history.pushState({ inGame: true }, '');
  const onPop = () => history.pushState({ inGame: true }, '');
  const onBeforeUnload = (e: BeforeUnloadEvent) => {
    if (!leaving) e.preventDefault();
  };
  // Mouse buttons 3 and 4 are Back and Forward; Chrome navigates on their mouseup.
  const onMouse = (e: MouseEvent) => {
    if (e.button === 3 || e.button === 4) e.preventDefault();
  };
  addEventListener('popstate', onPop);
  addEventListener('beforeunload', onBeforeUnload);
  addEventListener('mouseup', onMouse);
  addEventListener('mousedown', onMouse);
  return () => {
    removeEventListener('popstate', onPop);
    removeEventListener('beforeunload', onBeforeUnload);
    removeEventListener('mouseup', onMouse);
    removeEventListener('mousedown', onMouse);
  };
}
