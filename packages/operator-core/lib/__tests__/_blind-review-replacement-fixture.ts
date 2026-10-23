/** Scripted SQL transport for unit protocol tests. Real SQL/locking is covered by the private-PG suite. */
import { vi } from 'vitest';
import { BLIND_GAP_REVIEW_ACTOR } from '../blind-review-session-bindings';
import { replaceBlindGapReviewer, type BlindReviewReplacementDeps, type BlindReviewReplacementInput } from '../blind-review-replacement';

export function replacementFixture(repoRoot: string, testFile: string) {
  const state = {
    activation: 5, sourceStatus: 'posted', ended: true, resumeClaim: null as string | null,
    material: { id: 60, record_kind: 'review', activation_audit_seq: 5, gaps: [], dispositions: [],
      created_by: 'su-original', created_at: '2026-10-23T00:00:00.000Z', protocol_version: 2,
      outcome: 'inconclusive', summary: 'INCONCLUSIVE: could not exercise product' },
    attempts: [] as Array<Record<string, unknown>>,
    ledger: null as Record<string, unknown> | null,
  };
  const queryMock = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join(' ').replace(/\s+/g, ' ').trim().toLowerCase();
    const copy = (value: unknown) => JSON.parse(JSON.stringify(value));
    if (query.startsWith('select owner from harness_shared.harness_plans')) return [{ owner: 'su-author' }];
    if (query.includes('from harness_shared.plan_audits')) return [{ audit_seq: state.activation }];
    if (query.startsWith('select id, reviewer_owner_id, adv_session_id, status, review_id')) {
      return values[4] === 60 ? [{ id: 10, reviewer_owner_id: 'su-original', adv_session_id: 20,
        status: state.sourceStatus, review_id: 60 }] : [];
    }
    if (query.startsWith('select * from harness_shared.plan_blind_reviews')) return [copy(state.material)];
    if (query.startsWith('select id from harness_shared.plan_blind_reviews')) return [];
    if (query.includes('from harness_shared.adv_sessions')) return [{ ended_at: state.ended ? '2026-10-23' : null, resume_claim_key: state.resumeClaim }];
    if (query.startsWith('select * from harness_shared.plan_blind_review_sessions')) return copy(state.attempts);
    if (query.startsWith('insert into harness_shared.plan_blind_review_sessions')) {
      const [ws, harness, slug, activation, parent, confinement, source, seq, key, hash, caller, snapshot, launchKey] = values;
      const row = { id: 100 + state.attempts.length, workspace_id: ws, harness_slug: harness, plan_slug: slug,
        activation_audit_seq: activation, launch_parent_owner: parent, confinement_snapshot: confinement,
        replacement_of: source, attempt_seq: seq, request_key: key, request_hash: hash, requested_by: caller,
        request_snapshot: snapshot, launch_key: launchKey, status: 'launching', launch_result: null,
        reviewer_owner_id: null, adv_session_id: null, native_session_id: null, review_id: null };
      state.attempts.push(row);
      return [copy(row)];
    }
    if (query.startsWith('update harness_shared.plan_blind_review_sessions')) {
      const row = state.attempts.find(a => a.id === values[1]);
      if (!row) throw new Error('unit transport lost its attempt');
      row.launch_result = values[0];
      row.status = query.includes("set status = 'failed'") ? 'failed' : 'uncertain';
      return [];
    }
    if (query.includes('from harness_shared.agent_launch_idempotency')) return state.ledger ? [{ summary: copy(state.ledger) }] : [];
    throw new Error(`Unscripted replacement SQL: ${query}`);
  });
  const sql = Object.assign(queryMock, { json: (value: unknown) => value,
    begin: async (fn: (tx: unknown) => unknown): Promise<unknown> => fn(queryMock) });
  const input: BlindReviewReplacementInput = { workspaceId: 'ws-unit', harness: 'papercusp', slug: 'unit-review',
    activationAuditSeq: 5, sourceReviewId: 60, requestKey: 'request-1', productReads: { testFiles: [testFile] },
    ctx: { workspaceId: 'ws-unit', uiClientId: 'su-author', isSuperuser: true } };
  const launchSummary = { opened: 1, partial: false, ownerIds: ['su-new'], tasks: [{ ownerId: 'su-new' }],
    freshVerdict: { sessions: [{ ownerId: 'su-new', advSessionId: 30, sessionId: 'native-new' }] } };
  const launch = vi.fn(async (_args: Record<string, unknown>, _ctx: never): Promise<unknown> => ({ data: { launch: launchSummary } }));
  const bind = vi.fn(async (args: Parameters<NonNullable<BlindReviewReplacementDeps['bind']>>[0]) => {
    const row = state.attempts.find(a => a.id === args.replacementAttemptId)!;
    Object.assign(row, { status: 'ready', reviewer_owner_id: args.reviewerOwnerId,
      adv_session_id: args.advSessionId, native_session_id: args.nativeSessionId });
    return { ok: true, binding: { id: row.id } } as never;
  });
  const key = Symbol('test-confinement');
  const deps: BlindReviewReplacementDeps = { sql: sql as never,
    loadBrief: async () => ({ planSlug: input.slug, activationAuditSeq: 5, ownerTurns: [{ ref: 'owner:1', text: 'Use product' }], excludedRefs: [], text: 'Use product' }),
    repoRoot: async () => repoRoot, resolveImplementers: async () => ['su-author'], authorIdentity: async (_author, caller) => caller === 'su-author',
    lineageRelated: async () => false, bind,
    launcher: async () => ({ handler: launch, confinementKey: key }) };
  const run = (patch: Partial<BlindReviewReplacementInput> = {}) => replaceBlindGapReviewer({ ...input, ...patch }, deps);
  return { input, deps, state, run, launch, bind, launchSummary, key, sql, actor: BLIND_GAP_REVIEW_ACTOR };
}
