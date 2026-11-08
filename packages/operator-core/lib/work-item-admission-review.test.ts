import { createHmac } from 'node:crypto';
import type { Sql } from 'postgres';
import { describe, expect, it, vi } from 'vitest';

type Candidate = {
  feature_id: string;
  request: unknown;
  attemptedAtMs: number | null;
  receiptId: string | null;
  guardReceipt?: unknown;
};

const mocks = vi.hoisted(() => ({
  getPresence: vi.fn(),
  latestFleetMembership: vi.fn(),
  readVerifiedRecoveryTarget: vi.fn(),
  readSnapshots: vi.fn(),
  authorizeReplay: vi.fn(),
  runPromoter: vi.fn(),
}));

vi.mock('./operator-secret-key', () => ({
  decodeOperatorSecretKey: () => Buffer.from('unit-review-key'),
}));
vi.mock('./agent-tools/coordination/presence', () => ({ getPresence: mocks.getPresence }));
vi.mock('./fleet-membership-store', () => ({ latestFleetMembership: mocks.latestFleetMembership }));
vi.mock('./work-item-admission-recovery', async importOriginal => ({
  ...(await importOriginal<typeof import('./work-item-admission-recovery')>()),
  readVerifiedAdmissionRecoveryTarget: mocks.readVerifiedRecoveryTarget,
}));
vi.mock('./work-item-admission-authority', async importOriginal => ({
  ...(await importOriginal<typeof import('./work-item-admission-authority')>()),
  authorizeAdmissionReviewReplay: mocks.authorizeReplay,
}));
vi.mock('./work-items-admission-promoter', () => ({
  WORK_ITEM_ADMISSION_PROMOTER: 'work-item-admission-promoter',
  admissionReviewSubjectEligible: vi.fn(() => true),
  readAdmissionMergeSnapshots: mocks.readSnapshots,
  runWorkItemAdmissionPromoter: mocks.runPromoter,
}));

import { runAdmissionReviews } from './work-item-admission-review';

type ReviewPromoterInput = {
  sql: Sql;
  reviewOnly: {
    itemId: string;
    beforeWrite: (tx: Sql) => Promise<void>;
    afterWrite: (tx: Sql) => Promise<void>;
    afterGuardRefusal?: (
      tx: Sql,
      refusals: readonly { itemId: string; canonicalId: string | null; reason: string; detail: string }[],
      dependencies: readonly { itemId: string; fingerprint: string }[],
    ) => Promise<void>;
  };
};

const canonical = (value: unknown): string => JSON.stringify(value, (_key, part) =>
  part && typeof part === 'object' && !Array.isArray(part)
    ? Object.fromEntries(Object.entries(part).sort(([a], [b]) => a.localeCompare(b))) : part);

const makeValidRequest = (sequence: number, featureId: string) => {
  const unsigned = {
    version: 1,
    requestId: '00000000-0000-4000-8000-' + String(sequence).padStart(12, '0'),
    caller: 'su-reviewer',
    purpose: 'admission-review',
    routineId: 'rt-test-reviewer',
    authority: {
      kind: 'superuser',
      credentialSha256: 'a'.repeat(64),
      role: 'operator',
      context: {
        workspaceId: 'ws-test',
        harnessSlug: 'papercusp',
        profile: 'engineer',
        runId: 'run-review-test',
        spawnId: 'spawn-review-test',
        parentSpawnId: null,
        chunkId: null,
        featureId: null,
        planRunSessionId: null,
        transport: 'mcp',
      },
    },
    requestedAt: '2026-11-03T00:00:00.000Z',
  };
  const scope = { workspaceId: 'ws-test', harnessSlug: 'papercusp', workItemId: featureId };
  const signature = createHmac('sha256', 'unit-review-key')
    .update(canonical(['admission-review-v1', scope, unsigned])).digest('hex');
  return { ...unsigned, signature };
};

const makeReviewSql = (candidates: Candidate[], selectedIds: readonly string[]) => {
  const writes: Array<{ query: string; values: unknown[] }> = [];
  let clock = 1_800_000_000_000;
  const sql = Object.assign(vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const query = parts.join('?').replace(/\s+/g, ' ').trim();
    writes.push({ query, values });
    if (query.startsWith("SELECT feature_id, payload->'_admissionReviewRequest' AS request")) {
      return candidates.filter(candidate => selectedIds.includes(candidate.feature_id) &&
        (candidate.receiptId === null ||
          (candidate.guardReceipt as { guardDisposition?: { outcome?: string } } | undefined)
            ?.guardDisposition?.outcome === 'guard-refused'))
        .map(({ feature_id, request, guardReceipt }) => ({ feature_id, request, receipt: guardReceipt ?? null }));
    }
    if (query.startsWith('UPDATE harness_shared.work_items') &&
        query.includes('_admissionReviewLastAttemptAtMs')) {
      const candidate = candidates.find(row => values.includes(row.feature_id));
      expect(candidate).toBeDefined();
      expect(values).toContain(JSON.stringify(candidate!.request));
      candidate!.attemptedAtMs = clock++;
      return [{ feature_id: candidate!.feature_id, receipt: candidate!.guardReceipt ?? null }];
    }
    if (query.startsWith('SELECT value_b64 FROM harness_shared.operator_secrets')) {
      return [{ value_b64: 'dW5pdC1yZXZpZXcta2V5' }];
    }
    if (query.startsWith('SELECT id FROM harness_shared.routines')) return [{ id: 'rt-test-reviewer' }];
    if (query.startsWith('SELECT DISTINCT agent_id, fleet_slug FROM harness_shared.fleet_assignment')) return [];
    if (query.startsWith('UPDATE harness_shared.work_items') &&
        query.includes('_admissionReviewReceipt')) {
      const candidate = candidates.find(row => values.includes(row.feature_id));
      const receiptText = values.find(value => typeof value === 'string' && value.includes('"requestId"'));
      expect(candidate).toBeDefined();
      expect(receiptText).toBeDefined();
      candidate!.guardReceipt = JSON.parse(String(receiptText));
      candidate!.receiptId = (candidate!.guardReceipt as { requestId: string }).requestId;
      return [{ feature_id: candidate!.feature_id }];
    }
    throw new Error('unexpected admission-review SQL: ' + query);
  }), {
    typed: vi.fn((value: string) => value),
  }) as unknown as Sql;
  return { sql, writes };
};

describe('admission review queue fairness', () => {
  it('reaches a later valid request after refused rows without issuing receipts for refusals', async () => {
    const validFeatureId = 'EI-review-34';
    const validRequest = makeValidRequest(34, validFeatureId);
    const candidates: Candidate[] = Array.from({ length: 39 }, (_, index) => ({
      feature_id: 'EI-review-' + String(index + 1).padStart(2, '0'),
      // Missing requestId is malformed and must stay fail-closed. It also models
      // an eligible row that remains outstanding after preflight refuses it.
      request: index === 33 ? validRequest : { version: 1, purpose: 'admission-review' },
      attemptedAtMs: null,
      receiptId: null,
    }));
    mocks.getPresence.mockImplementation(async (ownerId: string) => ({
      ownerId, revoked: false, workspaceId: 'ws-test',
    }));
    mocks.readSnapshots.mockImplementation(async (_sql: unknown, selection: { ids: string[] }) =>
      new Map(selection.ids.map(id => {
        const candidate = candidates.find(row => row.feature_id === id);
        const request = candidate?.request as { caller?: string } | undefined;
        return [id, {
          fingerprint: 'fingerprint:' + id,
          assignee: request?.caller,
          payload: { _admissionReviewRequest: candidate?.request },
        }];
      })));
    mocks.authorizeReplay.mockResolvedValue(7);
    mocks.runPromoter.mockImplementation(async (...args) => {
      const input = args[0] as ReviewPromoterInput;
      await input.reviewOnly.beforeWrite(input.sql);
      await input.reviewOnly.afterWrite(input.sql);
      return { reviewedItemId: input.reviewOnly.itemId };
    });
    let clock = 1_800_000_000_000;

    const sql = Object.assign(vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const query = parts.join('?').replace(/\s+/g, ' ').trim();
      if (query.startsWith("SELECT feature_id, payload->'_admissionReviewRequest' AS request")) {
        const orderBy = query.indexOf('ORDER BY');
        const markerOrder = query.indexOf("payload->>'_admissionReviewLastAttemptAtMs'");
        expect(orderBy).toBeGreaterThanOrEqual(0);
        expect(markerOrder).toBeGreaterThan(orderBy);
        expect(query).toContain('NULLS FIRST');
        expect(query).toContain('feature_id LIMIT 20');

        return candidates
          .filter(candidate => candidate.receiptId === null ||
            (candidate.guardReceipt as { guardDisposition?: { outcome?: string } } | undefined)
              ?.guardDisposition?.outcome === 'guard-refused')
          .sort((a, b) => {
            if (a.attemptedAtMs === null && b.attemptedAtMs !== null) return -1;
            if (a.attemptedAtMs !== null && b.attemptedAtMs === null) return 1;
            return (a.attemptedAtMs ?? 0) - (b.attemptedAtMs ?? 0) ||
              a.feature_id.localeCompare(b.feature_id);
          })
          .slice(0, 20)
          .map(({ feature_id, request, guardReceipt }) => ({ feature_id, request, receipt: guardReceipt ?? null }));
      }

      if (query.startsWith('UPDATE harness_shared.work_items') &&
          query.includes('_admissionReviewLastAttemptAtMs')) {
        const candidate = candidates.find(row => values.includes(row.feature_id));
        expect(candidate).toBeDefined();
        expect(values).toContain(JSON.stringify(candidate!.request));
        candidate!.attemptedAtMs = clock++;
        return [{ feature_id: candidate!.feature_id, receipt: candidate!.guardReceipt ?? null }];
      }

      if (query.startsWith('SELECT value_b64 FROM harness_shared.operator_secrets')) {
        return [{ value_b64: 'dW5pdC1yZXZpZXcta2V5' }];
      }
      if (query.startsWith('SELECT id FROM harness_shared.routines')) return [{ id: 'rt-test-reviewer' }];

      if (query.startsWith('UPDATE harness_shared.work_items') &&
          query.includes('_admissionReviewReceipt')) {
        const candidate = candidates.find(row => values.includes(row.feature_id));
        const receiptText = values.find(value => typeof value === 'string' && value.includes('"requestId"'));
        expect(candidate).toBeDefined();
        expect(receiptText).toBeDefined();
        candidate!.guardReceipt = JSON.parse(String(receiptText));
        candidate!.receiptId = (candidate!.guardReceipt as { requestId: string }).requestId;
        return [{ feature_id: candidate!.feature_id }];
      }

      throw new Error('unexpected admission-review SQL: ' + query);
    }), {
      typed: vi.fn((value: string) => value),
    }) as unknown as Sql;

    const options = { workspaceId: 'ws-test', harnessSlug: 'papercusp', runId: 'review-rotation' };
    const llmCall = vi.fn() as never;
    const first = await runAdmissionReviews(options, sql, llmCall);
    const second = await runAdmissionReviews(options, sql, llmCall);
    const validCandidate = candidates.find(row => row.feature_id === validFeatureId)!;

    expect(first.result).toBeNull();
    expect(first.guardRefusals.map(row => row.itemId)).toEqual(
      candidates.slice(0, 20).map(row => row.feature_id),
    );
    expect(second.guardRefusals.map(row => row.itemId)).toEqual(
      candidates.slice(20, 33).map(row => row.feature_id),
    );
    expect(second.reviewedItemId).toBe(validFeatureId);
    expect(second.result).toEqual({ reviewedItemId: validFeatureId });
    expect(mocks.runPromoter).toHaveBeenCalledTimes(1);
    expect(validCandidate.attemptedAtMs).not.toBeNull();
    expect(validCandidate.receiptId).toBe(validRequest.requestId);
    expect(candidates.filter(row => row !== validCandidate).every(row => row.receiptId === null)).toBe(true);
  });
});

describe('signed admission review recovery', () => {
  const workspaceId = 'ws-test';
  const harnessSlug = 'papercusp';
  const featureId = 'EI-review-signed-original';
  const neighborId = 'EI-review-protected-neighbor';
  const scope = { workspaceId, harnessSlug, workItemId: featureId };

  const prepare = (candidates: Candidate[], targetReads: Array<string | null>) => {
    mocks.getPresence.mockReset().mockImplementation(async (ownerId: string) => ({
      ownerId, revoked: false, workspaceId,
    }));
    mocks.latestFleetMembership.mockReset().mockResolvedValue(null);
    mocks.readVerifiedRecoveryTarget.mockReset().mockImplementation(async () => targetReads.shift() ?? null);
    mocks.authorizeReplay.mockReset().mockResolvedValue(7);
    mocks.readSnapshots.mockReset().mockImplementation(async (_sql: unknown, selection: { ids: string[] }) =>
      new Map(selection.ids.map(id => {
        const candidate = candidates.find(row => row.feature_id === id);
        return [id, {
          fingerprint: 'fingerprint:' + id,
          assignee: null,
          payload: { _admissionReviewRequest: candidate?.request },
        }];
      })));
    mocks.runPromoter.mockReset().mockImplementation(async (...args) => {
      const input = args[0] as ReviewPromoterInput & { targetItemIds: string[] };
      await input.reviewOnly.beforeWrite(input.sql);
      await input.reviewOnly.afterWrite(input.sql);
      return { reviewedItemId: input.reviewOnly.itemId };
    });
  };

  it('allows the live signed target to request review of only its unassigned original', async () => {
    const request = makeValidRequest(40, featureId);
    const candidates: Candidate[] = [
      { feature_id: featureId, request, attemptedAtMs: null, receiptId: null },
      { feature_id: neighborId, request: { version: 1 }, attemptedAtMs: null, receiptId: null },
    ];
    prepare(candidates, ['su-reviewer', 'su-reviewer']);
    const { sql, writes } = makeReviewSql(candidates, [featureId]);

    const result = await runAdmissionReviews(
      { workspaceId, harnessSlug, runId: 'signed-review', targetItemIds: [featureId] },
      sql,
      vi.fn() as never,
    );

    expect(result.reviewedItemId).toBe(featureId);
    expect(mocks.readVerifiedRecoveryTarget).toHaveBeenCalledTimes(2);
    expect(mocks.latestFleetMembership).not.toHaveBeenCalled();
    expect(mocks.runPromoter).toHaveBeenCalledTimes(1);
    expect((mocks.runPromoter.mock.calls[0]![0] as { targetItemIds: string[] }).targetItemIds).toEqual([featureId]);
    expect(candidates[0]!.receiptId).toBe(request.requestId);
    expect(candidates[1]!.attemptedAtMs).toBeNull();
    expect(candidates[1]!.receiptId).toBeNull();
    const receiptWrite = writes.find(write => write.query.includes("'{_admissionReviewReceipt}',"));
    expect(receiptWrite).toBeDefined();
    expect(receiptWrite!.values).toContain(featureId);
    expect(mocks.readVerifiedRecoveryTarget).toHaveBeenCalledWith(scope, sql);
  });

  it.each([1, 3])('reviews a changed dependency after %i unrelated protected components in the same pass', async (heldCount) => {
    const dependencyId = 'EI-review-changed-dependency';
    const request = makeValidRequest(50, featureId);
    const heldIds = Array.from({ length: heldCount }, (_, index) => 'EI-review-held-' + index);
    const candidates: Candidate[] = [
      ...heldIds.map((id, index) => ({
        feature_id: id, request: makeValidRequest(60 + index, id), attemptedAtMs: null, receiptId: null,
      })),
      {
        feature_id: featureId, request, attemptedAtMs: null, receiptId: request.requestId,
        guardReceipt: {
          requestId: request.requestId,
          guardDisposition: {
            schemaVersion: 1, outcome: 'guard-refused', policyRevision: canonical(7),
            retryAfterMs: Date.now() + 30 * 60 * 1000,
            guardRefusals: [{ itemId: featureId, canonicalId: null, reason: 'review-gated', detail: 'dependency pending' }],
            dependencies: [{ itemId: dependencyId, fingerprint: 'dependency-pending' }],
          },
        },
      },
    ];
    const requestsBefore = structuredClone(candidates.map(candidate => candidate.request));
    prepare(candidates, Array(20).fill('su-reviewer'));
    mocks.readSnapshots.mockImplementation(async (_sql: unknown, selection: { ids: string[] }) =>
      new Map(selection.ids.map(id => [id, {
        fingerprint: id === dependencyId ? 'dependency-approved' : 'subject:' + id,
        assignee: null,
        payload: { _admissionReviewRequest: candidates.find(candidate => candidate.feature_id === id)?.request },
      }])));
    const { sql, writes } = makeReviewSql(candidates, [...heldIds, featureId]);
    const refusals = heldIds.map(id => ({
      itemId: id, canonicalId: null, reason: 'review-gated', detail: 'unrelated protected component',
    }));
    mocks.runPromoter.mockImplementation(async (...args) => {
      const input = args[0] as ReviewPromoterInput;
      await input.reviewOnly.beforeWrite(input.sql);
      const refusal = refusals.find(value => value.itemId === input.reviewOnly.itemId);
      if (refusal) {
        await input.reviewOnly.afterGuardRefusal!(input.sql, [refusal], []);
        return { guardRefusals: [refusal] };
      }
      await input.reviewOnly.afterWrite(input.sql);
      return { reviewedItemId: input.reviewOnly.itemId };
    });

    const result = await runAdmissionReviews(
      { workspaceId, harnessSlug, runId: 'review-changed-dependency' }, sql, vi.fn() as never,
    );

    expect(result.reviewedItemId).toBe(featureId);
    expect(mocks.runPromoter).toHaveBeenCalledTimes(heldCount + 1);
    expect(result.guardRefusals).toEqual(refusals);
    expect(candidates.at(-1)!.guardReceipt).not.toHaveProperty('guardDisposition');
    expect(candidates.at(-1)!.receiptId).toBe(request.requestId);
    expect(candidates.slice(0, -1).every(candidate =>
      (candidate.guardReceipt as { guardDisposition: { outcome: string } }).guardDisposition.outcome === 'guard-refused',
    )).toBe(true);
    expect(candidates.map(candidate => candidate.request)).toEqual(requestsBefore);
    expect(writes.some(write => /SET admission|SET assignee|SET state/.test(write.query))).toBe(false);
  });

  it('caches a durable guard refusal until its protected dependency changes', async () => {
    const request = makeValidRequest(43, featureId);
    const candidates: Candidate[] = [
      { feature_id: featureId, request, attemptedAtMs: null, receiptId: null },
    ];
    prepare(candidates, ['su-reviewer', 'su-reviewer', 'su-reviewer', 'su-reviewer', 'su-reviewer']);
    let dependencyFingerprint = 'dependency-v1';
    mocks.readSnapshots.mockImplementation(async (_sql: unknown, selection: { ids: string[] }) =>
      new Map(selection.ids.map(id => [id, {
        fingerprint: id === neighborId ? dependencyFingerprint : 'subject-v1',
        assignee: null,
        payload: { _admissionReviewRequest: request },
      }])));
    const { sql } = makeReviewSql(candidates, [featureId]);
    const refusal = {
      itemId: featureId, canonicalId: null, reason: 'snapshot-drift',
      detail: 'reference dependency changed after judging',
    } as const;
    mocks.runPromoter.mockImplementationOnce(async (...args) => {
      const input = args[0] as ReviewPromoterInput;
      await input.reviewOnly.beforeWrite(input.sql);
      await input.reviewOnly.afterGuardRefusal!(input.sql, [refusal], [
        { itemId: neighborId, fingerprint: dependencyFingerprint },
      ]);
      return { guardRefusals: [refusal] };
    });

    const first = await runAdmissionReviews(
      { workspaceId, harnessSlug, runId: 'guard-refusal-first', targetItemIds: [featureId] },
      sql,
      vi.fn() as never,
    );
    expect(first.result?.guardRefusals).toContainEqual(refusal);
    expect(candidates[0]!.guardReceipt).toMatchObject({
      requestId: request.requestId,
      guardDisposition: {
        outcome: 'guard-refused',
        guardRefusals: [refusal],
        dependencies: [{ itemId: neighborId, fingerprint: 'dependency-v1' }],
      },
    });

    const unchanged = await runAdmissionReviews(
      { workspaceId, harnessSlug, runId: 'guard-refusal-repeat', targetItemIds: [featureId] },
      sql,
      vi.fn() as never,
    );
    expect(unchanged.result).toBeNull();
    expect(unchanged.guardRefusals).toContainEqual(refusal);
    expect(mocks.runPromoter).toHaveBeenCalledTimes(1);

    dependencyFingerprint = 'dependency-v2';
    const retried = await runAdmissionReviews(
      { workspaceId, harnessSlug, runId: 'guard-refusal-dependency-changed', targetItemIds: [featureId] },
      sql,
      vi.fn() as never,
    );
    expect(retried.result?.reviewedItemId).toBe(featureId);
    expect(mocks.runPromoter).toHaveBeenCalledTimes(2);
    expect(candidates[0]!.guardReceipt).not.toHaveProperty('guardDisposition');
    expect(candidates[0]!.receiptId).toBe(request.requestId);
  });

  it('refuses when the signed recovery target changes during model judging', async () => {
    const request = makeValidRequest(41, featureId);
    const candidates: Candidate[] = [
      { feature_id: featureId, request, attemptedAtMs: null, receiptId: null },
      { feature_id: neighborId, request: { version: 1 }, attemptedAtMs: null, receiptId: null },
    ];
    prepare(candidates, ['su-reviewer', 'su-other']);
    const { sql } = makeReviewSql(candidates, [featureId]);

    await expect(runAdmissionReviews(
      { workspaceId, harnessSlug, runId: 'signed-review-drift', targetItemIds: [featureId] },
      sql,
      vi.fn() as never,
    )).rejects.toThrow('review requester is neither current custodian nor canonical fleet leader');

    expect(mocks.readVerifiedRecoveryTarget).toHaveBeenCalledTimes(2);
    expect(mocks.runPromoter).toHaveBeenCalledTimes(1);
    expect(candidates[0]!.receiptId).toBeNull();
    expect(candidates[1]!.attemptedAtMs).toBeNull();
    expect(candidates[1]!.receiptId).toBeNull();
  });

  it.each([
    ['caller', (request: ReturnType<typeof makeValidRequest>) => ({ ...request, caller: 'su-other' }), featureId],
    ['item scope', (request: ReturnType<typeof makeValidRequest>) => request, neighborId],
  ])('refuses a signed review request rebound to a different %s', async (_label, rebind, queueId) => {
    const request = rebind(makeValidRequest(42, featureId));
    const candidates: Candidate[] = [
      { feature_id: queueId, request, attemptedAtMs: null, receiptId: null },
    ];
    prepare(candidates, ['su-reviewer']);
    const { sql } = makeReviewSql(candidates, [queueId]);

    const result = await runAdmissionReviews(
      { workspaceId, harnessSlug, runId: 'signed-review-rebound', targetItemIds: [queueId] },
      sql,
      vi.fn() as never,
    );

    expect(result.reviewedItemId).toBeUndefined();
    expect(result.guardRefusals).toHaveLength(1);
    expect(result.guardRefusals[0]!.detail).toContain('review signature does not bind this exact scope/request/purpose');
    expect(mocks.runPromoter).not.toHaveBeenCalled();
    expect(mocks.readVerifiedRecoveryTarget).not.toHaveBeenCalled();
    expect(candidates[0]!.receiptId).toBeNull();
  });
});
