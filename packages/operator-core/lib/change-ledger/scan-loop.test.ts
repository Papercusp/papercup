import { describe, it, expect, beforeEach, vi } from 'vitest';
import { runChangeLedgerScan } from './scan-loop';
import { scanRepoPromptEdits } from './prompt-file-scan';

// Unit: the git-log scan has its own suite; this pins the SHARED orchestration —
// the flag kill-switch (default ON), the sinceDays default/override, and the
// scan wiring (deterministic-blueprints-migration-2026-06-13 P-004, D-004).
vi.mock('./prompt-file-scan', () => ({ scanRepoPromptEdits: vi.fn(), PROMPT_SCAN_GIT_ARGS: vi.fn(() => []) }));
vi.mock('./change-ledger', () => ({ recordBehaviorChange: vi.fn() }));

const mockScan = vi.mocked(scanRepoPromptEdits);

const INPUT = { workspaceId: 'ws-1', installSlug: 'papercup' };

describe('runChangeLedgerScan — flag-gated repo scan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockScan.mockResolvedValue({ edits: 4, recorded: 3 } as unknown as Awaited<ReturnType<typeof scanRepoPromptEdits>>);
  });

  it('skips with flag-off when the change-ledger flag is off (no scan)', async () => {
    const out = await runChangeLedgerScan(INPUT, { flag: async () => false });
    expect(out).toEqual({ ran: false, skipReason: 'flag-off' });
    expect(mockScan).not.toHaveBeenCalled();
  });

  it('scans with the default 14-day window and returns edits/recorded counts', async () => {
    const out = await runChangeLedgerScan(INPUT, { flag: async () => true });
    expect(mockScan).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws-1' }),
      { sinceDays: 14 },
    );
    expect(out).toEqual({ ran: true, edits: 4, recorded: 3 });
  });

  it('honors a payload sinceDays override', async () => {
    await runChangeLedgerScan({ ...INPUT, payload: { sinceDays: 30 } }, { flag: async () => true });
    expect(mockScan).toHaveBeenCalledWith(expect.anything(), { sinceDays: 30 });
  });

  it('threads the injected runGitLog + record seams into the scan', async () => {
    const runGitLog = vi.fn();
    const record = vi.fn();
    await runChangeLedgerScan(INPUT, { flag: async () => true, runGitLog, record });
    expect(mockScan).toHaveBeenCalledWith(
      expect.objectContaining({ runGitLog, record, workspaceId: 'ws-1' }),
      expect.anything(),
    );
  });
});
