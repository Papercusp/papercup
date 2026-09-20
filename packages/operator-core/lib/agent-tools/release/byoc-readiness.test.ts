import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import tool, {
  probeByocPublication,
  evaluateByocReadiness,
  readByocReleaseSubject,
} from './byoc-readiness';
import type { ByocReleaseCarrySnapshot } from '../../byoc-release-carry';

function snapshot(
  overrides: Partial<ByocReleaseCarrySnapshot['milestoneProjection']> = {},
  artifactIdentity: unknown = { bundleSha256: 'bundle' },
): ByocReleaseCarrySnapshot {
  const keys = [
    ['build', 'build'],
    ['publication', 'publication'],
    ['root-bootstrap', 'root bootstrap'],
    ['fixed-agent-initialization', 'fixed-agent initialization'],
    ['customer-acceptance', 'customer acceptance'],
    ['soak-24h', '24-hour soak'],
    ['resource-census', 'resource census'],
    ['billing-closure', 'billing closure'],
    ['cleanup', 'cleanup'],
    ['shipment', 'shipment'],
  ] as const;
  const milestones = keys.map(([key, label]) => ({
    key,
    label,
    status: 'verified' as const,
    receiptState: 'committed' as const,
    receiptSequence: 1,
    evidenceRefs: [`evidence:${key}`],
  }));
  return {
    schemaVersion: 'byoc-release-carry-v1',
    taskId: 'task-1',
    workItemId: 'WI-10001532',
    operationId: 'op-1',
    cursor: 10,
    currentStage: 'release.shipment.green',
    currentState: 'committed',
    artifactIdentity,
    sourceIdentity: { sha: 'source' },
    credentialGeneration: 'cred-1',
    credentialExpiresAt: null,
    spentRequestIdentities: ['req-1'],
    evidenceRefs: milestones.flatMap((entry) => entry.evidenceRefs),
    milestoneProjection: {
      current: 'shipment',
      customerReady: true,
      shipped: true,
      milestones,
      contradictions: [],
      ...overrides,
    },
    nextAction: 'done',
    historyRef: 'task:task-1#release',
  };
}

describe('release:byoc_readiness', () => {
  it('does not treat receipt references or manifest declarations as executable archive proof', async () => {
    const bundleSha256 = 'a'.repeat(64);
    const manifestSha256 = 'b'.repeat(64);
    const manifest = JSON.stringify({
      schemaVersion: 1,
      kind: 'papercusp-workspace-host-release',
      artifact: { release: { bundleSha256 } },
      files: {
        bundle: { sha256: bundleSha256, sizeBytes: 10 },
        signature: { sha256: 'c'.repeat(64), sizeBytes: 5 },
      },
      trustReport: {},
    });
    const fetcher = vi.fn(async (url: string, init?: { method?: string }) => {
      if (init?.method === 'GET' && url.endsWith('/manifest.json')) {
        return {
          ok: true, status: 200,
          headers: { get: () => String(manifest.length) },
          arrayBuffer: async () => new TextEncoder().encode(manifest).buffer,
        };
      }
      if (init?.method === 'GET') {
        return {
          ok: true, status: 200,
          headers: { get: () => '10' },
          arrayBuffer: async () => new Uint8Array(10).buffer,
        };
      }
      return {
        ok: true, status: 200,
        headers: { get: (name: string) => name === 'content-length' ? (url.endsWith('server.tgz') ? '10' : '5') : null },
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    });
    const result = await probeByocPublication({ bundleSha256, manifestSha256 }, fetcher);
    expect(result.verdict).toBe('fail');
    expect(result.missing).toContain('executable-identity');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('fails closed when the public manifest digest differs from the receipt identity', async () => {
    const result = await probeByocPublication(
      { bundleSha256: 'a'.repeat(64), manifestSha256: 'b'.repeat(64) },
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: { get: () => '1' },
        arrayBuffer: async () => new TextEncoder().encode('{}').buffer,
      })),
    );
    expect(result.verdict).toBe('fail');
    expect(result.failed).toContain('manifest-archive-digest:mismatch');
  });

  it('cannot pass any BAR from committed receipts and evidence reference strings alone', () => {
    expect(evaluateByocReadiness('R-4', 'WI-10001532', [snapshot()], '2026-09-20T00:00:00.000Z')).toMatchObject({
      verdict: 'unknown',
      bar: 'R-4',
      artifactIdentityPresent: true,
      releaseTaskSelection: 'explicit',
      unverifiedEvidence: ['public-bytes', 'manifest-archive-digest', 'signature', 'sbom', 'executable-identity'],
    });
    expect(evaluateByocReadiness('R-5', 'WI-10001532', [snapshot()], '2026-09-20T00:00:00.000Z').verdict).toBe('unknown');
    expect(evaluateByocReadiness('R-6', 'WI-10001532', [snapshot()], '2026-09-20T00:00:00.000Z').verdict).toBe('unknown');
  });

  it('returns unknown for an absent or incomplete receipt chain, never a vacuous pass', () => {
    expect(evaluateByocReadiness('R-5', 'WI-10001532', [], '2026-09-20T00:00:00.000Z').verdict).toBe('unknown');
    const pending = snapshot({
      milestones: snapshot().milestoneProjection.milestones.map((entry) =>
        entry.key === 'customer-acceptance' ? { ...entry, status: 'pending' as const, receiptState: null, receiptSequence: null } : entry,
      ),
    });
    expect(evaluateByocReadiness('R-5', 'WI-10001532', [pending], '2026-09-20T00:00:00.000Z')).toMatchObject({
      verdict: 'unknown',
      missingMilestones: ['task-1:customer-acceptance'],
    });
  });

  it('fails closed on committed contradictions and missing artifact identity for R-4', () => {
    const contradictory = snapshot({ contradictions: ['publication has a committed receipt but an earlier prerequisite is not verified'] });
    expect(evaluateByocReadiness('R-4', 'WI-10001532', [contradictory], '2026-09-20T00:00:00.000Z').verdict).toBe('fail');
    expect(evaluateByocReadiness('R-4', 'WI-10001532', [snapshot({}, null)], '2026-09-20T00:00:00.000Z')).toMatchObject({
      verdict: 'unknown',
      missingMilestones: ['artifact-identity'],
    });
  });

  it('refuses an ambiguous historical release-task population instead of selecting a lucky receipt', () => {
    const first = snapshot();
    const second = { ...snapshot(), taskId: 'task-2' };
    expect(evaluateByocReadiness('R-4', 'WI-10001532', [first, second], '2026-09-20T00:00:00.000Z')).toMatchObject({
      verdict: 'unknown',
      missingMilestones: ['release-task-selection'],
      releaseTaskSelection: 'ambiguous',
    });
  });

  it('does not ask for final shipment as a prerequisite to R-6 acceptance', () => {
    const unshipped = snapshot({
      shipped: false,
      milestones: snapshot().milestoneProjection.milestones.filter(({ key }) => key !== 'shipment'),
    });
    const result = evaluateByocReadiness('R-6', 'WI-10001532', [unshipped]);
    expect(result.missingMilestones).toEqual([]);
    expect(result.verdict).toBe('unknown');
    expect(result.unverifiedEvidence).toContain('five-live-journeys');
  });

  it('does not let a different work item supply a successful receipt population', () => {
    expect(evaluateByocReadiness('R-4', 'WI-other', [snapshot()])).toMatchObject({
      verdict: 'fail',
      contradictions: ['task-1:work-item-identity-mismatch'],
    });
  });

  it('requires customer desktop source observations even with a committed acceptance receipt', () => {
    const result = evaluateByocReadiness('R-5', 'WI-10001532', [snapshot()]);
    expect(result.missingMilestones).toEqual([]);
    expect(result.unverifiedEvidence).toContain('customer-desktop');
    expect(result.verdict).toBe('unknown');
  });
});

describe('exact BYOC release subject', () => {
  const subject = { workspaceId: 'ws', workItemId: 'WI-10001532', taskId: 'task-1' };
  const journal = {
    schemaVersion: 1, operationId: 'operation-1', cursor: 0,
    currentStage: null, currentState: null, spentOperationIds: [], receipts: [],
  };
  const row = {
    task_id: subject.taskId, workspace_id: subject.workspaceId,
    work_item_id: subject.workItemId, class: 'deploy', detail: { release: journal },
  };
  const sqlFor = (rows: unknown[]) => vi.fn(async () => rows) as unknown as Sql;

  it('requires taskId in the tool contract, rather than selecting a recent release implicitly', () => {
    expect(tool.args.safeParse({ bar: 'R-4', workItemId: subject.workItemId }).success).toBe(false);
    expect(tool.args.safeParse({ bar: 'R-4', workItemId: subject.workItemId, taskId: subject.taskId }).success).toBe(true);
  });

  it('reads the selected task with workspace and work-item predicates, without a carry shortlist', async () => {
    const sql = sqlFor([row]);
    expect(await readByocReleaseSubject(subject, sql)).toMatchObject({
      taskId: subject.taskId, workItemId: subject.workItemId, operationId: journal.operationId,
    });
    const [strings, ...values] = vi.mocked(sql).mock.calls[0];
    expect(Array.from(strings as unknown as string[]).join('?')).toMatch(/WHERE task_id = \?/);
    expect(values).toEqual([subject.taskId, subject.workspaceId, subject.workItemId]);
  });

  it.each([
    [],
    [{ ...row, workspace_id: 'another-workspace' }],
    [{ ...row, work_item_id: 'WI-other' }],
    [{ ...row, task_id: 'another-task' }],
    [{ ...row, class: 'bash-job' }],
    [{ ...row, detail: { release: { ...journal, cursor: 1 } } }],
    [row, row],
  ])('refuses absent, mismatched, malformed or non-unique subjects', async (...rows) => {
    expect(await readByocReleaseSubject(subject, sqlFor(rows))).toBeNull();
  });

  it('rejects blank scope before making a database read', async () => {
    const sql = sqlFor([row]);
    await expect(readByocReleaseSubject({ ...subject, workspaceId: ' ' }, sql)).rejects.toThrow('non-empty');
    expect(sql).not.toHaveBeenCalled();
  });

  it('rejects a receipt copied from another operation', async () => {
    const receipt = {
      sequence: 0, operationId: 'foreign', requestIdentity: 'req', stage: 'publish.finalize',
      state: 'committed', inputHash: 'a'.repeat(64), evidenceRefs: ['publication:pass'],
      recordedAt: '2026-09-20T00:00:00Z',
    };
    expect(await readByocReleaseSubject(subject, sqlFor([{
      ...row, detail: { release: { ...journal, cursor: 1, receipts: [receipt] } },
    }]))).toBeNull();
  });
});
