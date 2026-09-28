import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Same-origin /api in dev, matching a production deploy that serves client and server together.
    proxy: { '/api': process.env.RUNE_SERVER ?? 'http://localhost:8080' },
  },
  build: {
    rollupOptions: {
      // The game and the dev tools are separate pages; dev tools never ship inside the game bundle.
      input: { main: resolve(import.meta.dirname, 'index.html'), dev: resolve(import.meta.dirname, 'dev.html') },
    },
  },
});
