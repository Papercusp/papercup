import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const OPERATOR_DIR = resolve(__dirname, '../..');
const E2E_DIR = join(OPERATOR_DIR, 'e2e');

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

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? listFiles(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

/**
 * Profile configs are read as SOURCE, never imported: a profile config may
 * validate its credentials at load (playwright.hosted-http1.config.ts throws
 * without PAPERCUSP_HOSTED_ACCEPTANCE_STORAGE_STATE), which is the very failure
 * this guard keeps out of the default run.
 */
function profileTestMatches(): Array<{ config: string; testMatch: RegExp }> {
  return readdirSync(OPERATOR_DIR)
    .filter((name) => /^playwright\.[a-z0-9-]+\.config\.ts$/.test(name))
    .flatMap((config) => {
      const source = readFileSync(join(OPERATOR_DIR, config), 'utf8');
      const match = /testMatch:\s*\/((?:\\.|[^/\\\n])+)\/([a-z]*)/.exec(source);
      return match ? [{ config, testMatch: new RegExp(match[1], match[2]) }] : [];
    });
}

describe('default Playwright run never collects a profile-owned spec (WI-10006736)', () => {
  it('ignores every e2e file a playwright.<profile>.config.ts selects', async () => {
    const { default: config } = await import('../../playwright.config');
    const testMatch = config.testMatch as RegExp;
    const testIgnore = (config.testIgnore ?? []) as RegExp[];
    const collectedByDefault = (file: string) =>
      testMatch.test(file) && !testIgnore.some((pattern) => pattern.test(file));

    const profiles = profileTestMatches();
    // Positive control: the extractor must find the profile that motivated this
    // guard, or every assertion below passes vacuously.
    expect(profiles.map((p) => p.config)).toContain('playwright.hosted-http1.config.ts');

    const files = listFiles(E2E_DIR);
    const owned = files.filter((file) => profiles.some((p) => p.testMatch.test(file)));
    expect(owned.map((file) => file.slice(E2E_DIR.length + 1))).toContain(
      'hosted-http1-acceptance.spec.ts',
    );

    // Control: testMatch ALONE does collect a profile-owned spec, so the
    // testIgnore below is load-bearing and removing it turns this guard red.
    expect(owned.filter((file) => testMatch.test(file))).not.toEqual([]);

    const leaked = owned.filter(collectedByDefault).map((file) => file.slice(E2E_DIR.length + 1));
    expect(leaked).toEqual([]);
  });

  it('every spec that fetches from inside the page first puts the page on the app origin', () => {
    // The fixture page starts on about:blank (an opaque origin) and the API sends
    // no CORS headers, so an in-page fetch without a prior navigation fails with
    // "TypeError: Failed to fetch" and the spec measures nothing (WI-10006736).
    const fetchesInPage = (source: string) => /page\.evaluate\(/.test(source) && /\bfetch\(/.test(source);
    const navigatesFirst = (source: string) => /\bonAppOrigin\(|\.goto\(/.test(source);

    // Control: the predicate flags the exact shape that was broken.
    const brokenShape = "const r = await page.evaluate(async (u) => { await fetch(u); }, url);";
    expect(fetchesInPage(brokenShape) && !navigatesFirst(brokenShape)).toBe(true);

    const specs = listFiles(E2E_DIR).filter((file) => file.endsWith('.spec.ts'));
    const inPageFetchers = specs.filter((file) => fetchesInPage(readFileSync(file, 'utf8')));
    const names = (list: string[]) => list.map((file) => file.slice(E2E_DIR.length + 1)).sort();
    // Positive control: the detector still sees the specs it was written for.
    expect(names(inPageFetchers)).toEqual(
      expect.arrayContaining(['sse-last-event-id.spec.ts', 'state-snapshot-sse.spec.ts']),
    );

    const unnavigated = inPageFetchers.filter((file) => !navigatesFirst(readFileSync(file, 'utf8')));
    expect(names(unnavigated)).toEqual([]);
  });

  it('every spec that reads the superuser token resolves PAPERCUSP_HOME first', () => {
    // An isolated operator (VERIFY_TAURI_ISOLATED_DB=1) has its own PAPERCUSP_HOME,
    // so a spec that hard-codes ~/.papercusp sends a foreign bearer and the
    // verified-only routes answer 403 (WI-10006736, admin-routes.spec.ts).
    const readsSuToken = (source: string) => /['"]superuser-token['"]/.test(source);
    const resolvesHome = (source: string) => /process\.env\.PAPERCUSP_HOME/.test(source);

    // Control: the predicate flags the exact shape that was broken.
    const brokenShape = "readFileSync(join(homedir(), '.papercusp', 'superuser-token'), 'utf8')";
    expect(readsSuToken(brokenShape) && !resolvesHome(brokenShape)).toBe(true);

    const specs = listFiles(E2E_DIR).filter((file) => file.endsWith('.ts'));
    const names = (list: string[]) => list.map((file) => file.slice(E2E_DIR.length + 1)).sort();
    const tokenReaders = specs.filter((file) => readsSuToken(readFileSync(file, 'utf8')));
    // Positive control: the detector still sees the spec it was written for.
    expect(names(tokenReaders)).toContain('admin-routes.spec.ts');

    const hardCoded = tokenReaders.filter((file) => !resolvesHome(readFileSync(file, 'utf8')));
    expect(names(hardCoded)).toEqual([]);
  });

  it('warms the dev server in globalSetup, and the warm-up is never collected as a spec (WI-10006792)', async () => {
    const { default: config } = await import('../../playwright.config');
    const setup = config.globalSetup;
    expect(typeof setup).toBe('string');
    const setupPath = resolve(OPERATOR_DIR, setup as string);
    expect(setupPath).toBe(join(E2E_DIR, '_warm-dev-server.ts'));
    const mod = await import(setupPath);
    expect(typeof mod.default).toBe('function');
    expect(mod.WARMUP_PATHS).toContain('/adv');
    const testMatch = config.testMatch as RegExp;
    expect(testMatch.test(setupPath)).toBe(false);
  });

  it('still collects ordinary specs (the ignore list is not over-broad)', async () => {
    const { default: config } = await import('../../playwright.config');
    const testMatch = config.testMatch as RegExp;
    const testIgnore = (config.testIgnore ?? []) as RegExp[];
    const ordinary = join(E2E_DIR, 'desktop-grid.spec.ts');
    expect(testMatch.test(ordinary)).toBe(true);
    expect(testIgnore.some((pattern) => pattern.test(ordinary))).toBe(false);
  });
});
