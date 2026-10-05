import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30_000,
    // Never write test secrets into the developer's OS keychain.
    env: { AGENT_DISCOVER_SECRETS: 'file' },
    hookTimeout: 30_000,
    exclude: ['**/node_modules/**', '**/dist/**', '**/.worktrees/**', 'plugin/**'], // plugin tests run under `claude plugin test`,
  },
});
