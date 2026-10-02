/** The existing journal endpoint must actually invoke the native-policy producer. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  record: vi.fn(async () => ({ recorded: true, reason: 'turn-end-policy-recorded-not-yet-graded' })),
  persist: vi.fn(async () => true),
  path: vi.fn(async (): Promise<string | null> => '/native/session'),
  turn: vi.fn(async (): Promise<{ text: string; ts: Date } | null> => null),
  extract: vi.fn(() => null as null | { note: string; source: string; flagged: boolean }),
  latest: vi.fn(async () => null),
  ledger: vi.fn(async () => []),
  journal: vi.fn(async () => ({ id: 'journal-row', deduped: false })),
}));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'holder', workspaceId: 'workspace' }), requireWorkspaceId: () => 'workspace',
}));
vi.mock('../../goal-placement-turn-receipts', () => ({
  boundedRecordGoalPlacementTurnEnd: h.record,
  boundedRecordGoalPlacementTurnEndOutcome: h.persist,
}));
vi.mock('../../turn-journal', () => ({
  resolveTranscriptPath: h.path, readLastAssistantTurn: h.turn,
  extractJournalFromAssistantText: h.extract, detectClaimLedgerMismatch: vi.fn(),
}));
vi.mock('../../turn-journal-store', () => ({
  latestJournalCreatedAt: h.latest, ledgerEntriesSince: h.ledger, recordTurnJournal: h.journal,
}));
vi.mock('../../turn-provenance/turn-ref', () => ({ resolveCurrentTurnStamp: vi.fn(async () => null) }));
vi.mock('../../turn-end-tracking-io', () => ({
  boundedArtifactSweep: vi.fn(async () => null),
  boundedOpenTaskReminderSweep: vi.fn(async () => null),
  boundedUnguardedHaltSweep: vi.fn(async () => null),
  boundedAutoCheckpoint: vi.fn(async () => []),
  boundedCoordWatermarkSettle: vi.fn(async () => null),
}));
vi.mock('../../session-cursor-io', () => ({ boundedBuildAndPersistCursor: vi.fn(async () => false) }));
import tool from './record-turn';

beforeEach(() => {
  h.record.mockReset().mockResolvedValue({ recorded: true, reason: 'turn-end-policy-recorded-not-yet-graded' });
  h.persist.mockReset().mockResolvedValue(true);
  h.path.mockReset().mockResolvedValue('/native/session');
  h.turn.mockReset().mockResolvedValue(null);
  h.extract.mockReset().mockReturnValue(null);
  h.latest.mockReset().mockResolvedValue(null);
  h.ledger.mockReset().mockResolvedValue([]);
  h.journal.mockReset().mockResolvedValue({ id: 'journal-row', deduped: false });
});
describe('journal native placement seam', () => {
  it('samples before journal prose extraction and does not require a journal note', async () => {
    const result = await tool.handler({ owner: 'holder', session_id: 'native', source_kind: 'codex' }, {} as never);
    expect(result).toMatchObject({ data: { reason: 'no_assistant_turn', goalPlacementTurnEnd: {
      recorded: true, reason: 'turn-end-policy-recorded-not-yet-graded',
    } } });
    expect(h.record).toHaveBeenCalledExactlyOnceWith({ ownerId: 'holder', workspaceId: 'workspace', nativeSessionId: 'native', sourceKind: 'codex' });
  });
  it('returns and durably records a native-session-mismatch outcome', async () => {
    h.record.mockResolvedValueOnce({ recorded: false, reason: 'native-session-mismatch' });
    const input = { ownerId: 'holder', workspaceId: 'workspace', nativeSessionId: 'native', sourceKind: 'codex' };
    const result = await tool.handler({ owner: 'holder', session_id: 'native', source_kind: 'codex' }, {} as never);
    expect(result).toMatchObject({ data: { reason: 'no_assistant_turn', goalPlacementTurnEnd: {
      recorded: false, reason: 'native-session-mismatch',
    } } });
    expect(h.persist).toHaveBeenCalledExactlyOnceWith(input, { recorded: false, reason: 'native-session-mismatch' });
  });
  it('returns but does not diagnose the no-canonical-goal outcome', async () => {
    h.record.mockResolvedValueOnce({ recorded: false, reason: 'no-canonical-goal' });
    const result = await tool.handler({ owner: 'holder', session_id: 'native', source_kind: 'codex' }, {} as never);
    expect(result).toMatchObject({ data: { goalPlacementTurnEnd: {
      recorded: false, reason: 'no-canonical-goal',
    } } });
    expect(h.persist).not.toHaveBeenCalled();
  });
  it('includes the native outcome on the no-note response branch', async () => {
    h.turn.mockResolvedValueOnce({ text: 'assistant response', ts: new Date('2026-10-01T00:00:00.000Z') });
    const result = await tool.handler({ owner: 'holder', session_id: 'native', source_kind: 'codex' }, {} as never);
    expect(result).toMatchObject({ data: { reason: 'no_note', goalPlacementTurnEnd: {
      recorded: true, reason: 'turn-end-policy-recorded-not-yet-graded',
    } } });
  });
  it('includes the native outcome on a recorded journal response', async () => {
    h.turn.mockResolvedValueOnce({ text: 'assistant response', ts: new Date('2026-10-01T00:00:00.000Z') });
    h.extract.mockReturnValueOnce({ note: 'journal note', source: 'agent', flagged: false });
    const result = await tool.handler({ owner: 'holder', session_id: 'native', source_kind: 'codex' }, {} as never);
    expect(result).toMatchObject({ data: { ok: true, id: 'journal-row', goalPlacementTurnEnd: {
      recorded: true, reason: 'turn-end-policy-recorded-not-yet-graded',
    } } });
  });
  it('does not use a cross-owner journal write as opportunity evidence', async () => {
    const result = await tool.handler({ owner: 'another-owner', session_id: 'native', source_kind: 'codex' }, {} as never);
    expect(h.record).not.toHaveBeenCalled();
    expect(result).toMatchObject({ data: { reason: 'no_assistant_turn', goalPlacementTurnEnd: null } });
  });
  it('returns the native outcome even when journal transcript discovery fails', async () => {
    h.path.mockResolvedValue(null);
    const result = await tool.handler({ session_id: 'native', source_kind: 'codex' }, {} as never);
    expect(h.record).toHaveBeenCalledExactlyOnceWith({ ownerId: 'holder', workspaceId: 'workspace', nativeSessionId: 'native', sourceKind: 'codex' });
    expect(result).toMatchObject({ data: { reason: 'transcript_not_found', goalPlacementTurnEnd: {
      recorded: true, reason: 'turn-end-policy-recorded-not-yet-graded',
    } } });
  });
});
