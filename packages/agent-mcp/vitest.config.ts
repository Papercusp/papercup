import { defineConfig } from 'vitest/config';
import { ADMIN_TEST_RUNS_REPORTER_PATH } from '@papercusp/test-config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Registers Papercusp's capability→tier policy (plan P-012) for every test
    // file, mirroring production where importing @papercusp/agent-mcp activates
    // it. Without this, defineTool/definePrompt stamp the engine's 'low' default.
    setupFiles: ['./src/__tests__/test-setup.ts'],
    // This workspace hand-rolls its vitest config (not defineVitestConfig), so it
    // opts into the /admin/testing status-chip reporter explicitly. Fail-soft.
    reporters:
      process.env.PAPERCUSP_DISABLE_TEST_RUNS_REPORTER === '1'
        ? ['default']
        : ['default', ADMIN_TEST_RUNS_REPORTER_PATH],
  },
});
