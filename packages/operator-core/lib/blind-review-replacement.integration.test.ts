import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setupPlanPgFixture, seedPlan, type PlanPgFixture } from './agent-tools/plans/__tests__/_pg-tool-fixture';
import { declareSessionConfinement } from './capability-envelope/session-confinement-store';
import { BLIND_GAP_REVIEW_ACTOR } from './blind-review-session-bindings';
import { blindReviewerConfinement } from './blind-reviewer-mint';
import { replaceBlindGapReviewer, type BlindReviewReplacementDeps, type BlindReviewReplacementInput } from './blind-review-replacement';

let fx: PlanPgFixture;
let root = '';
let count = 0;
const WS = 'default';
const AUTHOR = 'su-replacement-author';
const sqlRoot = new URL('../../../libs/papercusp/libs/db/sql/', import.meta.url);
const readMigration = (name: string) => readFileSync(new URL(existsSync(new URL(name, sqlRoot)) ? name : name + '.DRAFT', sqlRoot), 'utf8');

beforeAll(async () => {
  fx = await setupPlanPgFixture({ isolated: true });
  root = await mkdtemp(path.join(tmpdir(), 'blind-replacement-pg-'));
  await writeFile(path.join(root, 'product.test.ts'), 'maintained product test');
  await writeFile(path.join(root, 'other.test.ts'), 'another existing test');
  const [protocol] = await fx.admin`SELECT 1 FROM information_schema.columns WHERE table_schema = 'harness_shared'
    AND table_name = 'plan_blind_reviews' AND column_name = 'protocol_version'`;
  if (!protocol) await fx.admin.begin(tx => tx.unsafe(readMigration('1564-blind-review-outcomes.sql')));
  const [replacement] = await fx.admin`SELECT 1 FROM information_schema.columns WHERE table_schema = 'harness_shared'
    AND table_name = 'plan_blind_review_sessions' AND column_name = 'replacement_of'`;
  if (!replacement) await fx.admin.begin(tx => tx.unsafe(readMigration('1567-blind-review-replacement-attempts.sql')));
}, 60_000);
afterAll(async () => { await fx?.dispose(); if (root) await rm(root, { recursive: true, force: true }); });

async function seed() {
  const slug = `zzz-replacement-${Date.now()}-${++count}`;
  const harness = slug;
  await seedPlan(fx.admin, WS, harness, slug, `---\ntitle: Replacement fixture\nslug: ${slug}\nstatus: active\n---\n\n## Items\n\n- **P-001** \`done\` Product behaviour.\n`);
  await fx.admin`UPDATE harness_shared.harness_plans SET owner = ${AUTHOR}
    WHERE workspace_id = ${WS} AND harness_slug = ${harness} AND plan_slug = ${slug}`;
  await fx.admin`INSERT INTO harness_shared.plan_audits
    (workspace_id, harness_slug, plan_slug, audit_seq, created_by, audit_kind, activation,
     audited_plan_revision_id, audited_plan_revision_seq, audited_plan_content_hash)
    VALUES (${WS}, ${harness}, ${slug}, 5, ${AUTHOR}, 'activation', '{}', 1, 1, ${'a'.repeat(64)})`;
  const reviewer = `su-replacement-original-${count}`;
  const [native] = await fx.admin<Array<{ id: number }>>`INSERT INTO harness_shared.adv_sessions
    (workspace_id, mode, coord_owner_id, session_id, agent, ended_at, launch_spec, launch_argv)
    VALUES (${WS}, 'omp', ${reviewer}, ${`native-original-${count}`}, 'codex', now(),
      ${fx.admin.json({ launchedBy: BLIND_GAP_REVIEW_ACTOR, headless: true, account: 'auto' } as never)}, '[]') RETURNING id`;
  const [review] = await fx.admin<Array<{ id: number }>>`INSERT INTO harness_shared.plan_blind_reviews
    (workspace_id, harness_slug, plan_slug, record_kind, activation_audit_seq, created_by, gaps, outcome, summary)
    VALUES (${WS}, ${harness}, ${slug}, 'review', 5, ${reviewer}, '[]', 'inconclusive', 'INCONCLUSIVE: access blocked') RETURNING id`;
  const confinement = blindReviewerConfinement(slug);
  const [binding] = await fx.admin<Array<{ id: number }>>`INSERT INTO harness_shared.plan_blind_review_sessions
    (workspace_id, harness_slug, plan_slug, activation_audit_seq, reviewer_owner_id, adv_session_id,
     native_session_id, launch_parent_owner, account_route, confinement_snapshot, status, review_id)
    VALUES (${WS}, ${harness}, ${slug}, 5, ${reviewer}, ${native!.id}, ${`native-original-${count}`},
      ${BLIND_GAP_REVIEW_ACTOR}, 'auto', ${fx.admin.json(confinement as never)}, 'posted', ${review!.id}) RETURNING id`;
  const input: BlindReviewReplacementInput = { workspaceId: WS, harness, slug, activationAuditSeq: 5,
    sourceReviewId: Number(review!.id), requestKey: 'corrected-manifest', productReads: { testFiles: ['product.test.ts'] },
    ctx: { workspaceId: WS, uiClientId: AUTHOR, isSuperuser: true } };
  const brief = { planSlug: slug, activationAuditSeq: 5, ownerTurns: [{ ref: 'owner:1', text: 'Exercise the product.' }], excludedRefs: [], text: 'Exercise the product.' };
  const deps: BlindReviewReplacementDeps = { sql: fx.admin as never, repoRoot: async () => root, loadBrief: async () => brief };
  return { input, deps, bindingId: Number(binding!.id), nativeId: Number(native!.id), reviewer, brief };
}

async function nativeLaunch(input: BlindReviewReplacementInput, args: Record<string, unknown>, ctx: never, key: symbol) {
  const owner = `su-replacement-new-${input.slug}`;
  const confinement = (ctx as Record<symbol, unknown>)[key];
  const declared = await declareSessionConfinement({ workspaceId: WS, ownerId: owner, confinement: confinement as never });
  expect(declared.ok).toBe(true);
  const [native] = await fx.admin<Array<{ id: number }>>`INSERT INTO harness_shared.adv_sessions
    (workspace_id, mode, coord_owner_id, session_id, agent, launch_spec, launch_argv)
    VALUES (${WS}, 'omp', ${owner}, ${`native-${input.slug}`}, 'codex',
      ${fx.admin.json({ launchedBy: BLIND_GAP_REVIEW_ACTOR, headless: true, account: 'auto' } as never)}, '[]') RETURNING id`;
  const launch = { opened: 1, partial: false, ownerIds: [owner], tasks: [{ ownerId: owner }],
    freshVerdict: { sessions: [{ ownerId: owner, advSessionId: Number(native!.id), sessionId: `native-${input.slug}` }] } };
  await fx.admin`INSERT INTO harness_shared.agent_launch_idempotency (workspace_id, idempotency_key, launched_at, launched_by, summary)
    VALUES (${WS}, ${String(args.idempotencyKey)}, ${Date.now()}, ${BLIND_GAP_REVIEW_ACTOR}, ${fx.admin.json(launch as never)})`;
  return { data: { launch } };
}

describe('same-activation replacement on private PostgreSQL', () => {
  it('serializes concurrent equivalent requests, launches once, and preserves the complete original receipt', async () => {
    const s = await seed();
    const before = await fx.admin`SELECT * FROM harness_shared.plan_blind_reviews WHERE id = ${s.input.sourceReviewId}`;
    const originalBinding = await fx.admin`SELECT * FROM harness_shared.plan_blind_review_sessions WHERE id = ${s.bindingId}`;
    const key = Symbol('confinement');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const launch = vi.fn(async (args, ctx) => { entered(); await gate; return nativeLaunch(s.input, args, ctx, key); });
    s.deps.launcher = async () => ({ handler: launch, confinementKey: key });
    const first = replaceBlindGapReviewer(s.input, s.deps);
    await started;
    const second = await replaceBlindGapReviewer({ ...s.input }, s.deps);
    expect(second).toMatchObject({ ok: true, deduped: true, attempt: { attemptSeq: 1, status: 'launching' } });
    release();
    const complete = await first;
    expect(complete).toMatchObject({ ok: true, attempt: { attemptSeq: 1, status: 'ready' } });
    expect((complete.attempt as { id: number }).id).toBe((second.attempt as { id: number }).id);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(await fx.admin`SELECT * FROM harness_shared.plan_blind_reviews WHERE id = ${s.input.sourceReviewId}`).toEqual(before);
    expect(await fx.admin`SELECT * FROM harness_shared.plan_blind_review_sessions WHERE id = ${s.bindingId}`).toEqual(originalBinding);
    expect(await replaceBlindGapReviewer({ ...s.input, productReads: { testFiles: ['other.test.ts'] } }, s.deps))
      .toMatchObject({ ok: false, error: 'request_conflict' });
  });

  it('retains failed attempts and admits a new ordered request only after a definite no-process receipt', async () => {
    const s = await seed();
    const launch = vi.fn(async () => ({ isError: true, data: { launchFailure: { stage: 'pre-spawn', processesOpened: 0 } } }));
    s.deps.launcher = async () => ({ handler: launch, confinementKey: Symbol() });
    expect(await replaceBlindGapReviewer(s.input, s.deps)).toMatchObject({ ok: true, attempt: { attemptSeq: 1, status: 'failed' } });
    expect(await replaceBlindGapReviewer(s.input, s.deps)).toMatchObject({ ok: true, deduped: true, attempt: { attemptSeq: 1 } });
    const next = await replaceBlindGapReviewer({ ...s.input, requestKey: 'retry-after-refusal' }, s.deps);
    expect(next).toMatchObject({ ok: true, attempt: { attemptSeq: 2, status: 'failed' },
      attempts: [{ attemptSeq: 1, requestKey: 'corrected-manifest' }, { attemptSeq: 2, requestKey: 'retry-after-refusal' }] });
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it('never repeats an uncertain launch, and reconciles a lost reply using the original native ledger receipt', async () => {
    const s = await seed();
    const key = Symbol('confinement');
    const launch = vi.fn(async (args, ctx) => { await nativeLaunch(s.input, args, ctx, key); throw new Error('reply lost after spawn'); });
    s.deps.launcher = async () => ({ handler: launch, confinementKey: key });
    expect(await replaceBlindGapReviewer(s.input, s.deps)).toMatchObject({ ok: true, attempt: { status: 'uncertain' } });
    expect(await replaceBlindGapReviewer({ ...s.input, requestKey: 'another-equivalent-request' }, s.deps))
      .toMatchObject({ ok: true, deduped: true, attempt: { attemptSeq: 1, status: 'ready' } });
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('keeps a no-receipt timeout reserved across retries with different request keys', async () => {
    const s = await seed();
    const launch = vi.fn(async () => { throw new Error('unknown spawn outcome'); });
    s.deps.launcher = async () => ({ handler: launch, confinementKey: Symbol() });
    await replaceBlindGapReviewer(s.input, s.deps);
    const repeated = await replaceBlindGapReviewer({ ...s.input, requestKey: 'retry' }, s.deps);
    expect(repeated).toMatchObject({ ok: true, deduped: true, attempt: { attemptSeq: 1, status: 'uncertain' } });
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('refuses unauthorized, forged-owner, stale-activation, missing-source and missing-path requests before launch', async () => {
    const s = await seed();
    const launch = vi.fn();
    s.deps.launcher = async () => ({ handler: launch, confinementKey: Symbol() });
    const stranger = { workspaceId: WS, principal: { kind: 'agent', slug: 'su-stranger', workspaceId: WS }, ownerId: AUTHOR };
    expect(await replaceBlindGapReviewer({ ...s.input, ctx: stranger }, s.deps)).toMatchObject({ ok: false, error: 'recruiter_only' });
    expect(await replaceBlindGapReviewer({ ...s.input, activationAuditSeq: 4 }, s.deps)).toMatchObject({ ok: false, error: 'activation_audit_mismatch' });
    expect(await replaceBlindGapReviewer({ ...s.input, sourceReviewId: 123456789 }, s.deps)).toMatchObject({ ok: false, error: 'source_review_mismatch' });
    expect(await replaceBlindGapReviewer({ ...s.input, productReads: { testFiles: ['missing.test.ts'] } }, s.deps)).toMatchObject({ ok: false, error: 'invalid_product_reads' });
    expect(launch).not.toHaveBeenCalled();
  });

  it.each(['live', 'resuming', 'conclusive'])('rechecks %s protection at the transaction boundary', async kind => {
    const s = await seed();
    const launch = vi.fn();
    s.deps.launcher = async () => ({ handler: launch, confinementKey: Symbol() });
    s.deps.loadBrief = async () => {
      if (kind === 'live') await fx.admin`UPDATE harness_shared.adv_sessions SET ended_at = NULL WHERE id = ${s.nativeId}`;
      if (kind === 'resuming') await fx.admin`UPDATE harness_shared.adv_sessions SET resume_claim_key = 'active' WHERE id = ${s.nativeId}`;
      if (kind === 'conclusive') {
        // Material is append-only: swap the source binding to a separately posted
        // conclusive receipt rather than editing any old review.
        const [review] = await fx.admin<Array<{ id: number }>>`INSERT INTO harness_shared.plan_blind_reviews
          (workspace_id, harness_slug, plan_slug, record_kind, activation_audit_seq, created_by, outcome)
          VALUES (${WS}, ${s.input.harness}, ${s.input.slug}, 'review', 5, ${s.reviewer}, 'conclusive') RETURNING id`;
        s.input.sourceReviewId = Number(review!.id);
        await fx.admin`UPDATE harness_shared.plan_blind_review_sessions SET review_id = ${s.input.sourceReviewId} WHERE id = ${s.bindingId}`;
      }
      return s.brief;
    };
    expect(await replaceBlindGapReviewer(s.input, s.deps)).toMatchObject({ ok: false, error: 'review_protected' });
    expect(launch).not.toHaveBeenCalled();
  });
});
