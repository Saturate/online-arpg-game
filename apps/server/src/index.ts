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
rooms.start();

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

function shutdown(): void {
  rooms.stop();
  rooms.saveAll();
  store.close();
  wss.close();
  http.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
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
