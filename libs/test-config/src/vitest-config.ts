import { defineConfig, type UserConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export type TestLayer = 'unit' | 'integration' | 'browser';

export interface DefineVitestConfigOptions {
  layer: TestLayer;
  setupFiles?: string[];
  globalSetup?: string[];
  include?: string[];
  exclude?: string[];
  /** Disable the default vitest-fail-on-console setup. Default: false. */
  allowConsoleNoise?: boolean;
}

const baseExclude = ['**/node_modules/**', '**/dist/**', '**/.next/**'];

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAIL_ON_CONSOLE_SETUP = resolve(__dirname, 'setup-fail-on-console.ts');

export function defineVitestConfig(opts: DefineVitestConfigOptions): UserConfig {
  const { layer, setupFiles = [], globalSetup = [], include, exclude = [], allowConsoleNoise = false } = opts;
  const finalSetup = allowConsoleNoise ? setupFiles : [FAIL_ON_CONSOLE_SETUP, ...setupFiles];

  const layerInclude =
    include ??
    (layer === 'integration'
      ? ['**/*.integration.test.ts', '**/*.integration.test.tsx']
      : layer === 'browser'
      ? ['**/*.browser.test.ts', '**/*.browser.test.tsx']
      : ['**/*.test.ts', '**/*.test.tsx']);

  return defineConfig({
    plugins: [tsconfigPaths({ ignoreConfigErrors: true })],
    test: {
      include: layerInclude,
      exclude: [
        ...baseExclude,
        ...exclude,
        ...(layer === 'unit'
          ? ['**/*.integration.test.*', '**/*.browser.test.*']
          : []),
      ],
      pool: layer === 'integration' ? 'forks' : 'threads',
      // Integration tests share real PG schemas (e.g. harness_shared) — running
      // files in parallel races their `DROP SCHEMA CASCADE` teardown. Serialise.
      fileParallelism: layer === 'integration' ? false : undefined,
      testTimeout: layer === 'unit' ? 5_000 : layer === 'integration' ? 30_000 : 60_000,
      hookTimeout: layer === 'integration' ? 60_000 : 10_000,
      setupFiles: finalSetup,
      globalSetup,
      reporters: process.env.CI
        ? [['default', { summary: false }], ['junit', { outputFile: './junit.xml' }]]
        : ['default'],
      // Per testing-spec §1.9: integration retry=0 (deterministic via testcontainers
      // per worker); unit retry=0; E2E (Playwright config) handles its own retries.
      retry: 0,
    },
  });
}
