import { defineConfig } from 'vitest/config';

// Unit-test tier (Phase 2.5): *.spec.ts files run under vitest (parallel,
// watch mode, consistent reporting). The *.test.ts files are the legacy
// tsx-script integration suites -- they need the live Supabase stack and are
// invoked individually via the test:* scripts until ported.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.spec.ts'],
  },
});
