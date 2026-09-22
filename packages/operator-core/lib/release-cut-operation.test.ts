/**
 * release-cut-operation.test.ts — managed-release identity + restart discovery for the
 * MANUAL cut path (desktop-release-incremental-resume-2026-09-21 P-001).
 *
 * Same discipline as release-cut-launch.test.ts: no real cut, no fs, no database. Every
 * branch runs through injected deps, so a green run here is a claim about the LOGIC and
 * never about a build that did not happen.
 *
 * Run: cd packages/operator-core && npx vitest run lib/release-cut-operation.test.ts
 */
import { describe, expect, it } from 'vitest';

import {
  beginCutOperation,
  buildCutJournalSeed,
  classifyCutOperation,
  cutBuildStage,
  cutOperationIdentityFromTask,
  discoverCutOperations,
  CUT_ARTIFACT_KIND,
  CUT_OPERATION_LAUNCHED_BY,
  type BeginCutOperationDeps,
  type CutOperationIdentity,
  type DiscoverCutOperationsDeps,
} from './release-cut-operation';
import type { CutStatus, Platform } from './release-cut-launch';
import type { TaskRow } from './task-manager/types';

const SHA = 'a'.repeat(40);

function identity(over: Partial<CutOperationIdentity> = {}): CutOperationIdentity {
  return {
    version: '0.0.22-alpha',
    channel: 'alpha',
    platform: 'linux',
    sourceSha: SHA,
    gitlinks: { 'papercusp-desktop': 'b'.repeat(40) },
    ...over,
  };
}

/** A CutStatus with the fields this module actually reads; the rest are inert. */
function status(over: Partial<CutStatus> = {}): CutStatus {
  return {
    state: 'idle',
    running: false,
    exitCode: null,
    logTail: null,
    logPath: '/tmp/x.log',
    donePath: '/tmp/x.done',
    operation: null,
    ...over,
  };
}

function marker(operationId: string | null, taskId: string | null = 'task1') {
  return { operationId, taskId, startedAtSec: 1_700_000_000 };
}

describe('buildCutJournalSeed', () => {
  it('produces the seed shape the shell journal adapter CAS-appends against', () => {
    const seed = buildCutJournalSeed('op-1', identity());
    expect(seed.schemaVersion).toBe(1);
    expect(seed.operationId).toBe('op-1');
    expect(seed.cursor).toBe(0);
    expect(seed.currentStage).toBeNull();
    expect(seed.currentState).toBeNull();
    expect(seed.receipts).toEqual([]);
    expect(seed.spentOperationIds).toEqual([]);
    expect(seed.source).toEqual({ sha: SHA, gitlinks: { 'papercusp-desktop': 'b'.repeat(40) } });
    expect(seed.artifactIdentity).toEqual({
      kind: CUT_ARTIFACT_KIND,
      channel: 'alpha',
      platform: 'linux',
      sourceSha: SHA,
      version: '0.0.22-alpha',
    });
  });

  it('carries the credential binding so a resume can refuse an expired one', () => {
    const seed = buildCutJournalSeed('op-1', identity(), { generation: 'g7', expiresAt: '2026-01-01T00:00:00Z' });
    expect(seed.credential).toEqual({ generation: 'g7', expiresAt: '2026-01-01T00:00:00Z' });
  });

  it('defaults an absent credential to explicit nulls rather than undefined', () => {
    expect(buildCutJournalSeed('op-1', identity()).credential).toEqual({ generation: null, expiresAt: null });
  });

  it('PLATFORM is part of the artifact identity — a mac leg can never reuse a linux receipt', () => {
    const linux = buildCutJournalSeed('op-1', identity({ platform: 'linux' }));
    const mac = buildCutJournalSeed('op-1', identity({ platform: 'mac' }));
    expect(linux.artifactIdentity).not.toEqual(mac.artifactIdentity);
    expect(mac.artifactIdentity.platform).toBe('mac');
  });
});

describe('cutBuildStage', () => {
  it('matches the stage name release-local.sh journals a leg under', () => {
    expect(cutBuildStage('linux')).toBe('release.build.linux');
    expect(cutBuildStage('windows')).toBe('release.build.windows');
  });

  it('maps the legacy whole-cut unit onto its linux build leg', () => {
    expect(cutBuildStage(null)).toBe('release.build.linux');
  });
});

describe('beginCutOperation', () => {
  function captureRegister() {
    const calls: Array<{ spec: Record<string, unknown>; opts: Record<string, unknown> }> = [];
    const registerTask = (async (spec: unknown, opts: unknown) => {
      calls.push({ spec: spec as Record<string, unknown>, opts: (opts ?? {}) as Record<string, unknown> });
      return {} as TaskRow;
    }) as unknown as BeginCutOperationDeps['registerTask'];
    return { calls, registerTask };
  }

  it('persists source/version/platform identity on the ledger row before the cut is launched', async () => {
    const { calls, registerTask } = captureRegister();
    const result = await beginCutOperation(
      { identity: identity(), cwd: '/tmp/desktop' },
      { registerTask, newTaskId: () => 'task1', newOperationId: () => 'op-1' },
    );

    expect(result).toMatchObject({ taskId: 'task1', operationId: 'op-1', unit: 'papercup-release-cut-linux' });
    expect(calls).toHaveLength(1);
    const detail = calls[0].spec.detail as Record<string, unknown>;
    expect(calls[0].spec.launchedBy).toBe(CUT_OPERATION_LAUNCHED_BY);
    expect(calls[0].spec.class).toBe('deploy');
    expect(calls[0].spec.cwd).toBe('/tmp/desktop');
    expect(calls[0].opts.taskId).toBe('task1');
    expect(detail).toMatchObject({
      channel: 'alpha',
      version: '0.0.22-alpha',
      platform: 'linux',
      sourceSha: SHA,
      cutUnit: 'papercup-release-cut-linux',
    });
    expect((detail.release as { operationId: string }).operationId).toBe('op-1');
  });

  it('records the legacy whole-cut unit for a platform-less operation', async () => {
    const { calls, registerTask } = captureRegister();
    const result = await beginCutOperation(
      { identity: identity({ platform: null }) },
      { registerTask, newTaskId: () => 'task1', newOperationId: () => 'op-1' },
    );
    expect(result.unit).toBe('papercup-release-cut');
    expect((calls[0].spec.detail as Record<string, unknown>).platform).toBeNull();
  });

  it('mints distinct ids when none are supplied', async () => {
    const { registerTask } = captureRegister();
    const a = await beginCutOperation({ identity: identity() }, { registerTask });
    const b = await beginCutOperation({ identity: identity() }, { registerTask });
    expect(a.operationId).not.toBe(b.operationId);
    expect(a.taskId).not.toBe(b.taskId);
  });
});

describe('classifyCutOperation', () => {
  it('reports an active unit as running', () => {
    const r = classifyCutOperation('op-1', status({ state: 'running', running: true, operation: marker('op-1') }));
    expect(r).toMatchObject({ disposition: 'running', resumable: false });
  });

  it('reports a matching DONE:0 sentinel as complete', () => {
    const r = classifyCutOperation('op-1', status({ state: 'done', exitCode: 0, operation: marker('op-1') }));
    expect(r).toMatchObject({ disposition: 'complete', resumable: false });
  });

  it('reports a matching non-zero sentinel as failed, and names the exit code', () => {
    const r = classifyCutOperation('op-1', status({ state: 'failed', exitCode: 3, operation: marker('op-1') }));
    expect(r.disposition).toBe('failed');
    expect(r.reason).toContain('3');
  });

  it('reports a started-but-abandoned cut as interrupted, and RESUMABLE — the P-001 case', () => {
    const r = classifyCutOperation('op-1', status({ state: 'interrupted', operation: marker('op-1') }));
    expect(r).toMatchObject({ disposition: 'interrupted', resumable: true });
  });

  it('REFUSES to claim a newer cut’s success: a foreign marker is superseded, not complete', () => {
    // The regression this identity exists to prevent. The sentinels are per-platform and
    // shared, so without the id check this exact input reads as a clean `complete` for an
    // operation that never finished.
    const r = classifyCutOperation(
      'op-1',
      status({ state: 'done', exitCode: 0, operation: marker('op-2') }),
    );
    expect(r.disposition).toBe('superseded');
    expect(r.resumable).toBe(false);
    expect(r.reason).toContain('op-2');
  });

  it('treats an unidentified marker (unmanaged / pre-P-001 launch) as unknown, never as its own', () => {
    const r = classifyCutOperation('op-1', status({ state: 'done', exitCode: 0, operation: marker(null) }));
    expect(r).toMatchObject({ disposition: 'unknown', resumable: false });
  });

  it('treats a missing marker as unknown rather than idle-and-therefore-fine', () => {
    const r = classifyCutOperation('op-1', status({ state: 'idle', operation: null }));
    expect(r).toMatchObject({ disposition: 'unknown', resumable: false });
  });
});

describe('cutOperationIdentityFromTask', () => {
  function taskRow(detail: Record<string, unknown>): TaskRow {
    return { taskId: 'task1', state: 'running', detail } as unknown as TaskRow;
  }

  it('recovers the persisted identity after a restart, when only the ledger row survives', () => {
    const seed = buildCutJournalSeed('op-1', identity({ platform: 'windows' }));
    const resolved = cutOperationIdentityFromTask(taskRow({ release: seed }));
    expect(resolved?.identity).toEqual({
      version: '0.0.22-alpha',
      channel: 'alpha',
      platform: 'windows',
      sourceSha: SHA,
      gitlinks: { 'papercusp-desktop': 'b'.repeat(40) },
    });
    expect(resolved?.journal.operationId).toBe('op-1');
  });

  it('returns null for a task row that is not a managed cut, instead of throwing mid-sweep', () => {
    expect(cutOperationIdentityFromTask(taskRow({}))).toBeNull();
    expect(cutOperationIdentityFromTask(taskRow({ release: { schemaVersion: 1 } }))).toBeNull();
  });

  it('normalises an unrecognised platform to null rather than trusting the stored string', () => {
    const seed = buildCutJournalSeed('op-1', identity());
    (seed.artifactIdentity as { platform: unknown }).platform = 'solaris';
    expect(cutOperationIdentityFromTask(taskRow({ release: seed }))?.identity.platform).toBeNull();
  });
});

describe('discoverCutOperations', () => {
  it('enumerates in-flight manual cuts and reconciles each against ITS OWN platform sentinels', async () => {
    const linuxSeed = buildCutJournalSeed('op-linux', identity({ platform: 'linux' }));
    const macSeed = buildCutJournalSeed('op-mac', identity({ platform: 'mac' }));
    linuxSeed.currentStage = 'release.build.linux' as never;

    const listTasks = (async () => [
      { taskId: 'task-linux', state: 'running', detail: { release: linuxSeed } },
      { taskId: 'task-mac', state: 'running', detail: { release: macSeed } },
      // A non-cut row sharing the launcher must not be adopted.
      { taskId: 'task-other', state: 'running', detail: {} },
    ]) as unknown as DiscoverCutOperationsDeps['listTasks'];

    const seen: Array<Platform | undefined> = [];
    const readStatus = (platform: Platform | undefined) => {
      seen.push(platform);
      return platform === 'linux'
        ? status({ state: 'interrupted', operation: marker('op-linux', 'task-linux') })
        : status({ state: 'running', running: true, operation: marker('op-mac', 'task-mac') });
    };

    const found = await discoverCutOperations({ listTasks, readStatus });

    expect(seen).toEqual(['linux', 'mac']);
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({
      taskId: 'task-linux',
      operationId: 'op-linux',
      unit: 'papercup-release-cut-linux',
      currentStage: 'release.build.linux',
      receiptCount: 0,
    });
    expect(found[0].reconciliation).toMatchObject({ disposition: 'interrupted', resumable: true });
    expect(found[1].reconciliation.disposition).toBe('running');
  });

  it('scopes the ledger query to manual cut operations only', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const listTasks = (async (filter: unknown) => {
      calls.push(filter as Record<string, unknown>);
      return [];
    }) as unknown as DiscoverCutOperationsDeps['listTasks'];

    await discoverCutOperations({ listTasks, readStatus: () => status() });
    // Not `includeEnded`: the non-terminal rows ARE the in-flight set.
    expect(calls[0]).toEqual({
      workspaceId: undefined,
      launchedBy: CUT_OPERATION_LAUNCHED_BY,
      classes: ['deploy'],
    });
  });
});
