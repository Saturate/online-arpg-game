# Admin page: live view and search

Status: Planned (owner, 2026-10-01).

"Can we make the admin interface better?" The owner's pain points: no live view of what is happening, and finding things is slow. The users are the owner and his brother, on desktops. Each sees only what their role allows: the live view, search results and jumps follow the same permissions the server checks.

## Planned

- **Live view (the first tab):** refreshed every few seconds without reloading.
  - Who is online: name, class, level, region and room, party, time online, with a jump to the player.
  - Rooms: kind (world copy, dungeon, Arena), players, live monsters and spells, and the tick time against the 50 ms budget.
  - Server health: build, uptime, memory, tick time over the last minutes (a small sparkline), WebSocket connections and message rate.
  - A live tail of the server log (errors highlighted) and of staff changes (settings, tuning, town saves, grants), newest first.
  - A small world minimap with player dots per world copy.
- **Search everywhere:** one box (and Ctrl+K) that searches across players and characters, settings, tuning numbers (by path, label or category), monsters and minions, model check entries, tokens and log lines, and jumps to the match in its tab with the field focused.
- **Look:** the game's dark and gritty palette, compact, desktop first.

## How

- The server exposes what the live view needs through the admin API (an extended `GET /api/admin/overview` or a new `GET /api/admin/live`); tick timing is measured per room. Polling, not a socket, so it works with tokens.
- Search runs on the client over data the tabs already load, plus a server search for players and log lines.
