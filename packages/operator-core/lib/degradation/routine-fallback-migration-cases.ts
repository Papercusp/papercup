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
    const { expect, vi } = await import('vitest');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const fail of [true, false]) await execute(text, { observeFallback, withBoundedTimeout,
        ownerId: 'fixture', CONTINUATION_READ_BUDGET_MS: 1000, routineProbeFailed: false,
        getLoopStatus: async () => { if (fail) throw new Error('read failed'); return { active: false }; } });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('armed-routine scope probe failed: read failed'));
    } finally { warn.mockRestore(); }
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
}, {
  id: 'release-request-lock-release-error-primary-and-skipped-exclusion', item: 'P-009', route: 'observation',
  mechanism: 'routine-capability-read', rowIds: [row('dbos/in-process-periodic.ts', 'tick')],
  run: () => measured('routine-capability-read', 'release-request-locks', async (observeFallback) => {
    const { expect } = await import('vitest');
    const text = statementRange(prefix + 'dbos/in-process-periodic.ts', 'const lockRelease =', 'const reclaimHolder =');
    let decisions = 0;
    const record = (name: string, observation: Observation) => { decisions++; return observeFallback(name, observation); };
    for (const result of [{ failures: 1, skipped: null }, { failures: 0, skipped: null },
      { failures: 0, skipped: 'missing-owner' }, { failures: 0, skipped: 'no-paths' }]) {
      await execute(text, { observeFallback: record, row: { id: 'fixture', holderNow: 'fixture', paths: [] },
        resolved: { holder: 'fixture' }, releaseReclaimedWorkItemLocks: async () => result });
    }
    expect(decisions).toBe(2);
  }),
}, {
  id: 'smoke-test-persisted-failure-repeat-pass-and-write-failure', item: 'P-009', route: 'condition',
  rowIds: [`owner-only-alarm|${prefix}endpoint-route/routes/internal/smoke-test-event.ts|handler|1`],
  run: async () => {
    const { expect } = await import('vitest');
    const { z } = await import('zod');
    const path = prefix + 'endpoint-route/routes/internal/smoke-test-event.ts';
    const file = source(path);
    let handler: ts.MethodDeclaration | undefined;
    const visit = (node: ts.Node): void => {
      if (ts.isMethodDeclaration(node) && node.name.getText(file) === 'handler') handler = node;
      ts.forEachChild(node, visit);
    };
    visit(file);
    if (!handler) throw new Error('missing original smoke event handler');
    const BodySchema = await execute(`return ${variable(path, 'BodySchema').initializer!.getText(file)};`, { z });
    const open = new Set<string>(), openedKeys: string[] = [], resolvedKeys: string[] = [];
    let status = 'fail', priorStatus: string | undefined, writeFails = false, notifications = 0, attempts = 0;
    const db = {
      select: (fields: Record<string, string>) => ({ from: () => ({ where: () => ({ limit: async () =>
        'harness_slug' in fields ? [{ harness_slug: 'fixture' }] : priorStatus ? [{ status: priorStatus }] : [] }) }) }),
      insert: () => ({ values: () => ({ onConflictDoUpdate: async () => {
        if (writeFails) throw new Error('persist unavailable'); priorStatus = status;
      } }) }),
    };
    const run = await execute(`return {${handler.getText(file)}}.handler;`, {
      BodySchema, Response, getOrgPg: () => ({ db }), ti: { token: 'token', harnessSlug: 'slug' }, hs: {},
      eq: () => true, dsql: () => null, activeWorkspaceId: () => 'fixture-workspace',
      notifySyncInvalidate: async () => {}, notifyAttention: async () => { notifications++; },
      broadcastSevereEvent: async ({ conditionKey }: { conditionKey: string }) => {
        attempts++; if (!open.has(conditionKey)) openedKeys.push(conditionKey); open.add(conditionKey); return true;
      },
      resolveAlarm: async (key: string) => { if (open.delete(key)) resolvedKeys.push(key); return true; },
    }) as (req: Request) => Promise<Response>;
    const request = () => new Request('http://fixture/internal/smoke-test-event', {
      method: 'POST', headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    expect((await run(request())).status).toBe(200);
    expect((await run(request())).status).toBe(200);
    expect(attempts).toBe(2); expect(notifications).toBe(1);
    status = 'pass'; writeFails = true;
    await expect(run(request())).rejects.toThrow('persist unavailable');
    expect(resolvedKeys).toEqual([]);
    writeFails = false;
    expect((await run(request())).status).toBe(200);
    expect(openedKeys).toEqual(['alarm:smoke-test:fixture']);
    expect(resolvedKeys).toEqual(openedKeys);
    return { route: 'condition', openedKeys, resolvedKeys };
  },
}, {
  id: 'loop-dead-man-original-owner-page-rail-rearm-and-unreadable-preservation', item: 'P-009', route: 'condition',
  rowIds: [`owner-only-alarm|${prefix}harness/routines/loop-dead-man.ts|checkLoopDeadMan|1`],
  run: async () => {
    const { expect, vi } = await import('vitest');
    const producer = await import('../harness/routines/loop-dead-man');
    const attention = await import('../attention-notify');
    const open = new Set<string>(), openedKeys: string[] = [], resolvedKeys: string[] = [];
    let row = { armed_ms: 1000, fire_count: 5, fire_count_at_arm: 0, target_owner_id: 'fixture', workspace_id: 'fixture' };
    let readFails = false, pageFails = true;
    const sql = async () => { if (readFails) throw new Error('read unavailable'); return [row]; };
    const deps: import('../harness/routines/loop-dead-man').LoopDeadManDeps = {
      autoPause: async () => {}, getModes: async () => [{ mode: 'auto' } as never],
      broadcast: async ({ conditionKey, oneShot }) => {
        expect(oneShot).toBe(true); if (!open.has(conditionKey!)) openedKeys.push(conditionKey!);
        open.add(conditionKey!); return true;
      },
      resolve: async ({ conditionKey }) => { if (open.delete(conditionKey)) resolvedKeys.push(conditionKey); return true; },
    };
    const page = vi.spyOn(attention, 'notifyAttention').mockImplementation(async () => {
      if (pageFails) throw new Error('page unavailable');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const input = { sql: sql as never, routineId: 'fixture', maxFires: 5, nowMs: 10_000 };
      expect((await producer.checkLoopDeadMan(input, deps)).escalated).toBe(false);
      expect(openedKeys).toEqual(['alarm:loop-dead-man:fixture']);
      expect(page).toHaveBeenCalledOnce();
      readFails = true;
      await expect(producer.checkLoopDeadMan(input, deps)).rejects.toThrow('read unavailable');
      expect(resolvedKeys).toEqual([]);
      readFails = false; row = { ...row, armed_ms: Number.NaN, fire_count: 0 };
      await producer.checkLoopDeadMan(input, deps); expect(resolvedKeys).toEqual([]);
      pageFails = false; row = { ...row, armed_ms: 9000, fire_count: 5, fire_count_at_arm: 5 };
      expect((await producer.checkLoopDeadMan(input, deps)).breach).toBe(false);
      expect(resolvedKeys).toEqual(openedKeys);
      return { route: 'condition', openedKeys, resolvedKeys };
    } finally { warn.mockRestore(); page.mockRestore(); }
  },
}, {
  id: 'routines-pool-critical-floor-and-ordinary-admission', item: 'P-009', route: 'observation',
  mechanism: 'routine-scheduler-admission', rowIds: [row('dbos/routines-workflow.ts', 'routinesTickImpl')],
  run: () => measured('routine-scheduler-admission', 'dispatch', async (observeFallback) => {
    const { expect } = await import('vitest');
    const text = statementRange(prefix + 'dbos/routines-workflow.ts', 'const pool =', 'const { sql } =');
    let shedRecords = 0;
    for (const pool of ['critical', 'warm', 'ok']) await execute(text, {
      observeFallback, poolPressure: async () => pool, lastPoolProbeMs: () => 100,
      recordPoolShed: () => 1, lastPoolProbeRawMs: () => 100, lastPoolProbeLoopDelayMs: () => 10,
      CRITICAL_PROBE_MS: 1000, activeWorkspaceId: () => 'fixture',
      recordPoolShedEvent: () => { shedRecords++; },
    });
    expect(shedRecords).toBe(1);
  }),
}];
