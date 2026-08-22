import { afterEach, describe, expect, it, vi } from 'vitest';

type WebServerConfig = {
  command?: string;
  url?: string;
  reuseExistingServer?: boolean;
  stdout?: string;
  stderr?: string;
};

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe('Playwright isolated webServer contract', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('passes the selected port strictly and preserves Vite startup diagnostics', async () => {
    const previousPort = process.env.OPERATOR_E2E_PORT;
    const previousBaseUrl = process.env.OPERATOR_E2E_BASE_URL;
    const previousReuse = process.env.OPERATOR_E2E_REUSE_SERVER;

    process.env.OPERATOR_E2E_PORT = '43179';
    delete process.env.OPERATOR_E2E_BASE_URL;
    delete process.env.OPERATOR_E2E_REUSE_SERVER;
    vi.resetModules();

    try {
      const { default: config } = await import('../../playwright.config');
      const webServer = config.webServer;
      expect(webServer).not.toBeUndefined();
      expect(Array.isArray(webServer)).toBe(false);

      const server = webServer as WebServerConfig;
      expect(server.command).toBe('npm run dev -- -- --port 43179 --strictPort');
      expect(server.url).toBe('http://localhost:43179');
      expect(server.reuseExistingServer).toBe(false);
      expect(server.stdout).toBe('pipe');
      expect(server.stderr).toBe('pipe');
    } finally {
      restoreEnv('OPERATOR_E2E_PORT', previousPort);
      restoreEnv('OPERATOR_E2E_BASE_URL', previousBaseUrl);
      restoreEnv('OPERATOR_E2E_REUSE_SERVER', previousReuse);
    }
  });
});
