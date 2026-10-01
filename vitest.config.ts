import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    // Some tests step minutes of game time or build whole worlds; CI runners are slower than a dev
    // machine and the 5 s default failed them there while they pass locally.
    testTimeout: 60_000,
  },
});
