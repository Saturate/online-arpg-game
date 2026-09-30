import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { activeTownEditor, useTownEditor } from '../game/townEditor.js';
import { filterPalette, groupPalette, paletteEntries, placeKey, type PaletteEntry, type PaletteGroup } from '../game/townPalette.js';
import { useModelIcons } from './itemIconRenderer.js';
import { tip } from './Tip.js';
import { requestTownThumb, thumbKey } from './townThumbs.js';

/**
 * Everything the place tool can put down, grouped and searchable, with a thumbnail per piece.
 * Groups start closed except the town pieces; a search opens every group with a match.
 */
export function TownPalette() {
  const place = useTownEditor((s) => s.place);
  const tool = useTownEditor((s) => s.tool);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<ReadonlySet<PaletteGroup>>(() => new Set(['Town pieces']));
  const list = useRef<HTMLDivElement>(null);
  const all = useMemo(() => paletteEntries(), []);
  const groups = useMemo(() => groupPalette(filterPalette(all, query)), [all, query]);
  const current = placeKey(place);
  const searching = query.trim() !== '';
  const toggle = (g: PaletteGroup) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(g)) next.add(g);
      return next;
    });
  return (
    <div className="town-palette">
      <h3>
        Place <span className="muted">({all.length})</span>
      </h3>
      <input className="town-layers-search" type="search" placeholder="Search pieces (fire, tower, grave...)" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search the palette" />
      <div className="town-palette-list" ref={list}>
        {groups.length === 0 && <p className="muted town-layers-empty">Nothing matches</p>}
        {groups.map((g) => {
          const shown = searching || open.has(g.group);
          return (
            <div key={g.group} className="town-palette-group">
              <button type="button" className="bare town-palette-head" aria-expanded={shown} onClick={() => toggle(g.group)} disabled={searching}>
                {shown ? '▾' : '▸'} {g.group} <span className="muted">({g.entries.length})</span>
              </button>
              {shown && (
                <div className="town-palette-grid">
                  {g.entries.map((e) => (
                    <Tile key={e.key} entry={e} on={tool === 'place' && e.key === current} root={list} />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Tile({ entry, on, root }: { entry: PaletteEntry; on: boolean; root: RefObject<HTMLDivElement | null> }) {
  const url = useModelIcons((s) => s.urls[thumbKey(entry)]);
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || url) return;
    // Thumbnails load their model only once the tile is on screen, so the editor never pulls the whole kit.
    const io = new IntersectionObserver(
      (seen) => {
        if (!seen.some((s) => s.isIntersecting)) return;
        requestTownThumb(entry);
        io.disconnect();
      },
      { root: root.current, rootMargin: '120px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [entry, url, root]);
  return (
    <button ref={ref} type="button" className={`town-tile${on ? ' on' : ''}`} onClick={() => activeTownEditor()?.setPlace(entry.item)} {...tip(entry.hint ? `${entry.label}: ${entry.hint}` : entry.label)}>
      <span className="town-tile-thumb">{url ? <img src={url} alt="" draggable={false} /> : null}</span>
      <span className="town-tile-label">{entry.label}</span>
    </button>
  );
}
