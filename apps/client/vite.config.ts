import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // Must match the server's BUILD_ID; a mismatch on connect makes the tab reload itself.
  define: { __BUILD_ID__: JSON.stringify(process.env.BUILD_ID ?? 'dev') },
  server: {
    port: 5173,
    // Same-origin /api in dev, matching a production deploy that serves client and server together.
    proxy: { '/api': process.env.RUNE_SERVER ?? 'http://localhost:8080' },
  },
  build: {
    rollupOptions: {
      // The game and the staff pages are separate; admin and dev tools never ship inside the game bundle.
      input: { main: resolve(import.meta.dirname, 'index.html'), admin: resolve(import.meta.dirname, 'admin/index.html'), dev: resolve(import.meta.dirname, 'admin/dev/index.html') },
    },
  },
});
