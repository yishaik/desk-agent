import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Boot smoke tests spawn Node and dynamic-import the full application;
    // this can exceed 15s on Windows and slower CI runners.
    testTimeout: 60_000,
    maxConcurrency: 1,
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
});
