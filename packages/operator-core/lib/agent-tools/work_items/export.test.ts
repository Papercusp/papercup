import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkItem } from '../../work-items';

const getWorkItem = vi.fn();
const listWorkItems = vi.fn();
const listAllWorkItemsForFileExport = vi.fn();
const explainIssueClaimFloors = vi.fn();
const resolveFleetMetricScope = vi.fn();
const readFleetMetricSourceItems = vi.fn();
const snapshotSql = vi.fn();

vi.mock('../fleet/fleet-metrics-scope', async () => {
  const { matchesWorkItemClaimSpec } = await import('../../scheduler/claim-spec-match');
  return {
    selectFleetMetricCurrentItems: (scope: { claimSpec: { current: Parameters<typeof matchesWorkItemClaimSpec>[1] } }, rows: WorkItem[]) =>
      rows.filter(row => matchesWorkItemClaimSpec(row, scope.claimSpec.current)),
    resolveFleetMetricScope: (...args: unknown[]) => resolveFleetMetricScope(...args),
    readFleetMetricSourceItems: (...args: unknown[]) => readFleetMetricSourceItems(...args),
    withFleetMetricReadSql: (read: (sql: unknown) => unknown) => read(snapshotSql),
  };
});

vi.mock('../../work-items', () => ({
  getWorkItem: (...args: unknown[]) => getWorkItem(...args),
  listWorkItems: (...args: unknown[]) => listWorkItems(...args),
  listAllWorkItemsForFileExport: (...args: unknown[]) => listAllWorkItemsForFileExport(...args),
  explainIssueClaimFloors: (...args: unknown[]) => explainIssueClaimFloors(...args),
  TERMINAL_WORK_ITEM_STATES: ['done', 'resolved'],
  WORK_ITEMS_MAX_LIMIT: 2_000,
}));

import tool, { WORK_ITEM_EXPORT_WRITE_CONCURRENCY, writeWorkItemFiles } from './export';

type ExportResult = {
  content: Array<{ type: 'text'; text: string }>;
};

const handler = (tool as unknown as {
  handler: (args: Record<string, unknown>, ctx?: Record<string, unknown>) => Promise<ExportResult>;
}).handler;

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

beforeEach(() => {
  getWorkItem.mockReset();
  listWorkItems.mockReset();
  listAllWorkItemsForFileExport.mockReset();
  explainIssueClaimFloors.mockReset();
  resolveFleetMetricScope.mockReset();
  readFleetMetricSourceItems.mockReset();
  snapshotSql.mockReset();
});

describe('work_items:export fixed fleet cohort', () => {
  async function setup() {
    const toDir = join(await directory(), 'cohort');
    const rows = ['WI-2', 'WI-1', 'WI-terminal', 'WI-observation', 'WI-outside', 'WI-feature', 'WI-task']
      .map(id => ({ ...row(id), kind: 'bug', state: 'open', closedAt: null,
        payload: { completeEvidence: { text: 'retain the full payload', source: id } } }));
    rows[2]!.state = 'done';
    rows[3]!.payload = { lane: 'observation' } as never;
    rows[5]!.family = 'feature';
    rows[6]!.kind = 'task';
    const scope = { ok: true, generatedAt: '2026-11-06T16:00:00Z', scope: { stock: { revision: 23 } },
      claimSpec: { current: { specId: 'fleet:bugs', revision: 23, view: {
        filter: { field: 'id', op: 'in', value: rows.filter(r => r.id !== 'WI-outside').map(r => r.id) },
      } } } };
    resolveFleetMetricScope.mockResolvedValue(scope);
    readFleetMetricSourceItems.mockResolvedValue(rows);
    snapshotSql.mockResolvedValue([{ snapshot_id: '10:20:', snapshot_at: '2026-11-06 16:00:01+00' }]);
    explainIssueClaimFloors.mockResolvedValue([
      { id: 'WI-1', admissible: false, refusedBy: 'claim-hold', failedFloors: ['claim-hold', 'agent-review'], detail: 'preserve' },
      { id: 'WI-2', admissible: true, refusedBy: null, failedFloors: [], detail: null },
    ]);
    return { toDir, scope };
  }

  it('freezes every matching nonterminal bug with full payload, all floors and verifiable file/spec/ID hashes', async () => {
    const { toDir, scope } = await setup();
    const result = payload(await handler({ harness: 'demo', fleet: 'bugs', toDir }, { workspaceId: 'ws' }));
    const body = await readFile(join(toDir, 'manifest.json'), 'utf8');
    const manifest = JSON.parse(body);
    const hash = (s: string) => createHash('sha256').update(s).digest('hex');
    expect(result).toMatchObject({ written: 2, missing: [], truncatedByLimit: false, manifestSha256: hash(body) });
    expect(manifest.ids).toEqual(['WI-1', 'WI-2']);
    expect(manifest.idsSha256).toBe(hash(JSON.stringify(manifest.ids)));
    expect(manifest.specSha256).toBe(hash(JSON.stringify(scope.claimSpec.current)));
    expect(manifest.database).toEqual({ snapshot_id: '10:20:', snapshot_at: '2026-11-06 16:00:01+00' });
    expect(readFleetMetricSourceItems).toHaveBeenCalledWith(scope, { notTerminal: true, fullPayload: true, sql: snapshotSql });
    expect(explainIssueClaimFloors).toHaveBeenCalledWith('demo', ['WI-1', 'WI-2'],
      { assignee: undefined, includeAllFloors: true }, snapshotSql);
    expect(manifest.entries[0].restrictions.failedFloors).toEqual(['claim-hold', 'agent-review']);
    for (const entry of manifest.entries) {
      const file = await readFile(join(toDir, entry.file), 'utf8');
      expect(entry.sha256).toBe(hash(file));
      expect(JSON.parse(file).payload.completeEvidence.text).toBe('retain the full payload');
    }
    expect(listWorkItems).not.toHaveBeenCalled();
    expect(listAllWorkItemsForFileExport).not.toHaveBeenCalled();
    const repeated = handler({ harness: 'demo', fleet: 'bugs', toDir }, { workspaceId: 'ws' });
    await expect(repeated).rejects.toThrow('EEXIST');
    expect(await readFile(join(toDir, 'manifest.json'), 'utf8')).toBe(body);
  });

  it('refuses a partial floor ledger without publishing a manifest', async () => {
    const { toDir } = await setup();
    explainIssueClaimFloors.mockResolvedValue([{ id: 'WI-1', admissible: false, refusedBy: 'claim-hold' }]);
    await expect(handler({ harness: 'demo', fleet: 'bugs', toDir }, { workspaceId: 'ws' }))
      .rejects.toThrow('complete scheduler-floor coverage');
    await expect(readFile(join(toDir, 'manifest.json'))).rejects.toThrow('ENOENT');
  });

  it.each([{ ids: ['WI-1'] }, { limit: 1 }, { terminalOnly: false }, { includeObservations: true }])(
    'refuses scope narrowing %j before any cohort read', async extra => {
      const result = payload(await handler({ harness: 'demo', fleet: 'bugs', toDir: '/unused', ...extra }));
      expect(result.error).toBe('invalid_fleet_export_scope');
      expect(resolveFleetMetricScope).not.toHaveBeenCalled();
    },
  );
});

function row(id: string): WorkItem {
  return {
    id,
    kind: 'change',
    family: 'issue',
    harness: 'demo',
    title: id,
    summary: '',
    state: 'done',
    assignee: null,
    takenAt: null,
    lastProgressAt: null,
    assignedBy: null,
    createdBy: null,
    severity: 'minor',
    goalId: null,
    parent: null,
    payload: null,
    rank: null,
    rankWriter: null,
    rankUpdatedAt: null,
    priority: null,
    terminalOwner: null,
    terminalCompletionRef: null,
    terminalCompletionEvidence: null,
    completionAuthority: null,
    origin: 'local',
    auditVerdict: null,
    verifiedAuthorGithubUserId: null,
    createdAt: '2026-08-22T00:00:00.000Z',
    updatedAt: '2026-08-22T00:00:00.000Z',
    closedAt: '2026-08-22T00:00:00.000Z',
  };
}

async function directory(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'work-items-export-test-'));
  cleanup.push(value);
  return value;
}

function payload(result: ExportResult): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

describe('work_items:export harness enumeration', () => {
  it('writes large exports with bounded parallelism and no dropped rows', async () => {
    const rows = Array.from(
      { length: WORK_ITEM_EXPORT_WRITE_CONCURRENCY * 2 + 1 },
      (_, index) => row(`WI-${index + 1}`),
    );
    const writtenFiles: string[] = [];
    let active = 0;
    let maxActive = 0;

    const written = await writeWorkItemFiles('/virtual/export', rows, async (file, body, encoding) => {
      active++;
      maxActive = Math.max(maxActive, active);
      writtenFiles.push(file);
      expect(encoding).toBe('utf8');
      expect(JSON.parse(body)).toMatchObject({ id: file.split('/').at(-1)?.replace(/\.json$/, '') });
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
    });

    expect(written).toBe(rows.length);
    expect(new Set(writtenFiles).size).toBe(rows.length);
    expect(maxActive).toBe(WORK_ITEM_EXPORT_WRITE_CONCURRENCY);
  });

  it('uses the complete file-export path when limit is omitted', async () => {
    listAllWorkItemsForFileExport.mockResolvedValue([row('WI-1'), row('WI-2')]);
    const toDir = await directory();

    const result = await handler({ harness: 'demo', toDir });

    expect(listAllWorkItemsForFileExport).toHaveBeenCalledWith({
      harness: 'demo',
      states: ['done', 'resolved'],
    });
    expect(listWorkItems).not.toHaveBeenCalled();
    expect(payload(result)).toMatchObject({ written: 2, truncatedByLimit: false });
    expect(JSON.parse(await readFile(join(toDir, 'WI-2.json'), 'utf8'))).toMatchObject({ id: 'WI-2' });
  });

  it('keeps an explicit limit bounded and reports a possibly partial export', async () => {
    listWorkItems.mockResolvedValue([row('WI-1')]);
    const toDir = await directory();

    const result = await handler({ harness: 'demo', toDir, limit: 1 });

    expect(listWorkItems).toHaveBeenCalledWith({
      harness: 'demo',
      states: ['done', 'resolved'],
      limit: 1,
    });
    expect(listAllWorkItemsForFileExport).not.toHaveBeenCalled();
    expect(payload(result)).toMatchObject({ written: 1, truncatedByLimit: true });
  });
});
