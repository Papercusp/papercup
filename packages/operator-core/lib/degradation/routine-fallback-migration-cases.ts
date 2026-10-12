/** P-009 producer proof at real dependency seams; reuses the existing entrypoint AST runner. */
import ts from 'typescript';
import { execute, original, source } from './host-startup-migration-cases';
import type { RailMigrationCase } from './rail-migration-cases';

type Observation = { eligible: number; applied: number; reason: string; scope?: string | null };
const prefix = 'packages/operator-core/lib/';
function variable(path: string, name: string, marker = ''): ts.VariableDeclaration {
  const file = source(path);
  let found: ts.VariableDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
      && node.name.text === name && node.getText(file).includes(marker)) found = node;
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (!found) throw new Error(`missing original variable ${path}: ${name}`);
  return found;
}
function statementRange(path: string, start: string, end: string): string {
  const file = source(path);
  let found: ts.NodeArray<ts.Statement> | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isBlock(node) && node.statements.some((s) => s.getText(file).startsWith(start))
      && node.statements.some((s) => s.getText(file).startsWith(end))) found = node.statements;
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (!found) throw new Error(`missing original statement range ${path}`);
  const first = found.findIndex((s) => s.getText(file).startsWith(start));
  const last = found.findIndex((s) => s.getText(file).startsWith(end));
  return found.slice(first, last).map((s) => s.getText(file)).join('\n');
}
function row(path: string, enclosing: string, ordinal = 1): string {
  return `log-only-fallback|${prefix}${path}|${enclosing}|${ordinal}`;
}
async function measured(
  mechanism: string, scope: string,
  run: (observe: (name: string, observation: Observation) => boolean) => Promise<void>,
): Promise<{ route: 'observation'; mechanism: string; observations: Observation[] }> {
  const { expect } = await import('vitest');
  const observations: Observation[] = [];
  await run((name, observation) => {
    expect(name).toBe(mechanism); expect(observation.scope).toBe(scope);
    observations.push(observation); return true;
  });
  expect(observations.some((o) => o.eligible === 1 && o.applied === 0)).toBe(true);
  expect(observations.some((o) => o.eligible === 1 && o.applied === 1 && o.reason === 'applied')).toBe(true);
  return { route: 'observation', mechanism, observations };
}

export const ROUTINE_FALLBACK_MIGRATION_CASES: RailMigrationCase[] = [{
  id: 'loop-arm-prior-facts-read-error-and-primary', item: 'P-009', route: 'observation',
  mechanism: 'routine-capability-read', rowIds: [row('agent-tools/loop/arm.ts', 'handler')],
  run: () => measured('routine-capability-read', 'loop-prior-facts', async (observeFallback) => {
    const text = original(prefix + 'agent-tools/loop/arm.ts', 'prior-loop read failed', 'try');
    for (const fail of [true, false]) await execute(text, { observeFallback, ownerId: 'fixture', prior: null,
      measure: (_label: string, work: () => Promise<unknown>) => work(),
      readActiveLoopFacts: async () => { if (fail) throw new Error('read failed'); return null; } });
  }),
}, {
  id: 'loop-checkpoint-scope-probe-error-and-primary', item: 'P-009', route: 'observation',
  mechanism: 'routine-capability-read', rowIds: [row('agent-tools/loop/checkpoint.ts', 'handler')],
  run: () => measured('routine-capability-read', 'loop-checkpoint-scope', async (observeFallback) => {
    const text = statementRange(prefix + 'agent-tools/loop/checkpoint.ts', 'const routineProbe =', 'const activeRoutine =');
    const { withBoundedTimeout } = await import('../bounded-timeout');
    for (const fail of [true, false]) await execute(text, { observeFallback, withBoundedTimeout,
      ownerId: 'fixture', CONTINUATION_READ_BUDGET_MS: 1000, routineProbeFailed: false,
      getLoopStatus: async () => { if (fail) throw new Error('read failed'); return { active: false }; } });
  }),
}, {
  id: 'dbos-lifecycle-grant-failed-and-verified-primary', item: 'P-009', route: 'observation',
  mechanism: 'routine-capability-read', rowIds: [row('dbos/bootstrap.ts', 'startDbosOnce')],
  run: () => measured('routine-capability-read', 'dbos-lifecycle-read-grant', async (observeFallback) => {
    const text = original(prefix + 'dbos/bootstrap.ts', 'await grantDbosWorkflowStatusRead()', 'expression');
    for (const fail of [true, false]) await execute(text, { observeFallback,
      grantDbosWorkflowStatusRead: async () => { if (fail) throw new Error('grant denied'); } });
  }),
}, {
  id: 'dbos-reaper-invalid-and-unsafe-override-valid-primary-and-absent-exclusion', item: 'P-009', route: 'observation',
  mechanism: 'routine-config', rowIds: [row('dbos/dbos-executor-reaper.ts', '<module>', 1), row('dbos/dbos-executor-reaper.ts', '<module>', 2)],
  run: () => measured('routine-config', 'reaper-fire-window', async (observeFallback) => {
    const { expect } = await import('vitest');
    const value = variable(prefix + 'dbos/dbos-executor-reaper.ts', 'STALE_ROUTINE_FIRE_NO_OUTPUT_MS').initializer!;
    const text = `const result = ${value.getText()}; return result;`;
    const floor = 180 * 60_000, ceiling = 190 * 60_000, fallback = 185 * 60_000;
    let decisions = 0;
    const record = (name: string, observation: Observation) => { decisions++; return observeFallback(name, observation); };
    for (const raw of ['bad', '0', String(floor), String(ceiling), String(fallback), undefined, '']) {
      const result = await execute(text, { observeFallback: record, process: { env: { PAPERCUSP_DBOS_REAPER_FIRE_NO_OUTPUT_MS: raw } },
        NO_OUTPUT_OVERRIDE_FLOOR_MS: floor, NO_OUTPUT_OVERRIDE_CEILING_MS: ceiling,
        DEFAULT_STALE_ROUTINE_FIRE_NO_OUTPUT_MS: fallback });
      expect(result).toBe(fallback);
    }
    expect(decisions).toBe(5); // Neither absent nor empty overrides claim a primary measurement.
  }),
}, {
  id: 'gitnexus-output-log-fallback-and-opened-primary', item: 'P-009', route: 'observation',
  mechanism: 'routine-output-log', rowIds: [row('harness/routines/gitnexus-reindex-action.ts', 'openAnalyzeLog')],
  run: () => measured('routine-output-log', 'gitnexus-analyze', async (observeFallback) => {
    const { expect } = await import('vitest');
    const text = original(prefix + 'harness/routines/gitnexus-reindex-action.ts', 'function openAnalyzeLog(', 'function');
    for (const fail of [true, false]) {
      const open = execute(text, { observeFallback, path: { dirname: () => '/fixture' },
        mkdirSync() {}, pruneAnalyzeLogs() {}, GITNEXUS_ANALYZE_LOGS_KEPT: 5,
        openSync: () => { if (fail) throw new Error('cannot open'); return 42; } }, 'openAnalyzeLog') as (path: string) => number | null;
      expect(open('/fixture/analyze.log')).toBe(fail ? null : 42);
    }
  }),
}, {
  id: 'silent-halt-wake-markers-page-fallback-and-verified-read', item: 'P-009', route: 'observation',
  mechanism: 'routine-capability-read', rowIds: [row('harness/routines/silent-halt-reconcile.ts', 'sweepSilentHalts')],
  run: () => measured('routine-capability-read', 'silent-halt-wake-markers', async (observeFallback) => {
    const text = original(prefix + 'harness/routines/silent-halt-reconcile.ts', 'markers = await readMarkers(', 'try');
    for (const fail of [true, false]) await execute(text, { observeFallback, markers: null, nowMs: 1_000_000, lookbackMs: 1000,
      readMarkers: async () => { if (fail) throw new Error('unreadable'); return []; } });
  }),
}, {
  id: 'loop-terminal-guard-fail-soft-and-verified-capability', item: 'P-009', route: 'observation',
  mechanism: 'routine-capability-read', rowIds: [row('harness/routines/reconcile-loop-routines.ts', 'reconcileLoopRoutines')],
  run: () => measured('routine-capability-read', 'loop-terminal-guard', async (observeFallback) => {
    const { expect } = await import('vitest');
    const declaration = variable(prefix + 'harness/routines/reconcile-loop-routines.ts', 'guard', 'checkUnreachableTerminalGuard');
    const text = `const ${declaration.getText()}; return guard;`;
    for (const fail of [true, false]) {
      const result = await execute(text, { observeFallback, db: {}, row: { id: 'fixture', target_owner_id: 'fixture' },
        nowMs: 10_000, lastFiredMs: 1, intervalMs: 1000, stuckFireCount: 4, circuitOpen: false,
        checkUnreachableTerminalGuard: async () => { if (fail) throw new Error('read failed'); return { breach: true }; } });
      expect(result).toEqual({ breach: !fail });
    }
  }),
}, {
  id: 'routine-dispatch-derivation-unreadable-incomplete-primary-and-cache-exclusion', item: 'P-009', route: 'observation',
  mechanism: 'routine-capability-read', rowIds: [row('routines-dispatch-derivation.ts', 'dispatchedSweepMatcher')],
  run: () => measured('routine-capability-read', 'dispatch-derivation', async (observeFallback) => {
    const { expect } = await import('vitest');
    const text = original(prefix + 'routines-dispatch-derivation.ts', 'function dispatchedSweepMatcher()', 'function');
    for (const outcome of ['error', 'incomplete', 'primary']) {
      let reads = 0;
      const match = execute(text, { observeFallback, cached: null, NEVER: /(?!)/, WORKFLOW_REL: 'fixture',
        escapeRe: (s: string) => s,
        dispatchedSweepPaths: () => { reads++; if (outcome === 'error') throw new Error('unreadable');
          return outcome === 'incomplete' ? [] : Array.from({ length: 10 }, (_, i) => `path${i}`); },
      }, 'dispatchedSweepMatcher') as () => RegExp;
      expect(match().test('path0')).toBe(outcome === 'primary');
      expect(match().test('path0')).toBe(outcome === 'primary');
      expect(reads).toBe(1);
    }
  }),
}];
