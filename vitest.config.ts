import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    exclude: ['**/node_modules/**', '**/dist/**', '**/.worktrees/**', 'plugin/**'], // plugin tests run under `claude plugin test`,
  },
});
