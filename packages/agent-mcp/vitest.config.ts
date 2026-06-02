import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // cross-workspace-probe is a live-PG integration test AND its top-level
    // `import '@papercusp/db-org/workspace-context'` does not resolve under this
    // vitest config (the subpath export isn't visible here), so it errors at
    // module-eval — skipIf can't guard an import. Re-enabling it (plan P-005)
    // needs that resolution fixed first; until then it stays excluded.
    exclude: ['src/**/__tests__/cross-workspace-probe.test.ts'],
    environment: 'node',
    // Registers Papercusp's capability→tier policy (plan P-012) for every test
    // file, mirroring production where importing @papercusp/agent-mcp activates
    // it. Without this, defineTool/definePrompt stamp the engine's 'low' default.
    setupFiles: ['./src/__tests__/test-setup.ts'],
  },
});
