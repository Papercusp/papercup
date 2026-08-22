import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getWorkItem = vi.fn();
const listWorkItems = vi.fn();
const listAllWorkItemsForFileExport = vi.fn();

vi.mock('../../work-items', () => ({
  getWorkItem: (...args: unknown[]) => getWorkItem(...args),
  listWorkItems: (...args: unknown[]) => listWorkItems(...args),
  listAllWorkItemsForFileExport: (...args: unknown[]) => listAllWorkItemsForFileExport(...args),
  TERMINAL_WORK_ITEM_STATES: ['done', 'resolved'],
  WORK_ITEMS_MAX_LIMIT: 2_000,
}));

import tool from './export';

type ExportResult = {
  content: Array<{ type: 'text'; text: string }>;
};

const handler = (tool as unknown as {
  handler: (args: Record<string, unknown>) => Promise<ExportResult>;
}).handler;

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

beforeEach(() => {
  getWorkItem.mockReset();
  listWorkItems.mockReset();
  listAllWorkItemsForFileExport.mockReset();
});

function row(id: string) {
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
