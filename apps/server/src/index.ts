import { NET } from '@rune/shared';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { AccountStore } from './accounts.js';
import { AccountApi } from './http.js';
import { RoomManager } from './manager.js';

const port = Number(process.env.PORT ?? NET.defaultPort);
const seed = Number(process.env.SEED ?? 1337);

const store = new AccountStore();
const rooms = new RoomManager(seed, store);
rooms.start();
const api = new AccountApi(store, (characterId) => rooms.endCharacterSession(characterId));

const http = createServer((req, res) => {
  if (!api.handle(req, res)) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  }
});
// Gameplay messages are tiny; the cap leaves room for a saved town layout and nothing much bigger.
const wss = new WebSocketServer({ server: http, maxPayload: 256 * 1024 });
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
