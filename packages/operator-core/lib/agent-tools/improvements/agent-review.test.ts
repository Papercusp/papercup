import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { lookupByMcpName } from '@papercusp/agent-mcp';
import { dispatchProjectedTool, type ToolResult as DispatchToolResult } from '@papercusp/tooldef';

const h = vi.hoisted(() => ({
  claim: vi.fn(),
  claimNext: vi.fn(),
  resubmit: vi.fn(),
  adopt: vi.fn(),
  adoptNext: vi.fn(),
  correct: vi.fn(),
  correctionBase: vi.fn(),
  claimSpec: vi.fn(),
  identity: vi.fn((): { ownerId: string; workspaceId?: string } => ({ ownerId: 'su-reviewer' })),
}));

vi.mock('../../harness/improvements/agent-review', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../harness/improvements/agent-review')>(),
  claimAgentReview: h.claim,
  claimNextAgentReview: h.claimNext,
  resubmitAgentReview: h.resubmit,
  adoptAgentReviewRevision: h.adopt,
  adoptNextAgentReviewRevision: h.adoptNext,
  correctAgentReview: h.correct,
  readAgentReviewCorrectionBase: h.correctionBase,
}));
vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: h.identity }));
vi.mock('../../scheduler/claim-spec-store', () => ({ getClaimSpecRecord: h.claimSpec }));

import tool, { agentReviewAbortCompletionReceipt, agentReviewEvidenceHandoff } from './agent-review';

type ToolResult = { content: Array<{ text: string }>; isError?: boolean };
const call = (args: Record<string, unknown>, ctx: Record<string, unknown> = {}) =>
  tool.handler(args as never, ctx as never) as Promise<ToolResult>;
const body = (result: ToolResult) => JSON.parse(result.content[0]!.text);
const dispatchResult = (value: unknown): DispatchToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
});
const attempt = { callId: 'call-1', toolName: 'improvements:agent-review' };

beforeEach(() => {
  vi.clearAllMocks();
  h.identity.mockReturnValue({ ownerId: 'su-reviewer' });
  h.claim.mockResolvedValue({ claimed: false, workItem: null, reason: 'not-found' });
  h.claimNext.mockResolvedValue(null);
  h.claimSpec.mockResolvedValue({ source: 'cup', spec: { view: {} } });
  h.resubmit.mockResolvedValue({ resubmitted: true, state: { status: 'pending', round: 2 } });
});

describe('improvements:agent-review public door', () => {
  it.each([false, true])('negotiates a complete structured twin of a raw public claim (structured=%s)', async structured => {
    const workItem = { id: 'EI-7', harness: 'papercusp', kind: 'change', title: 'Corrected report',
      summary: 'Full corrected source '.repeat(700), createdBy: 'su-filer', payload: {
        agentReview: { status: 'pending', submittedBy: 'su-filer', ledgerIdeaId: 'idea-7', round: 3,
          correctionHistory: [] },
      } };
    h.identity.mockReturnValue({ ownerId: 'su-reviewer', workspaceId: 'workspace-test' });
    h.claim.mockResolvedValue({ claimed: true, workItem });
    const dispatched = await dispatchProjectedTool(lookupByMcpName('improvements:agent-review')!,
      'improvements:agent-review', { mode: 'claim', id: workItem.id, harness: 'papercusp' }, {
        transport: 'mcp', workspaceId: 'workspace-test', role: 'operator', runId: 'structured-review-test',
        principal: { slug: 'system:superuser', workspaceId: 'workspace-test', capabilities: new Set(['work_items:write']) },
        requestedStructured: structured, requestedFormat: 'json', contextTier: 'full',
        log: vi.fn(), signal: new AbortController().signal, progress: vi.fn(), emit: vi.fn(), tx: {},
      }, {});
    expect(dispatched.ok, JSON.stringify(dispatched.error)).toBe(true);
    const result = dispatched.result!;
    const first = result.content?.[0];
    if (first?.type !== 'text') throw new Error('public claim must return JSON text');
    const original = JSON.parse(first.text);
    expect(JSON.stringify(original).length).toBeGreaterThan(9000);
    expect(original.workItem).toEqual(workItem);
    if (structured) expect(result.structuredContent).toEqual(original);
    else expect(result.structuredContent).toBeUndefined();
  });

  it('hands off original evidence and distinct transcript/consult gaps without claiming reproduction', () => {
    const original = { id: 'EI-7', harness: 'papercusp', kind: 'bug', title: 'Original report',
      summary: 'Observed once; see test_runs:42', createdBy: 'su-filer', payload: {
        reporter: { kind: 'agent', id: 'su-filer' },
        source: { sessionId: 'codex:source-session', ref: 'session_turn:codex:source-session:7' },
        reportContext: { logExcerpt: 'Original reporter context' },
        agentReview: { status: 'pending', submittedBy: 'su-filer', ledgerIdeaId: 'idea-7', round: 3,
          correctionContext: [
            { kind: 'transcript', outcome: 'inaccessible', text: 'Transcript access was refused.' },
            { kind: 'consultation', outcome: 'unavailable', text: 'No peer answered.', ref: 'conversation:consult-7' },
            { kind: 'evidence', outcome: 'unknown', text: 'Reproduction has not been attempted.' },
          ], correctionHistory: [] },
      } };
    const before = structuredClone(original);
    const handoff = agentReviewEvidenceHandoff(original as never);
    expect(Object.keys(handoff)).toHaveLength(10);
    expect(handoff).toMatchObject({ filingIdentity: { createdBy: 'su-filer', submittedBy: 'su-filer' },
      sessionRefs: ['codex:source-session'], turnRefs: ['session_turn:codex:source-session:7'],
      reportContext: original.payload.reportContext, contextOutcomes: original.payload.agentReview.correctionContext,
      gaps: { transcript: 'recorded-reference-unread', unresolved: original.payload.agentReview.correctionContext } });
    expect(handoff.evidenceRefs).toEqual(expect.arrayContaining(['test_runs:42', 'conversation:consult-7']));
    expect(handoff.investigation.transcript).toContain('sessions:read');
    expect(handoff.investigation.consultation).toContain('consult:get_feedback');
    expect(handoff.investigation.correction).toContain('do not prove reproduction');
    expect(original).toEqual(before);
    expect(agentReviewEvidenceHandoff({ ...original, payload: {} } as never).gaps.transcript)
      .toBe('reference-not-recorded');
  });

  it('derives correction author and workspace from authentication and forwards the exact server base', async () => {
    h.identity.mockReturnValue({ ownerId: 'su-reviewer', workspaceId: 'workspace' });
    h.correct.mockResolvedValue({ corrected: false, reason: 'correction-base-stale' });
    const input = { mode: 'correct', id: 'EI-7', harness: 'papercusp', requestKey: 'request-1', expectedRound: 2,
      correctionRevision: 'correction-v1:' + 'a'.repeat(64), correction: { classification: 'clarification',
        notes: [{ kind: 'consultation', outcome: 'unavailable', text: 'No peer answer is available yet.' }] } };
    expect(body(await call(tool.args.parse(input)))).toMatchObject({ mode: 'correct', corrected: false });
    const { mode: _mode, ...request } = input;
    expect(h.correct).toHaveBeenCalledWith({ ...request, actor: 'su-reviewer', workspaceId: 'workspace' });
    expect(tool.args.safeParse({ ...input, actor: 'su-forged' }).success).toBe(false);
    expect(tool.args.safeParse({ ...input, workspaceId: 'other' }).success).toBe(false);
  });

  it('requires authenticated workspace and concrete harness before any correction read or write', async () => {
    expect(body(await call({ mode: 'correction-base', id: 'EI-7', harness: 'papercusp' }))).toMatchObject({ reason: 'workspace-required' });
    h.identity.mockReturnValue({ ownerId: 'su-reviewer', workspaceId: 'workspace' });
    await call({ mode: 'correction-base', id: 'EI-7', harness: 'all' });
    expect(h.correctionBase).not.toHaveBeenCalled();
    expect(h.correct).not.toHaveBeenCalled();
    h.correctionBase.mockResolvedValue({ available: true, round: 2, correctionRevision: 'correction-v1:' + 'b'.repeat(64) });
    expect(body(await call({ mode: 'correction-base', id: 'EI-7', harness: 'papercusp' }))).toMatchObject({ available: true, round: 2 });
    expect(h.correctionBase).toHaveBeenCalledWith({ id: 'EI-7', harness: 'papercusp', workspaceId: 'workspace' });
  });
  const acceptance = {
    problem: 'An adopted revision cannot supply its missing proposal.',
    evidence: ['The current resubmit schema has no proposal input.'],
    outcome: 'The revision can submit an unsealed proposal for independent review.',
    scope: 'The existing resubmit lifecycle only.',
    completionCheck: 'The next independent review can seal the submitted proposal.',
  };

  it('accepts and forwards an unsealed proposal under the authenticated submitter identity', async () => {
    const args = tool.args.parse({ mode: 'resubmit', id: 'WI-7', acceptance });
    await call(args);
    expect(h.resubmit).toHaveBeenCalledWith({ id: 'WI-7', submittedBy: 'su-reviewer', acceptance });
  });

  it.each([
    { ...acceptance, authority: { kind: 'policy', policy: 'trusted-tool-failure-promotion' } },
    { ...acceptance, sourceRevision: 'src-v1:' + 'a'.repeat(64) },
    { ...acceptance, evidence: [] },
    { ...acceptance, completionCheck: '   ' },
  ])('refuses sealed or incomplete producer proposal input', (proposal) => {
    expect(tool.args.safeParse({ mode: 'resubmit', id: 'WI-7', acceptance: proposal }).success).toBe(false);
    expect(h.resubmit).not.toHaveBeenCalled();
  });

  it('uses the caller canonical filter, and refuses a missing inherited fleet spec', async () => {
    const filter = { not: { field: 'plan', op: 'glob', value: 'p2p-*' } };
    h.claimSpec.mockResolvedValueOnce({ source: 'fleet', fleetSlug: 'verifiers', spec: { view: { filter } } });
    const abort = new AbortController();
    await call({ mode: 'claim-next' }, { harnessSlug: 'papercusp', signal: abort.signal });
    expect(h.claimNext).toHaveBeenCalledWith({
      reviewer: 'su-reviewer', harnessSlug: 'papercusp', filter, workspaceId: undefined, signal: abort.signal,
      onDiagnostics: expect.any(Function),
    });
    h.claimNext.mockClear();
    h.claimSpec.mockResolvedValueOnce({ source: 'default', fleetSlug: 'verifiers', spec: { view: {} } });
    await expect(call({ mode: 'claim-next' }, { harnessSlug: 'papercusp' })).rejects.toThrow('valid fleet claim spec');
    expect(h.claimNext).not.toHaveBeenCalled();
  });
  it('writes claim-next diagnostics through invocation metadata', async () => {
    const diagnostics = { schemaVersion: 'agent-review-claim-next-v1', candidateCount: 2 };
    h.claimNext.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as { onDiagnostics?: (value: unknown) => void };
      input.onDiagnostics?.(diagnostics);
      return null;
    });
    const metadata = vi.fn();

    await call({ mode: 'claim-next' }, { harnessSlug: 'papercusp', metadata });

    expect(metadata).toHaveBeenCalledWith({ agentReviewClaimNext: diagnostics });
  });
  it('declares a late-completion receipt on the public mutating tool', () => {
    expect(tool.abortCompletionReceipt).toBe(agentReviewAbortCompletionReceipt);
  });

  it('names completed directed and queue claims so callers do not retry them', () => {
    const directed = agentReviewAbortCompletionReceipt(
      { mode: 'claim', id: 'WI-8' },
      dispatchResult({ ok: true, mode: 'claim', claimed: true, workItem: { id: 'WI-8' } }),
      attempt,
    );
    const next = agentReviewAbortCompletionReceipt(
      { mode: 'claim-next' },
      dispatchResult({ ok: true, mode: 'claim-next', claimed: true, workItem: { id: 'WI-9' } }),
      attempt,
    );

    expect(directed).toEqual({ status: 'recorded', effectRef: 'improvements-agent-review:claim:WI-8' });
    expect(next).toEqual({ status: 'recorded', effectRef: 'improvements-agent-review:claim-next:WI-9' });
  });

  it('reports only pre-mutation directed misses as not-recorded and fails closed on ambiguous misses', () => {
    const missing = agentReviewAbortCompletionReceipt(
      { mode: 'claim', id: 'WI-missing' },
      dispatchResult({ ok: true, mode: 'claim', claimed: false, workItem: null, reason: 'not-found' }),
      attempt,
    );
    const repairedThenRefused = agentReviewAbortCompletionReceipt(
      { mode: 'claim', id: 'WI-8' },
      dispatchResult({ ok: true, mode: 'claim', claimed: false, workItem: null, reason: 'agent-review-not-pending' }),
      attempt,
    );
    const queueMiss = agentReviewAbortCompletionReceipt(
      { mode: 'claim-next' },
      dispatchResult({ ok: true, mode: 'claim-next', claimed: false, workItem: null }),
      attempt,
    );

    expect(missing).toEqual({ status: 'not-recorded', reason: 'not-found' });
    expect(repairedThenRefused).toMatchObject({ status: 'recovery-incomplete', failures: ['ambiguous-claim-outcome'] });
    expect(queueMiss).toMatchObject({ status: 'recovery-incomplete', failures: ['ambiguous-claim-outcome'] });
  });

  it('routes adopt / adopt-next to the adoption core under the caller identity and a concrete harness (D-008)', async () => {
    h.adopt.mockResolvedValueOnce({ adopted: true, workItem: { id: 'WI-8' }, brief: { lane: 'revision-adoption' } });
    const adopted = body(await call({ mode: 'adopt', id: 'WI-8', harness: 'papercusp' }));
    expect(h.adopt).toHaveBeenCalledWith({ id: 'WI-8', adopter: 'su-reviewer', harnessSlug: 'papercusp' });
    expect(adopted).toMatchObject({ ok: true, mode: 'adopt', adopted: true, brief: { lane: 'revision-adoption' } });

    h.adoptNext.mockResolvedValueOnce({ adopted: false, workItem: null, scanned: 3, refusals: { 'not-submitter': 3 } });
    const next = body(await call({ mode: 'adopt-next', harness: 'papercusp' }));
    expect(h.adoptNext).toHaveBeenCalledWith({ adopter: 'su-reviewer', harnessSlug: 'papercusp', workspaceId: undefined });
    expect(next).toMatchObject({ ok: true, mode: 'adopt-next', adopted: false, scanned: 3 });
    expect(h.resubmit).not.toHaveBeenCalled();
  });

  it('names an adopted row and treats only a raced adoption as ambiguous', () => {
    const receipt = (args: Record<string, unknown>, value: Record<string, unknown>) =>
      agentReviewAbortCompletionReceipt(args, dispatchResult({ ok: true, mode: args.mode, ...value }), attempt);

    expect(receipt({ mode: 'adopt', id: 'WI-8' }, { adopted: true, workItem: { id: 'WI-8' } }))
      .toEqual({ status: 'recorded', effectRef: 'improvements-agent-review:adopt:WI-8' });
    expect(receipt({ mode: 'adopt-next' }, { adopted: true, workItem: { id: 'WI-9' } }))
      .toEqual({ status: 'recorded', effectRef: 'improvements-agent-review:adopt-next:WI-9' });
    expect(receipt({ mode: 'adopt', id: 'WI-8' }, { adopted: false, reason: 'not-submitter' }))
      .toEqual({ status: 'not-recorded', reason: 'not-submitter' });
    expect(receipt({ mode: 'adopt-next' }, { adopted: false, refusals: { 'not-submitter': 2 } }))
      .toEqual({ status: 'not-recorded', reason: 'no-adoptable-revision' });
    expect(receipt({ mode: 'adopt', id: 'WI-8' }, { adopted: true, workItem: { id: 'WI-9' } }))
      .toMatchObject({ status: 'recovery-incomplete', failures: ['ambiguous-adoption-outcome'] });
    expect(receipt({ mode: 'adopt', id: 'WI-8' }, { adopted: false, reason: 'state-changed' }))
      .toMatchObject({ status: 'recovery-incomplete', failures: ['ambiguous-adoption-outcome'] });
    expect(receipt({ mode: 'adopt-next' }, { adopted: false, refusals: { 'state-changed': 1 } }))
      .toMatchObject({ status: 'recovery-incomplete', failures: ['ambiguous-adoption-outcome'] });
  });

  it('names the resubmitted review round and preserves explicit no-write refusals', () => {
    const recorded = agentReviewAbortCompletionReceipt(
      { mode: 'resubmit', id: 'WI-8' },
      dispatchResult({ ok: true, mode: 'resubmit', resubmitted: true, state: { status: 'pending', round: 2 } }),
      attempt,
    );
    const refused = agentReviewAbortCompletionReceipt(
      { mode: 'resubmit', id: 'WI-8' },
      dispatchResult({ ok: true, mode: 'resubmit', resubmitted: false, reason: 'not-submitter' }),
      attempt,
    );

    expect(recorded).toEqual({ status: 'recorded', effectRef: 'improvements-agent-review:resubmit:WI-8:round:2' });
    expect(refused).toEqual({ status: 'not-recorded', reason: 'not-submitter' });
  });

  it('fails closed when a result cannot prove the requested claim identity', () => {
    const mismatched = agentReviewAbortCompletionReceipt(
      { mode: 'claim', id: 'WI-8' },
      dispatchResult({ ok: true, mode: 'claim', claimed: true, workItem: { id: 'WI-9' } }),
      attempt,
    );
    const incomplete = agentReviewAbortCompletionReceipt(
      { mode: 'resubmit', id: 'WI-8' },
      dispatchResult({ ok: true, mode: 'resubmit', resubmitted: true, state: { status: 'pending' } }),
      attempt,
    );

    expect(mismatched).toMatchObject({ status: 'recovery-incomplete', failures: ['ambiguous-claim-outcome'] });
    expect(incomplete).toMatchObject({ status: 'recovery-incomplete', failures: ['missing-effect-identity'] });
  });

  it('claims the requested second pending item without consuming the first', async () => {
    h.claim.mockResolvedValue({
      claimed: true,
      workItem: {
        id: 'WI-8',
        title: 'review me second',
        payload: { agentReview: { status: 'pending', submittedBy: 'su-filer', ledgerIdeaId: 'agent-review:WI-8', round: 1 } },
      },
    });

    const out = await call({ mode: 'claim', id: 'WI-8' }, { harnessSlug: 'papercusp' });

    expect(h.claim).toHaveBeenCalledWith({
      id: 'WI-8',
      reviewer: 'su-reviewer',
      harnessSlug: 'papercusp',
    });
    expect(h.claimNext).not.toHaveBeenCalled();
    expect(body(out)).toEqual({
      ok: true,
      mode: 'claim',
      claimed: true,
      workItem: {
        id: 'WI-8',
        title: 'review me second',
        payload: { agentReview: { status: 'pending', submittedBy: 'su-filer', ledgerIdeaId: 'agent-review:WI-8', round: 1 } },
      },
      ledgerIdeaId: 'agent-review:WI-8',
      gradeWith: { ideaId: 'agent-review:WI-8' },
      reviewHandoff: expect.objectContaining({ filingIdentity: expect.objectContaining({ submittedBy: 'su-filer' }),
        source: expect.objectContaining({ itemId: 'WI-8', title: 'review me second' }) }),
    });
  });

  it('claim-next derives reviewer identity and concrete harness from the caller context', async () => {
    h.claimNext.mockResolvedValue({
      id: 'WI-7',
      title: 'review me',
      payload: { agentReview: { status: 'pending', submittedBy: 'su-filer', ledgerIdeaId: 'agent-review:WI-7', round: 1 } },
    });

    const out = await call({ mode: 'claim-next' }, { harnessSlug: 'papercusp' });

    expect(h.claimNext).toHaveBeenCalledWith({
      reviewer: 'su-reviewer', harnessSlug: 'papercusp', filter: undefined, workspaceId: undefined, signal: undefined,
      onDiagnostics: expect.any(Function),
    });
    expect(body(out)).toEqual({
      ok: true,
      mode: 'claim-next',
      claimed: true,
      workItem: {
        id: 'WI-7',
        title: 'review me',
        payload: { agentReview: { status: 'pending', submittedBy: 'su-filer', ledgerIdeaId: 'agent-review:WI-7', round: 1 } },
      },
      ledgerIdeaId: 'agent-review:WI-7',
      gradeWith: { ideaId: 'agent-review:WI-7' },
      reviewHandoff: expect.objectContaining({ filingIdentity: expect.objectContaining({ submittedBy: 'su-filer' }),
        source: expect.objectContaining({ itemId: 'WI-7', title: 'review me' }) }),
    });
  });

  it('claim-next fails loud when no single harness is resolvable', async () => {
    const out = await call({ mode: 'claim-next' }, { harnessSlug: '*' });

    expect(out.isError).toBe(true);
    expect(body(out)).toMatchObject({ error: 'harness_required', tool: 'improvements:agent-review' });
    expect(h.claimNext).not.toHaveBeenCalled();
  });

  it('returns an explicit clean miss when the review lane is empty', async () => {
    const out = await call({ mode: 'claim-next', harness: 'other-harness' }, { harnessSlug: 'papercusp' });

    expect(h.claimNext).toHaveBeenCalledWith({
      reviewer: 'su-reviewer', harnessSlug: 'other-harness', filter: undefined,
      workspaceId: undefined, signal: undefined, onDiagnostics: expect.any(Function),
    });
    expect(body(out)).toEqual({ ok: true, mode: 'claim-next', claimed: false, workItem: null });
  });

  it('resubmit derives submittedBy from the caller and forwards only the named item', async () => {
    const out = await call({ mode: 'resubmit', id: 'WI-7' }, { harnessSlug: '*' });

    expect(h.resubmit).toHaveBeenCalledWith({ id: 'WI-7', submittedBy: 'su-reviewer' });
    expect(body(out)).toMatchObject({ ok: true, mode: 'resubmit', resubmitted: true });
  });

  // bug-queue-legitimacy D-006: a reproduction-validation claimant records its receipt here.
  it('resubmit forwards a reproduction receipt, and the schema refuses a filing-time encounter', async () => {
    const reproduction = { kind: 'failing-test', ref: 'test_runs:42', buildSha: '1234567' };
    await call({ mode: 'resubmit', id: 'WI-7', reproduction }, { harnessSlug: '*' });
    expect(h.resubmit).toHaveBeenCalledWith({ id: 'WI-7', submittedBy: 'su-reviewer', reproduction });

    expect(tool.args.safeParse({ mode: 'resubmit', id: 'WI-7', reproduction }).success).toBe(true);
    expect(tool.args.safeParse({ mode: 'resubmit', id: 'WI-7', reproduction: { ...reproduction, kind: 'encounter' } }).success)
      .toBe(false);
    expect(tool.args.safeParse({ mode: 'resubmit', id: 'WI-7', reproduction: { ...reproduction, buildSha: 'main' } }).success)
      .toBe(false);
  });

  it('is projected under its public MCP name and imported by the production registry', () => {
    const registered = lookupByMcpName('improvements:agent-review');
    expect(registered).toBeDefined();
    expect(registered!.capabilities).toContain('work_items:write');

    const registry = readFileSync(fileURLToPath(new URL('../index.ts', import.meta.url)), 'utf8');
    expect(registry).toMatch(/import\s+['"]\.\/improvements\/agent-review['"]/);
  });
});
