import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ publish: vi.fn(), disabled: vi.fn(), modes: vi.fn(), failure: vi.fn() }));
vi.mock('./report-publication', () => ({ publishReportWithEffects: mocks.publish }));
vi.mock('./agent-tools/reports/_shared', () => ({ reportsLibraryDisabled: mocks.disabled }));
vi.mock('./modes/store', () => ({ getModes: mocks.modes }));
vi.mock('./harness/improvements/capture-core', () => ({ captureImprovement: mocks.failure }));
vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: 'fixture-sql' }) }));
import { captureCoordReport, captureAcceptanceVerdict, captureAuditCompletion } from './report-capture';
const origin = { workspaceId: 'ws', ownerId: 'author', harnessSlug: 'pot', sessionRef: 'session' };
beforeEach(() => {
  vi.clearAllMocks(); mocks.disabled.mockResolvedValue(null); mocks.modes.mockResolvedValue([{ mode: 'audit' }]);
  mocks.publish.mockResolvedValue({ report: { reportId: 'rpt_saved' }, eventEmitted: true });
  mocks.failure.mockResolvedValue({ created: true });
});
describe('Reports capture adapters', () => {
  it('preserves a delivered card body, plan subject and server origin with a stable retry key', async () => {
    const input = { ...origin, msgId: 'message-1', summary: 'Progress', report: { title: 'Review', plans: [{ slug: 'plan-1', title: 'Plan',
      summary: 'Measured result', items: [{ id: 'P-1', text: 'Verified', status: 'done', ref: 'wi:WI-1' }] }] } };
    expect(await captureCoordReport(input)).toBe('rpt_saved');
    await captureCoordReport(input);
    const [, published, stamped] = mocks.publish.mock.calls[0];
    expect(published).toMatchObject({ visibility: 'owner', source: 'capture:coord', subject: { kind: 'plan', ref: 'plan-1' } });
    expect(published.bodyMd).toContain('P-1: Verified (done) — wi:WI-1');
    expect(stamped).toEqual({ authorOwnerId: 'author', harnessSlug: 'pot', authorSessionRef: 'session' });
    expect(mocks.publish.mock.calls[1][1].requestKey).toBe(published.requestKey);
  });
  it('copies exact acceptance evidence and gives independent verdicts distinct source keys', async () => {
    const input = { ...origin, issueId: 'card-1', rubricRef: 'acceptance-plan-1', title: 'Acceptance', planSlug: 'plan-1',
      ratings: { rendered: { rating: 'passed', evidence: 'native assertion' } }, acceptance: { verdict: 'accepted', reasoning: 'Verified' } };
    await captureAcceptanceVerdict(input);
    await captureAcceptanceVerdict({ ...input, issueId: 'card-2' });
    const first = mocks.publish.mock.calls[0][1];
    expect(first.kind).toBe('review'); expect(first.bodyMd).toContain('native assertion');
    expect(first.bodyMd).toContain('accepted');
    expect(mocks.publish.mock.calls[1][1].requestKey).not.toBe(first.requestKey);
  });
  it('captures a completed audit only when the author holds audit mode', async () => {
    const input = { ...origin, itemId: 'WI-1', title: 'Program audit', completion: { summary: 'Measured verdict', testResult: 'passed' } };
    await captureAuditCompletion(input);
    expect(mocks.publish.mock.calls[0][1]).toMatchObject({ kind: 'audit', subject: { kind: 'work_item', ref: 'WI-1' } });
    expect(mocks.publish.mock.calls[0][1].bodyMd).toContain('testResult');
    mocks.publish.mockClear(); mocks.modes.mockResolvedValue([]);
    expect(await captureAuditCompletion(input)).toBeNull(); expect(mocks.publish).not.toHaveBeenCalled();
  });
  it('honors the kill switch and files a source-addressable failure without failing the original verdict', async () => {
    const input = { ...origin, issueId: 'card-1', rubricRef: 'rubric', title: 'Verdict', ratings: {} };
    mocks.disabled.mockResolvedValue({ ok: false });
    expect(await captureAcceptanceVerdict(input)).toBeNull(); expect(mocks.publish).not.toHaveBeenCalled();
    mocks.disabled.mockResolvedValue(null); mocks.publish.mockRejectedValue(new Error('database unavailable'));
    expect(await captureAcceptanceVerdict(input)).toBeNull();
    expect(mocks.failure.mock.calls[0][0].body).toContain('card-1');
  });
});
