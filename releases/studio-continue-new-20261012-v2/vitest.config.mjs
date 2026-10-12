import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
if (!process.env.STUDIO_RELEASE_VITEST_ROOT) throw new Error('Run this suite with node run-tests.mjs.');

export default {
  root,
  test: {
    environment: 'node',
    globals: true,
    cache: false,
    include: ['tests/**/*.test.ts']
  },
  resolve: {
    alias: {
      vitest: resolve(process.env.STUDIO_RELEASE_VITEST_ROOT, 'dist/index.js')
    }
  }
};
