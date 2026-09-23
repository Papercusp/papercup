/** The existing journal endpoint must actually invoke the native-policy producer. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ record: vi.fn(async () => ({ recorded: true })), path: vi.fn(async () => '/native/session') }));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'holder', workspaceId: 'workspace' }), requireWorkspaceId: () => 'workspace',
}));
vi.mock('../../goal-placement-turn-receipts', () => ({ boundedRecordGoalPlacementTurnEnd: h.record }));
vi.mock('../../turn-journal', () => ({
  resolveTranscriptPath: h.path, readLastAssistantTurn: vi.fn(async () => null),
  extractJournalFromAssistantText: vi.fn(), detectClaimLedgerMismatch: vi.fn(),
}));
vi.mock('../../turn-journal-store', () => ({ latestJournalCreatedAt: vi.fn(), ledgerEntriesSince: vi.fn(), recordTurnJournal: vi.fn() }));
import tool from './record-turn';

beforeEach(() => { h.record.mockClear(); h.path.mockResolvedValue('/native/session'); });
describe('journal native placement seam', () => {
  it('samples before journal prose extraction and does not require a journal note', async () => {
    const result = await tool.handler({ owner: 'holder', session_id: 'native', source_kind: 'codex' }, {} as never);
    expect(result).toMatchObject({ data: { reason: 'no_assistant_turn' } });
    expect(h.record).toHaveBeenCalledExactlyOnceWith({ ownerId: 'holder', workspaceId: 'workspace', nativeSessionId: 'native', sourceKind: 'codex' });
  });
  it('does not use a cross-owner journal write as opportunity evidence', async () => {
    await tool.handler({ owner: 'another-owner', session_id: 'native', source_kind: 'codex' }, {} as never);
    expect(h.record).not.toHaveBeenCalled();
  });
  it('leaves a missing transcript unknown without invoking the producer', async () => {
    h.path.mockResolvedValue(null as never);
    await tool.handler({ session_id: 'native', source_kind: 'codex' }, {} as never);
    expect(h.record).not.toHaveBeenCalled();
  });
});
