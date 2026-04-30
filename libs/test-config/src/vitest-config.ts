import { defineConfig, type UserConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export type TestLayer = 'unit' | 'integration' | 'browser';

export interface DefineVitestConfigOptions {
  layer: TestLayer;
  setupFiles?: string[];
  globalSetup?: string[];
  include?: string[];
  exclude?: string[];
}

const baseExclude = ['**/node_modules/**', '**/dist/**', '**/.next/**'];

export function defineVitestConfig(opts: DefineVitestConfigOptions): UserConfig {
  const { layer, setupFiles = [], globalSetup = [], include, exclude = [] } = opts;

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
      testTimeout: layer === 'unit' ? 5_000 : layer === 'integration' ? 30_000 : 60_000,
      hookTimeout: layer === 'integration' ? 60_000 : 10_000,
      setupFiles,
      globalSetup,
      reporters: process.env.CI
        ? [['default', { summary: false }], ['junit', { outputFile: './junit.xml' }]]
        : ['default'],
      retry: process.env.CI ? (layer === 'integration' ? 1 : 0) : 0,
    },
  });
}
