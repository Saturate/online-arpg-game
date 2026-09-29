/**
 * Dev tools deep links live in the URL hash (`#assets/built-in/giant_scorpion`), so any view can be
 * bookmarked or pasted to someone else. The first part is the tab; the rest belongs to that tab.
 */
export function readLink(): string[] {
  return location.hash
    .replace(/^#/, '')
    .split('/')
    .filter((p) => p !== '')
    .map((p) => decodeURIComponent(p));
}

/** Replaces the hash without adding a history entry for every click. */
export function writeLink(parts: readonly string[]): void {
  const hash = `#${parts.map((p) => encodeURIComponent(p)).join('/')}`;
  if (location.hash !== hash) history.replaceState(null, '', hash);
}
