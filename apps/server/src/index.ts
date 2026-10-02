import { NET } from '@rune/shared';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { AccountStore } from './accounts.js';
import { events } from './eventLog.js';
import { AccountApi, parseAdminUsers } from './http.js';
import { RoomManager } from './manager.js';
import { staticHandler } from './static.js';

const port = Number(process.env.PORT ?? NET.defaultPort);
const seed = Number(process.env.SEED ?? 1337);

const store = new AccountStore();
const adminUsers = parseAdminUsers(process.env.ADMIN_USERS);
const rooms = new RoomManager(seed, store, adminUsers);
// Before the first tick and before the port opens, so no player can join a world still being put back.
rooms.restore();
rooms.start();
// The balance bench counts the stored saves once, in small steps between ticks; saves keep it current after.
void store.bench.seed();

/** Unclaimed guests are removed after 90 days without play. */
const GUEST_IDLE_MS = 90 * 24 * 60 * 60 * 1000;
const sweepGuests = (): void => {
  const n = store.deleteIdleGuests(GUEST_IDLE_MS, rooms.onlineAccounts());
  if (n > 0) events.log('server', `[guests] removed ${n} guest account${n === 1 ? '' : 's'} idle for 90 days`);
};
sweepGuests();
setInterval(sweepGuests, 6 * 60 * 60 * 1000).unref();
const api = new AccountApi(store, (characterId) => rooms.endCharacterSession(characterId), rooms, adminUsers);

// Production serves the built client from here; in dev Vite does it.
const serveStatic = process.env.STATIC_DIR ? staticHandler(process.env.STATIC_DIR) : null;

const http = createServer((req, res) => {
  if (api.handle(req, res)) return;
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }
  const notFound = () => {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  };
  if (!serveStatic) return notFound();
  serveStatic(req, res)
    .then((served) => {
      if (!served) notFound();
    })
    .catch(() => {
      if (!res.headersSent) notFound();
    });
});
// Gameplay messages are tiny; the cap leaves room for a saved town layout and nothing much bigger.
// Snapshots are repetitive JSON: deflate took a busy 8-player snapshot from 35.6 KB to 6.0 KB for
// about 0.03 ms of CPU. Level 1 because higher levels cost far more for little extra; tiny messages
// (inputs, pongs) are not worth compressing.
const wss = new WebSocketServer({
  server: http,
  path: '/ws',
  maxPayload: 256 * 1024,
  perMessageDeflate: { zlibDeflateOptions: { level: 1 }, threshold: 1024 },
});
wss.on('connection', (socket) => rooms.connect(socket));
http.listen(port, () => events.log('server', `rune server listening on http://localhost:${port} (api and websocket), build ${process.env.BUILD_ID ?? 'dev'}`));

/**
 * Kubernetes gives the pod 20 s after SIGTERM (terminationGracePeriodSeconds in the server repo's
 * k3s/apps/arpg/deployment.yaml). The write takes milliseconds; the rest is a short wait so every
 * client gets the restart message and the close frame, and waits for the new server instead of
 * giving up.
 */
const CLOSE_WAIT_MS = 1500;
let stopping = false;

function shutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  try {
    const r = rooms.shutdown();
    events.log('server', `[restart] ${signal}: saved ${r.players} players with the session snapshot (${r.piles} piles, ${Math.round(r.bytes / 1024)} KB) in ${r.ms.toFixed(1)} ms`);
  } catch (err) {
    // Nothing of that write landed; the characters are still saved, as before the snapshot existed.
    events.error('save', `[restart] ${signal}: the session snapshot could not be written; saving the characters alone`, err);
    try {
      rooms.saveAll();
    } catch (e) {
      events.error('save', `[restart] ${signal}: the plain save failed too`, e);
    }
  }
  store.close();
  http.close();
  wss.close();
  const started = Date.now();
  const wait = (): void => {
    if (wss.clients.size === 0 || Date.now() - started >= CLOSE_WAIT_MS) process.exit(0);
    setTimeout(wait, 50);
  };
  wait();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
// A crash gets the same save as SIGTERM, or up to 30 s of play (including items handed over on the
// ground) could be lost or duplicated. Then Kubernetes restarts the process rather than it running
// on in an unknown state.
process.on('uncaughtException', (err) => {
  events.error('error', 'uncaught exception, saving and exiting', err);
  try {
    rooms.stop();
    rooms.saveAll();
    store.close();
  } finally {
    process.exit(1);
  }
});
