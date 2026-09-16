import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * Tests run against TypeScript sources (no build step required) by aliasing the
 * workspace packages to their `src` entrypoints. Production code always resolves
 * through the built `dist` output via npm workspaces.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@proxypulse/shared': r('./shared/src/index.ts'),
      '@proxypulse/db': r('./db/src/index.ts'),
      '@proxypulse/service-crunchyroll': r('./services/crunchyroll/src/index.ts'),
      '@proxypulse/worker': r('./worker/src/index.ts'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    teardownTimeout: 10_000,
    unstubEnvs: true,
  },
});
