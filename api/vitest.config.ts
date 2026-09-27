import { defineConfig } from 'vitest/config';

// Vitest discovers *.spec.ts; test-manifest.json classifies standalone *.test.ts suites.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.spec.ts'],
  },
});
