import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import {
  inspectFreshAmendmentReviewer, openAcceptanceBarAmendmentReview, previewThreadHasLaterPost, resolveAmendmentReviewEvidence,
  verifyAmendmentReviewCandidate, type AmendmentReviewRouteInput, type OpenAmendmentReviewInput,
} from './acceptance-bar-amendment-review';
import {
  acceptanceBarReviewPostBody, acceptanceBarReviewSourceHash,
  resolveAcceptanceBarApproval,
  validateAcceptanceBarRevisionProjectionPreview,
} from '../acceptance-bar-amendment';
import { buildAcceptanceBarSeed } from '../acceptance-bar-seed';
import type { AcceptanceBarAmendmentPreview } from '../rubrics';
import { rubricTemplateDataAuthoringSchema } from '../agent-tools/plans/rubric-template';

// Install before the static review imports load their work-item dependencies.
// A doMock in beforeAll leaves those already-cached readers on another pool.
let activeDb: OrgTestDb;
vi.mock('@papercusp/db-org', async (original) => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: activeDb.adminSql }),
}));

describe('retained BAR re-review evidence custody (EI-25992283418918681)', () => {
  let db: OrgTestDb;
  const workspaceId = 'bar-rereview-evidence';
  const refs: Record<string, string> = {};
  const base = { workspaceId, applierId: 'applier' };

  beforeAll(async () => {
    db = await createOrgTestDb();
    activeDb = db;
    for (const [key, author, body, thread, workspace, origin] of [
      ['before', 'applier', 'Old evidence', 'preview-thread', workspaceId, 'local'],
      ['preview', 'applier', 'Immutable approval JSON', 'preview-thread', workspaceId, 'local'],
      ['objection', 'judge-old', 'API timed out', 'preview-thread', workspaceId, 'local'],
      ['evidence', 'applier', 'Exact API delivered in 52.08s; verdict remains fail', 'preview-thread', workspaceId, 'local'],
      ['foreign-author', 'other', 'Not mine', 'preview-thread', workspaceId, 'local'],
      ['foreign-thread', 'applier', 'Wrong thread', 'other-thread', workspaceId, 'local'],
      ['foreign-workspace', 'applier', 'Wrong workspace', 'preview-thread', 'other-workspace', 'local'],
      ['remote', 'applier', 'Replicated evidence', 'preview-thread', workspaceId, 'remote'],
      ['empty', 'applier', '   ', 'preview-thread', workspaceId, 'local'],
      ['answer', 'judge-new', 'approve retained preview', 'preview-thread', workspaceId, 'local'],
    ]) {
      const [row] = await db.adminSql<Array<{ id: number }>>`
        INSERT INTO harness_shared.coord_thread_posts (workspace_id, thread_id, author_id, body, origin)
        VALUES (${workspace!}, ${thread!}, ${author!}, ${body!}, ${origin!}) RETURNING id`;
      refs[key!] = `thread-post:${row!.id}`;
    }
  });
  afterAll(async () => { await db?.cleanup(); });

  async function candidateFixture() {
    const plan = `---
title: Candidate
slug: candidate
status: active
created: 2026-11-06
updated: 2026-11-06
---
# Candidate
## Requirements
**R-1 — Canonical outcome.** The writer persists one canonical BAR.
## Design
### Bar-to-work map for this plan
| bar | implementing plan items | evidence plane |
|---|---|---|
| R-1 | P-001 | tree |
## Phase 1 — Build
- **P-001** \`todo\` persist the canonical BAR
`;
    const seeded = buildAcceptanceBarSeed({
      planSlug: 'candidate', planContent: plan, actorId: 'applier',
      declaredAt: '2026-11-06T00:00:00.000Z', cohort: 'post-epoch', adoptionEpoch: 1,
      subjectPlanRevision: 1, planStatus: 'active', rubricSlug: 'acceptance-candidate', rubricRevision: 1,
    });
    if (!seeded.ok) throw new Error('fixture seed failed');
    const data = rubricTemplateDataAuthoringSchema.parse(seeded.templateData);
    await db.adminSql`DELETE FROM harness_shared.harness_plans
      WHERE workspace_id = ${workspaceId} AND harness_slug = 'papercusp' AND plan_slug = 'candidate'`;
    await db.adminSql`INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug, content)
      VALUES (${workspaceId}, 'papercusp', 'candidate', ${plan})`;
    const validate = (templateData: unknown) => validateAcceptanceBarRevisionProjectionPreview(db.adminSql as never, {
      workspaceId, harnessSlug: 'papercusp', rubricSlug: 'acceptance-candidate', rubricRevision: 2,
      templateData, previousTemplateData: data,
    });
    const candidateValidation = await validate(data);
    expect(candidateValidation).toMatchObject({ generatedSpecCount: 1 });
    const approval = {
      rubricRef: 'acceptance-candidate', subjectPlan: 'candidate', proposedPatchHash: 'patch',
    } as AcceptanceBarAmendmentPreview['approval'];
    const preview = { candidateValidation, approval, approvalRequired: true, changes: [],
      rubricRevision: 1, subjectPlanRevision: 1 } as unknown as AcceptanceBarAmendmentPreview;
    const input: OpenAmendmentReviewInput = {
      rubricRef: 'acceptance-candidate', previewPostRef: refs.preview!, preview,
      identity: { ownerId: 'applier', workspaceId } as OpenAmendmentReviewInput['identity'], workspaceId,
      patch: { criteria: data.criteria },
      reviewSources: {
        rubric: { ref: 'acceptance-candidate', revision: 1, changedCriteria: [] },
        subjectPlan: { slug: 'candidate', harnessSlug: 'papercusp', revision: 1, contentHash: 'source', requirements: plan },
      },
    };
    const route = vi.fn(async () => ({ state: 'routed' as const, conversationId: 'candidate-review',
      responderId: 'independent-reviewer', screenedOut: [] }));
    // Recruitment is the counted boundary; preflight reads real migrated PG.
    const deps = { route, verifyPreviewPost: vi.fn(), verifyCandidate: (next: OpenAmendmentReviewInput) =>
      verifyAmendmentReviewCandidate(next, async (amendment) => ({
        ...preview, candidateValidation: await validate({ ...data, criteria: amendment.criteria ?? data.criteria }),
      })) };
    return { input, deps, route, data, plan, preview };
  }

  it('rejects invalid or missing observables with consolidated defects before review', async () => {
    const { input, deps, route, data } = await candidateFixture();
    for (const observation of ['', undefined]) {
      const criteria = structuredClone(data.criteria);
      Object.assign(criteria[0]!, { model: observation, driftMarkers: '', method: '', requiredScope: [''] });
      const failure = await openAcceptanceBarAmendmentReview({ ...input, patch: { criteria } }, deps)
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      for (const field of ['model', 'driftMarkers', 'method', 'requiredScope']) {
        expect((failure as Error).message).toContain(field);
      }
    }
    expect(route).not.toHaveBeenCalled();
  });

  it('rejects invalid evidence plane and runtime before review', async () => {
    const { input, deps, route, data } = await candidateFixture();
    const criteria = structuredClone(data.criteria);
    Object.assign(criteria[0]!, { evidencePlane: 'invalid', evidenceRuntime: 'invalid' });
    const failure = await openAcceptanceBarAmendmentReview({ ...input, patch: { criteria } }, deps)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('evidencePlane');
    expect((failure as Error).message).toContain('evidenceRuntime');
    expect(route).not.toHaveBeenCalled();
  });

  it('binds whole candidate preflight and review dispatch to one identity', async () => {
    const { input, deps, route, data, plan, preview } = await candidateFixture();
    const invalidCriteria = structuredClone(data.criteria);
    Object.assign(invalidCriteria[0]!, { method: '', requiredScope: [''], evidencePlane: 'invalid', evidenceRuntime: 'invalid' });
    const invalid = await openAcceptanceBarAmendmentReview({ ...input, patch: { criteria: invalidCriteria } }, deps)
      .catch((error: unknown) => error);
    expect(invalid).toBeInstanceOf(Error);
    for (const field of ['method', 'requiredScope', 'evidencePlane', 'evidenceRuntime']) {
      expect((invalid as Error).message).toContain(field);
    }
    expect(route).not.toHaveBeenCalled();

    const changedCriteria = structuredClone(data.criteria);
    changedCriteria[0]!.method = 'Read the entire canonical BAR history.';
    await expect(openAcceptanceBarAmendmentReview({ ...input, patch: { criteria: changedCriteria } }, deps))
      .rejects.toThrow('candidate_stale');
    expect(route).not.toHaveBeenCalled();
    await expect(openAcceptanceBarAmendmentReview(input, deps)).resolves.toMatchObject({ state: 'routed' });
    expect(route).toHaveBeenCalledTimes(1);

    await db.adminSql`UPDATE harness_shared.harness_plans SET content = ${plan + '\nSource changed after preflight.'}
      WHERE workspace_id = ${workspaceId} AND harness_slug = 'papercusp' AND plan_slug = 'candidate'`;
    await expect(openAcceptanceBarAmendmentReview(input, deps)).rejects.toThrow('candidate_stale');
    expect(route).toHaveBeenCalledTimes(1);
    await expect(openAcceptanceBarAmendmentReview({ ...input, preview: { ...preview, candidateValidation: undefined } }, deps))
      .rejects.toThrow('candidate_missing');
    expect(route).toHaveBeenCalledTimes(1);
  });

  it('dispatches a corrected exact candidate once', async () => {
    const { input, deps, route, data } = await candidateFixture();
    const invalid = structuredClone(data.criteria);
    Object.assign(invalid[0]!, { model: '', driftMarkers: '' });
    await expect(openAcceptanceBarAmendmentReview({ ...input, patch: { criteria: invalid } }, deps))
      .rejects.toThrow('candidate_invalid');
    expect(route).not.toHaveBeenCalled();
    const changed = structuredClone(data.criteria);
    changed[0]!.method = 'Inspect the complete canonical BAR history.';
    await expect(openAcceptanceBarAmendmentReview({ ...input, patch: { criteria: changed } }, deps))
      .rejects.toThrow('candidate_stale');
    expect(route).not.toHaveBeenCalled();
    await expect(openAcceptanceBarAmendmentReview(input, deps)).resolves.toMatchObject({ state: 'routed' });
    expect(route).toHaveBeenCalledTimes(1);
  });

  it('reads complete later evidence authored by the applier on the retained preview thread', async () => {
    expect(await resolveAmendmentReviewEvidence({ ...base, previewPostRef: refs.preview!, evidencePostRef: refs.evidence! }, db.adminSql))
      .toEqual({ postRef: refs.evidence, body: 'Exact API delivered in 52.08s; verdict remains fail' });
  });

  it.each(['before', 'preview', 'foreign-author', 'foreign-thread', 'foreign-workspace', 'remote', 'empty'])(
    'refuses evidence without the required custody: %s', async (key) => {
      await expect(resolveAmendmentReviewEvidence({ ...base, previewPostRef: refs.preview!, evidencePostRef: refs[key]! }, db.adminSql))
        .rejects.toThrow('reviewEvidencePost');
    },
  );

  it('distinguishes an old objection from an answer to the new evidence', async () => {
    const preview = { workspaceId, previewPostRef: refs.preview! };
    expect(await previewThreadHasLaterPost({ ...preview, authorId: 'judge-old' }, db.adminSql)).toBe(true);
    expect(await previewThreadHasLaterPost({ ...preview, authorId: 'judge-old', afterPostRef: refs.evidence! }, db.adminSql)).toBe(false);
    expect(await previewThreadHasLaterPost({ ...preview, authorId: 'judge-new', afterPostRef: refs.evidence! }, db.adminSql)).toBe(true);
    expect(await previewThreadHasLaterPost({ ...preview, authorId: 'other-workspace', afterPostRef: refs.evidence! }, db.adminSql)).toBe(false);
  });

  it.each(['running', 'ended_unobserved'] as const)(
    'uses the current reviewer’s answer despite a %s task and older unrelated posts', async (taskState) => {
    const records: string[] = [];
    for (const [author, body] of [['applier', 'Retained preview'], ['judge-old', 'Old objection'],
      ['applier', 'New verification evidence'], ['another-agent', 'Unrelated later note']]) {
      const [row] = await db.adminSql<Array<{ id: number }>>`
        INSERT INTO harness_shared.coord_thread_posts (workspace_id, thread_id, author_id, body, origin)
        VALUES (${workspaceId}, 're-review-recovery', ${author!}, ${body!}, 'local') RETURNING id`;
      records.push(`thread-post:${row!.id}`);
    }
    const request = { workspaceId, previewPostRef: records[0]!, reviewEvidencePost: records[2]!,
      reviewer: { state: 'launched', taskId: 'ended-reviewer', ownerId: 'judge-old' } };
    const deps = { readTaskState: async () => taskState,
      resolveSessionStates: vi.fn(async () => new Map([['judge-old', {
        sessionState: 'live', selfWake: 'loop',
      }]])) as never,
      hasLaterPost: (args: Parameters<typeof previewThreadHasLaterPost>[0]) => previewThreadHasLaterPost(args, db.adminSql) };
    expect(await inspectFreshAmendmentReviewer(request, deps)).toMatchObject({
      state: taskState === 'running' ? 'no-failure-observed' : 'reclaimable',
    });

    await db.adminSql`
      INSERT INTO harness_shared.coord_thread_posts (workspace_id, thread_id, author_id, body, origin)
      VALUES (${workspaceId}, 're-review-recovery', 'judge-old', 'approve retained preview', 'local')`;
    expect(await inspectFreshAmendmentReviewer(request, deps)).toMatchObject({ state: 'later-post' });
  });

  it('excludes requester artifact posts but preserves later reviewer activity', async () => {
    const [requesterPreview] = await db.adminSql<Array<{ id: number }>>`
      INSERT INTO harness_shared.coord_thread_posts (workspace_id, thread_id, author_id, body, origin)
      VALUES (${workspaceId}, 'requester-artifact-thread', 'applier', 'Preview approval JSON', 'local')
      RETURNING id`;
    await db.adminSql`
      INSERT INTO harness_shared.coord_thread_posts (workspace_id, thread_id, author_id, body, origin)
      VALUES (${workspaceId}, 'requester-artifact-thread', 'applier', 'Persisted request payload', 'local')`;

    const previewPostRef = `thread-post:${requesterPreview!.id}`;
    expect(await previewThreadHasLaterPost({ workspaceId, previewPostRef }, db.adminSql)).toBe(true);
    expect(await previewThreadHasLaterPost({ workspaceId, previewPostRef, excludeAuthorId: 'applier' }, db.adminSql)).toBe(false);
    expect(await previewThreadHasLaterPost({
      workspaceId,
      previewPostRef: refs.preview!,
      excludeAuthorId: 'applier',
    }, db.adminSql)).toBe(true);
  });
});

describe('retained preview recovery across generated declaration times (EI-28093704785598030)', () => {
  let db: OrgTestDb;
  const workspaceId = 'retained-preview-declaration-times';

  beforeAll(async () => {
    db = await createOrgTestDb();
    activeDb = db;
    // The compatibility view inserts through a trigger, so an outer
    // ON CONFLICT does not make repeated fixture inserts idempotent.
    await db.adminSql`INSERT INTO harness_shared.engineer_issues
      (workspace_id, issue_id, scope, title, body, state, kind, severity)
      VALUES (${workspaceId}, 'WI-300003', 'harness:papercusp', 'Pinned review source', '', 'open', 'task', 'minor')`;
    await db.adminSql`INSERT INTO harness_shared.coord_threads (workspace_id, thread_id, parent_kind, parent_ref)
      VALUES (${workspaceId}, 'retained-time-preview', 'issue', 'WI-300003')`;
  });
  afterAll(async () => {
    await db?.cleanup();
  });

  function source() {
    const existing = { key: 'r-1', barKey: 'R-1', model: 'Existing outcome',
      barProvenance: { lifecycle: 'legacy-backfilled', declaredBy: 'applier', declaredAt: '2026-11-06T00:00:00.000Z' } };
    const added = { key: 'r-2', barKey: 'R-2', model: 'Added outcome',
      barProvenance: { lifecycle: 'legacy-backfilled', declaredBy: 'applier', declaredAt: '2026-11-07T00:00:00.000Z' } };
    return { schemaVersion: 1 as const,
      rubric: { ref: 'acceptance-source-time', revision: 1,
        baseline: { criteria: [existing] }, candidate: { criteria: [structuredClone(existing), added] } },
      subjectPlan: { slug: 'source-time', harness: 'papercusp', revision: 3,
        content: 'Plan source', proposedContent: 'Plan source' },
      reason: 'Add the second outcome', mappingDelta: [] as unknown[] };
  }

  function preview(reviewSource: ReturnType<typeof source>): AcceptanceBarAmendmentPreview {
    return { approvalRequired: true, rubricRevision: 1, subjectPlanRevision: 3,
      changes: [{ barKey: 'R-2' }], criterionChanges: [], reviewSource,
      candidateValidation: { candidateHash: 'a'.repeat(64), generatedSpecCount: 1 },
      approval: { schemaVersion: 1, kind: 'acceptance-bar-amendment-approval',
        rubricRef: 'acceptance-source-time', subjectPlan: 'source-time', proposedPatchHash: 'c'.repeat(64),
        reviewSourceHash: acceptanceBarReviewSourceHash(reviewSource),
        bars: [{ barKey: 'R-2', priorBarHash: null, nextBarHash: 'b'.repeat(64) }] },
    } as unknown as AcceptanceBarAmendmentPreview;
  }

  async function fixture() {
    const reviewed = source();
    reviewed.subjectPlan.content = `Plan context ${'surrounding context 🧭 '.repeat(100)}end of complete source`;
    reviewed.subjectPlan.proposedContent = reviewed.subjectPlan.content;
    const body = acceptanceBarReviewPostBody(preview(reviewed).approval, reviewed);
    const [post] = await db.adminSql<Array<{ id: number }>>`
      INSERT INTO harness_shared.coord_thread_posts (workspace_id, thread_id, author_id, body, origin)
      VALUES (${workspaceId}, 'retained-time-preview', 'applier', ${body}, 'local') RETURNING id`;
    const current = structuredClone(reviewed);
    current.rubric.candidate.criteria[1]!.barProvenance.declaredAt = '2026-11-07T00:10:00.000Z';
    const route = vi.fn(async (_input: AmendmentReviewRouteInput) => ({ state: 'routed' as const, conversationId: 'retained-time-review',
      responderId: 'independent-reviewer', screenedOut: [] }));
    const input = (): OpenAmendmentReviewInput => ({
      rubricRef: 'acceptance-source-time', previewPostRef: `thread-post:${post!.id}`,
      preview: preview(current), workspaceId,
      identity: { ownerId: 'applier', workspaceId } as OpenAmendmentReviewInput['identity'],
      patch: { criteria: [] },
    });
    // Candidate compilation, target lookup and recruitment are outside this
    // guard. The default verifier reads the real PG post and runs the resolver.
    const deps = { route, verifyCandidate: async () => {},
      resolveSourceTarget: async () => ({ workItemId: 'WI-300003', harness: 'papercusp' }) };
    return { current, route, input, deps, reviewed, body };
  }

  it('routes the original immutable preview when only a new BAR declaration time changed', async () => {
    const { input, deps, route, reviewed } = await fixture();
    await expect(openAcceptanceBarAmendmentReview(input(), deps)).resolves.toMatchObject({ state: 'routed' });
    expect(route).toHaveBeenCalledOnce();
    const brief = route.mock.calls[0]![0].brief;
    expect(brief).toContain(`candidate/source SHA-256 ${preview(reviewed).approval.reviewSourceHash}`);
    expect(brief).not.toContain(`candidate/source SHA-256 ${input().preview.approval.reviewSourceHash}`);
  });

  it('rejects missing truncated or changed immutable review sources', async () => {
    const { input, deps, route, body } = await fixture();
    await expect(openAcceptanceBarAmendmentReview({ ...input(), previewPostRef: 'thread-post:999999999' }, deps))
      .rejects.toThrow(/acceptance_bar_/);
    for (const invalidBody of [body.slice(0, -10), body.replace('Added outcome', 'Altered outcome')]) {
      const [post] = await db.adminSql<Array<{ id: number }>>`
        INSERT INTO harness_shared.coord_thread_posts (workspace_id, thread_id, author_id, body, origin)
        VALUES (${workspaceId}, 'retained-time-preview', 'applier', ${invalidBody}, 'local') RETURNING id`;
      await expect(openAcceptanceBarAmendmentReview({ ...input(), previewPostRef: `thread-post:${post!.id}` }, deps))
        .rejects.toThrow(/acceptance_bar_review_source_/);
    }
    expect(route).not.toHaveBeenCalled();
    await expect(openAcceptanceBarAmendmentReview(input(), deps)).resolves.toMatchObject({ state: 'routed' });
    expect(route).toHaveBeenCalledOnce();
    const brief = route.mock.calls[0]![0].brief;
    const positions = ['Purpose:', 'Semantic field changes', 'Removals:', 'Dependency changes',
      'Preflight:', 'Approval identity:', 'Supporting material'].map((heading) => brief.indexOf(heading));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(brief).not.toContain('end of complete source');
  });

  it('requires persisted reviewer attestation of the original retained source before apply', async () => {
    const { input, current, reviewed } = await fixture();
    const originalHash = preview(reviewed).approval.reviewSourceHash!;
    for (const [attestation, approved] of [
      ['', false], [`verified-complete-source sha256:${'0'.repeat(64)}`, false],
      [`verified-complete-source sha256:${originalHash}`, true],
    ] as const) {
      const body = `approve ${input().previewPostRef}\n${attestation}`;
      const [row] = await db.adminSql<Array<{ id: number }>>`
        INSERT INTO harness_shared.coord_thread_posts (workspace_id, thread_id, author_id, body, origin)
        VALUES (${workspaceId}, 'retained-time-preview', 'independent-reviewer', ${body}, 'local') RETURNING id`;
      const result = resolveAcceptanceBarApproval(db.adminSql as never, {
        workspaceId, approvalRef: `thread-post:${row!.id}`, expected: preview(current).approval,
        expectedSource: current,
      });
      if (approved) await expect(result).resolves.toMatchObject({ approvedBy: 'independent-reviewer' });
      else await expect(result).rejects.toThrow('acceptance_bar_review_source_attestation_required');
    }
  });

  it.each<[string, (current: ReturnType<typeof source>) => void]>([
    ['criterion meaning', (s) => { s.rubric.candidate.criteria[1]!.model = 'Different outcome'; }],
    ['existing declaration time', (s) => { s.rubric.candidate.criteria[0]!.barProvenance.declaredAt = '2026-11-07T00:10:00.000Z'; }],
    ['new declaration author', (s) => { s.rubric.candidate.criteria[1]!.barProvenance.declaredBy = 'other'; }],
    ['plan revision', (s) => { s.subjectPlan.revision++; }],
  ])('refuses a changed %s before recruiting a reviewer', async (_name, mutate) => {
    const { current, input, deps, route } = await fixture();
    mutate(current);
    await expect(openAcceptanceBarAmendmentReview(input(), deps)).rejects.toThrow('acceptance_bar_review_source_mismatched');
    expect(route).not.toHaveBeenCalled();
  });

  it('retrieves every pinned source page after live candidate edits and refuses missing source refs', async () => {
    const { input, current, reviewed, body } = await fixture();
    current.subjectPlan.content = 'Later mutable replacement';
    const { runWithWorkspace } = await import('../workspace-als');
    const { getWorkItem } = await import('../work-items');
    await expect(runWithWorkspace(workspaceId, () => getWorkItem('WI-300003', 'papercusp')))
      .resolves.toMatchObject({ id: 'WI-300003' });
    const { default: get } = await import('../agent-tools/work_items/get');
    const sourceRef = `WI-300003#comment:${input().previewPostRef.slice('thread-post:'.length)}`;
    const read = async (offset: number, ref = sourceRef) => {
      const args = get.args.parse({ id: 'WI-300003', harness: 'papercusp',
        checkpointOnly: true, sourceRef: ref, offset, limit: 768 });
      const result = await runWithWorkspace(workspaceId, () =>
        get.handler(args, { workspaceId, uiClientId: 'applier' } as never));
      return (result as { data: { results: Array<{ ok: boolean; checkpointContentHash: string | null;
        checkpointSourceStatus: string; checkpointPage: { text: string; nextOffset: number | null } | null }> } }).data.results[0]!;
    };
    let offset: number | null = 0;
    let complete = '';
    let hash: string | null = null;
    let pages = 0;
    while (offset !== null) {
      const row = await read(offset);
      expect(row.ok, JSON.stringify(row)).toBe(true);
      expect(row.checkpointSourceStatus).toBe('resolved');
      expect(row.checkpointPage).not.toBeNull();
      if (pages > 0) expect(row.checkpointContentHash).toBe(hash);
      hash = row.checkpointContentHash;
      complete += row.checkpointPage!.text;
      offset = row.checkpointPage!.nextOffset;
      pages++;
    }
    expect(pages).toBeGreaterThan(1);
    expect(complete).toBe(body);
    expect(complete).toContain('end of complete source');
    expect(complete).not.toContain('Later mutable replacement');
    expect(complete).toContain(acceptanceBarReviewSourceHash(reviewed));
    expect(await read(0, 'WI-300003#comment:999999999')).toMatchObject({
      checkpointSourceStatus: 'unresolved', checkpointPage: null,
    });
  });
});
