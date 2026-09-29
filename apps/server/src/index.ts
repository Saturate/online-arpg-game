import { NET } from '@rune/shared';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { AccountStore } from './accounts.js';
import { AccountApi, parseAdminUsers } from './http.js';
import { RoomManager } from './manager.js';
import { staticHandler } from './static.js';

const port = Number(process.env.PORT ?? NET.defaultPort);
const seed = Number(process.env.SEED ?? 1337);

const store = new AccountStore();
const adminUsers = parseAdminUsers(process.env.ADMIN_USERS);
const rooms = new RoomManager(seed, store, adminUsers);
rooms.start();
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
const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: 256 * 1024 });
wss.on('connection', (socket) => rooms.connect(socket));
http.listen(port, () => console.log(`rune server listening on http://localhost:${port} (api and websocket)`));

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
