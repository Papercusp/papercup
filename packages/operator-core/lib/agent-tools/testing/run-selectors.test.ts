import { describe, expect, it } from 'vitest';

import runTool, { emptyDistilledRunRefusal } from './run';

/**
 * `files` became OPTIONAL when `changedPaths` was added, which made `testing:run {}`
 * expressible for the first time. That is the dangerous shape: this tool's entire
 * reason for existing is refusing runs that measure nothing and exit 0, so a missing
 * selector must REFUSE rather than default to anything.
 *
 * Both refusals happen before any root resolution or spawn, so a bare ctx is enough —
 * and if that ever stops being true, these tests fail loudly instead of silently
 * shelling out from a test process.
 */
const bareCtx = {} as unknown as Parameters<typeof runTool.handler>[1];

async function callHandler(args: unknown) {
  const result = await runTool.handler(args as Parameters<typeof runTool.handler>[0], bareCtx);
  return (result as { data: Record<string, unknown> }).data;
}

describe('testing:run selector arbitration', () => {
  const emptyRun = {
    passed: 0,
    failed: 0,
    skipped: 0,
    files: 0,
    failures: [],
    failuresTruncated: false,
    durationMs: null,
    byFile: {},
  };

  it('refuses an empty external Vitest report instead of returning an ambiguous all-zero verdict', () => {
    expect(
      emptyDistilledRunRefusal({
        runs: [emptyRun],
        runId: 'run-empty-report',
        root: '/portal',
        routerOutput: 'vitest exited 1 after writing an empty report',
      }),
    ).toMatchObject({ ok: false, error: 'no_report', runId: 'run-empty-report', root: '/portal' });
  });

  it('refuses a mixed report set when any workspace group produced no files', () => {
    const measuredRun = { ...emptyRun, passed: 1, files: 1, byFile: { 'one.test.ts': { passed: 1, failed: 0, skipped: 0, collectionFailed: false } } };
    expect(
      emptyDistilledRunRefusal({
        runs: [measuredRun, emptyRun],
        runId: 'run-mixed-report',
        root: '/papercusp',
        routerOutput: 'one group passed; one group wrote an empty report',
      }),
    ).toMatchObject({ ok: false, error: 'no_report' });
  });

  it('keeps evidence recovery exclusive from starting another test process', async () => {
    const recoverEvidence = { workItemId: 'WI-1', originRunId: 'f04cdb70-ad2d-4757-9ff0-3a3d9f4440ad',
      runId: 'f04cdb70-ad2d-4757-9ff0-3a3d9f4440ad' };
    expect(runTool.args.safeParse({ recoverEvidence }).success).toBe(true);
    const data = await callHandler({ files: ['a.test.ts'], recoverEvidence });
    expect(data.error).toBe('mutually_exclusive_selectors');
  });

  it('does not claim evidence from an affected-test plan that runs nothing', async () => {
    const data = await callHandler({ changedPaths: ['src/a.ts'], evidence: { workItemId: 'WI-1', bindings: [] } });
    expect(data.error).toBe('evidence_requires_executed_files');
  });

  it('refuses a call with NEITHER selector instead of defaulting', async () => {
    const data = await callHandler({});
    expect(data.ok).toBe(false);
    expect(data.error).toBe('no_selector');
  });

  it('refuses a call with BOTH selectors instead of silently preferring one', async () => {
    // Preferring `files` here would quietly ignore a radius the caller asked to see.
    const data = await callHandler({ files: ['a.test.ts'], changedPaths: ['src/a.ts'] });
    expect(data.ok).toBe(false);
    expect(data.error).toBe('mutually_exclusive_selectors');
  });

  it('still accepts each selector on its own at the schema level', () => {
    expect(runTool.args.safeParse({ files: ['a.test.ts'] }).success).toBe(true);
    expect(runTool.args.safeParse({ changedPaths: ['src/a.ts'] }).success).toBe(true);
    // Empty arrays stay rejected by the schema — an empty selector is the same
    // measure-nothing hazard wearing a different hat.
    expect(runTool.args.safeParse({ files: [] }).success).toBe(false);
    expect(runTool.args.safeParse({ changedPaths: [] }).success).toBe(false);
  });
});
