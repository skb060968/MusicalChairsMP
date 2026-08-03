import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['tests/**/*.{test,spec}.{js,mjs,cjs}'],
    // The e2e test drives the real modules against an in-memory Firebase mock
    // (no emulator, no network), so it is fast and deterministic enough to run
    // with everything else. `npm run test:e2e` runs it on its own.
    exclude: ['node_modules/**', 'dist/**'],
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      reporter: ['text', 'html'],
      include: ['src/**/*.js'],
    },
  },
});
