import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { classifyRuntimeOwners } from './git-pipeline-position';

/**
 * WI-6659 — the CLASS guard behind the routinesTick runtime-ownership rules.
 *
 * `routinesTickImpl` dispatches its periodic sweeps by DIRECT `await import(...)`
 * rather than through the `system:<action>` registry, so the registry-shaped rules
 * in RUNTIME_OWNERS never matched them: every such path fell through to
 * DEFAULT_OWNER and `dev:pipeline_position` reported `deployed ✓ (live)` +
 * `nextAction: null` for code the :3070 release operator NEVER executes.
 *
 * That is not a cosmetic mislabel. On WI-6639 it produced a false "the fix is
 * live" conclusion — bg-host had been running 4h45m of PRE-FIX code while the
 * tool reported the change deployed — and only a behavioural measurement caught
 * it. CLAUDE.md tells agents to trust `blockedOn`/`nextAction` over the position
 * ticks, so these are precisely the fields that must not lie.
 *
 * Enumerating the sweeps by hand fixes today's list and rots on the next one, so
 * this test RE-DERIVES the set from the real dispatcher on every run. Adding sweep
 * #25 without a runtime-ownership rule fails HERE — loudly, at the seam — instead
 * of silently mis-routing someone's activation decision hours later.
 */

const REPO_ROOT = resolve(__dirname, '../../..');
const WORKFLOW = 'packages/operator-core/lib/dbos/routines-workflow.ts';

/**
 * Modules dispatched by routinesTick that are deliberately NOT classified bg-host.
 * SHRINK-TO-EMPTY: only a module whose bg-host consumer is a negligible slice of a
 * broadly-shared surface belongs here. Adding an entry needs a stated reason.
 */
const NOT_BG_HOST_CLASSIFIED = new Map<string, string>([
  [
    'packages/operator-core/lib/agent-facts/store.ts',
    'The facts store has ~460 non-test importers and is overwhelmingly operator-served ' +
      '(facts:assert / facts:list / every orient fold). Only sweepExpiredFacts runs in bg-host, ' +
      'so a bg-host classification would mis-route the dominant caller. The shared-host caveat covers it.',
  ],
]);

/**
 * Every relative specifier `routines-workflow.ts` pulls in as WORK — i.e. the sweep
 * bodies routinesTick executes, not the plumbing it executes them with.
 *
 * The distinction is load-bearing. A first cut of this guard scanned ALL static
 * imports and demanded bg-host for `workspace-als`, `loopback-fetch`,
 * `workspace-registry` and `operator-api-base` — generic helpers imported all over
 * the operator, for which a bg-host classification would be actively WRONG (it would
 * tell an agent editing a shared helper that a deploy cannot activate their change,
 * when for the dominant caller it is exactly what does). So:
 *   - dynamic `await import(...)` — the dispatch idiom, always a sweep body;
 *   - static imports ONLY from `harness/routines/`, which is routine-execution code
 *     by construction.
 */
function dispatchedModuleSpecifiers(source: string): string[] {
  const found = new Set<string>();
  for (const m of source.matchAll(/\bimport\(\s*['"](\.[^'"]+)['"]\s*\)/g)) found.add(m[1]);
  for (const m of source.matchAll(/^\s*import\s[^;]*?\sfrom\s+['"](\.[^'"]+)['"]/gm)) {
    if (m[1].includes('harness/routines/')) found.add(m[1]);
  }
  return [...found];
}

/** Resolve a specifier relative to the workflow file into a repo-relative .ts path. */
function toRepoRelative(spec: string): string | null {
  const abs = resolve(REPO_ROOT, dirname(WORKFLOW), spec);
  const rel = relative(REPO_ROOT, abs);
  for (const candidate of [`${rel}.ts`, `${rel}/index.ts`]) {
    try {
      readFileSync(resolve(REPO_ROOT, candidate));
      return candidate;
    } catch {
      /* not this shape */
    }
  }
  return null;
}

describe('WI-6659: routinesTick-dispatched modules are classified bg-host', () => {
  const source = readFileSync(resolve(REPO_ROOT, WORKFLOW), 'utf8');

  it('finds the dispatcher and a plausible number of dispatched modules', () => {
    // Guards the guard: if the dispatch idiom is refactored away, the matcher would
    // silently find nothing and every assertion below would vacuously pass.
    const specs = dispatchedModuleSpecifiers(source);
    expect(specs.length).toBeGreaterThan(15);
  });

  it('classifies every dispatched module as bg-host (or explicitly allowlists it)', () => {
    const specs = dispatchedModuleSpecifiers(source);
    const resolved = specs.map(toRepoRelative).filter((p): p is string => p !== null);
    expect(resolved.length).toBeGreaterThan(15);

    const misrouted: string[] = [];
    for (const path of resolved) {
      if (NOT_BG_HOST_CLASSIFIED.has(path)) continue;
      const owners = classifyRuntimeOwners(path) ?? [];
      if (!owners.some((o) => o.host === 'bg-host')) misrouted.push(path);
    }

    expect(
      misrouted,
      `These modules are dispatched by routinesTickImpl (bg-host only) but classifyRuntimeOwners does ` +
        `not report a bg-host runtime for them, so dev:pipeline_position will tell an agent the ` +
        `deploy made their edit live when it cannot. Add a RUNTIME_OWNERS rule in ` +
        `git-pipeline-position.ts (single 'own' if bg-host-only, or the WI-5440 plural form if the ` +
        `module also has an operator-served consumer) — or, with a stated reason, an entry in ` +
        `NOT_BG_HOST_CLASSIFIED.\n  ${misrouted.join('\n  ')}`,
    ).toEqual([]);
  });

  it('reports a bg-host activation lever, not a deploy, for a bg-host-only sweep', () => {
    // The regression that started WI-6659, pinned end-to-end.
    const owners = classifyRuntimeOwners(
      'packages/operator-core/lib/harness/routines/reconcile-loop-routines.ts',
    );
    expect(owners).not.toBeNull();
    expect(owners).toHaveLength(1);
    expect(owners![0].host).toBe('bg-host');
    expect(owners![0].releasePipelineApplies).toBe(false);
    expect(owners![0].restartTarget).toBe('bg-host');
  });

  it('keeps BOTH routes for a dual-consumer sweep', () => {
    // pot/watchdog is swept by routinesTick AND read by operator-served surfaces.
    // Collapsing it either way sends half the callers to the wrong lever (WI-5440).
    const owners = classifyRuntimeOwners('packages/operator-core/lib/pot/watchdog.ts') ?? [];
    expect(owners.map((o) => o.host)).toEqual(['bg-host', 'operator-release']);
    expect(owners.find((o) => o.host === 'bg-host')!.restartTarget).toBe('bg-host');
    expect(owners.find((o) => o.host === 'operator-release')!.releasePipelineApplies).toBe(true);
  });

  it('leaves an ordinary operator-served path on the release pipeline', () => {
    // The new rules must not over-reach into unrelated operator-core code.
    const owners = classifyRuntimeOwners('packages/operator-core/lib/git-pipeline-position.ts') ?? [];
    expect(owners).toHaveLength(1);
    expect(owners[0].host).toBe('operator-release');
    expect(owners[0].releasePipelineApplies).toBe(true);
  });
});
