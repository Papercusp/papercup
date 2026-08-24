import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import { resolve } from 'node:path';

// Direct root runs need the workspace aliases used by apps/operator's source imports.
// Keep this list explicit: loading every workspace tsconfig here would make the generic
// root fallback parse the entire monorepo and could apply an unrelated package's paths.
export const ROOT_VITEST_TSCONFIG_PROJECTS = [
  resolve(__dirname, 'apps/operator/tsconfig.json'),
] as const;

// Direct repository-root `vitest run <path>` invocations use Vitest's default
// discovery root instead of a workspace config.  Keep the standard Vitest
// exclusions and apply the same scratch/archive exclusions used by the shared
// workspace configs so gate-owned worktrees can never masquerade as canonical
// test files.
export default defineConfig({
  plugins: [
    tsconfigPaths({
      ignoreConfigErrors: true,
      projects: [...ROOT_VITEST_TSCONFIG_PROJECTS],
    }),
  ],
  test: {
    exclude: [
      '**/node_modules/**',
      '**/.git/**',
      '**/dist/**',
      '**/.next/**',
      '**/.papercusp/**',
      '**/_retired/**',
    ],
  },
});
