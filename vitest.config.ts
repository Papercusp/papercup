import { defineConfig } from 'vitest/config';

// Direct repository-root `vitest run <path>` invocations use Vitest's default
// discovery root instead of a workspace config.  Keep the standard Vitest
// exclusions and apply the same scratch/archive exclusions used by the shared
// workspace configs so gate-owned worktrees can never masquerade as canonical
// test files.
export default defineConfig({
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
