/**
 * Resolve a harness slug + workspace id to its on-disk project & state
 * directories. Used by both MCP and HTTP plugin-tool transports so
 * plugin functions reliably get a populated `ctx.projectDir`.
 *
 * Source of truth is PG (`harness_shared.harness_registry`, Migration 025
 * + 039 encryption) accessed via `loadHarnessRegistry`. The legacy
 * `<workspace-root>/registry.json` was retired when the operator moved
 * to PG-canonical state.
 *
 * Returns a placeholder under /tmp when the slug isn't registered or PG
 * is unreachable — callers that need a real path will see the obvious
 * `/tmp/papercusp-unresolved/...` prefix surface in their errors.
 */
import { join } from 'node:path';

export async function resolveHarnessPaths(
  harnessSlug: string,
  workspaceId: string,
): Promise<{ projectDir: string; stateDir: string }> {
  try {
    const { loadHarnessRegistry } = await import('./harness-registry');
    const reg = await loadHarnessRegistry();
    const proj = reg.projects.find((p) => p.slug === harnessSlug);
    if (proj?.path) {
      return { projectDir: proj.path, stateDir: join(proj.path, '.papercusp') };
    }
  } catch { /* fall through to placeholder */ }
  const placeholder = `/tmp/papercusp-unresolved/${workspaceId}/${harnessSlug}`;
  return { projectDir: placeholder, stateDir: `${placeholder}/.papercusp` };
}
