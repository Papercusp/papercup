/**
 * Phased worktree helpers.
 *
 * Each project has up to three worktrees: staging (the main path),
 * testing (`<path>--testing` or config override), and production
 * (`<path>--production` or config override).
 *
 * Used by:
 *   - apps/operator/app/api/_hono/harness.ts — every `?phase=` route uses
 *     phasePath() to resolve to the right worktree.
 *   - apps/operator/lib/harness-fs-watcher.ts — the FS watcher mirrors all
 *     three phased worktrees into harness_shared.* with a `phase` column.
 */
import { join } from 'node:path';
import { type Phase, ALL_PHASES } from './harness-phases-const';

// Phase + ALL_PHASES live in the client-safe const module so client
// components can import them without pulling node:fs into the browser
// bundle. Re-exported here for back-compat with server callers.
export { type Phase, ALL_PHASES };

// `node:fs` is lazy-required inside the one function that needs it
// (phasePath). The static `import { readFileSync } from 'node:fs'` form
// at the top of the module had Turbopack incorrectly pulling this file
// into client bundles via PhaseTabs → HarnessDashboard → page (the
// trace was wrong but the bundling failed regardless). Lazy-require
// keeps the static-import surface client-safe.

interface ProjectLike {
  slug?: string;
  path: string;
}

/**
 * Resolve a (project, phase) pair to a filesystem path.
 *   staging      → project.path
 *   testing/prod → sibling `<path>--<phase>` OR explicit config override
 */
export function phasePath(project: ProjectLike, phase: Phase): string {
  if (phase === 'staging') return project.path;
  try {
    // Lazy-require so Turbopack doesn't see a top-level `node:fs` import.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const raw = readFileSync(join(project.path, '.papercusp', 'config.json'), 'utf8');
    const cfg = JSON.parse(raw);
    const override = cfg?.phases?.[phase]?.path;
    if (typeof override === 'string' && override.length > 0) return override;
  } catch {
    /* no config / unreadable / not JSON — fall through to convention */
  }
  return `${project.path}--${phase}`;
}

/**
 * Map a raw query-string `?phase=` value to a Phase, defaulting to staging.
 */
export function phasePhaseLabel(rawPhase: string | undefined): Phase {
  if (rawPhase === 'testing' || rawPhase === 'production' || rawPhase === 'staging') {
    return rawPhase;
  }
  return 'staging';
}
