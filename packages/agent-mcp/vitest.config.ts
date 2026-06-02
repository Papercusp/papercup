import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Registers Papercusp's capability→tier policy (plan P-012) for every test
    // file, mirroring production where importing @papercusp/agent-mcp activates
    // it. Without this, defineTool/definePrompt stamp the engine's 'low' default.
    setupFiles: ['./src/__tests__/test-setup.ts'],
  },
});
