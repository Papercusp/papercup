/** Real schema and independence screen; only the org connection is isolated. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type postgres from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { runWithWorkspace } from '../workspace-als';
import { seedAcceptanceBarsInTransaction } from '../acceptance-bar-seed';
import { hashPlanContent } from '../agent-tools/plans/content-hash';
import { verifyMethodReviewAnswer } from './get-feedback-prod';
import { verifyNativeMethodAuthority } from '../../test/native-method-authority';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async original => ({
  ...await original<typeof import('@papercusp/db-org')>(), getOrgPg: () => ({ sql: h.sql }),
}));

describe('retained method review authority on migrated PostgreSQL', () => {
  let db: OrgTestDb;
  beforeAll(async () => { db = await createOrgTestDb(); h.sql = db.adminSql; }, 120_000);
  afterAll(async () => { await db?.cleanup(); });

  async function fixture() {
    const workspaceId = 'method-' + randomUUID();
    const harnessSlug = 'papercusp'; const subjectPlan = 'native-method';
    const conversationId = 'method-consult'; const threadId = 'method-thread';
    const fingerprint = 'a'.repeat(64); const subjectRef = 'native-proof:' + fingerprint;
    const content = `---\ntitle: Native method\nslug: ${subjectPlan}\nstatus: active\n---\n\n## Requirements\n\n**R-1 — Native outcome.** The native outcome holds.\n\n## Design\n\n### Bar-to-work map for this plan\n\n| bar | implementing plan items | evidence plane |\n|---|---|---|\n| R-1 | P-010 | tree |\n\n## Work\n\n- **P-010** \`todo\` native outcome\n`;
    await db.adminSql`INSERT INTO harness_shared.harness_plans
      (workspace_id,harness_slug,plan_slug,content,content_hash,version,title,status,owner,
       acceptance_bar_epoch,acceptance_bar_cohort)
      VALUES (${workspaceId},${harnessSlug},${subjectPlan},${content},${hashPlanContent(content)},1,
        'Native method','active','implementer',1,'post-epoch')`;
    await db.adminSql`INSERT INTO harness_shared.plan_items
      (workspace_id,harness_slug,plan_slug,item_id,seq,status,item_text)
      VALUES (${workspaceId},${harnessSlug},${subjectPlan},'P-010',1,'todo','native outcome')`;
    const seeded = await db.adminSql.begin(tx => seedAcceptanceBarsInTransaction({
      executor: tx as never, workspaceId, harnessSlug, planSlug: subjectPlan,
      planContent: content, planTitle: 'Native method', planStatus: 'active', planVersion: 1,
      adoptionEpoch: 1, cohort: 'post-epoch', classRef: 'plan-class-feature-ship', actorId: 'rubric-author',
      now: new Date('2026-11-17T00:00:00Z'),
    }));
    if (!seeded.ok) throw new Error(seeded.message);
    await db.adminSql`INSERT INTO harness_shared.coord_conversations
      (workspace_id,id,kind,scope,harness_slug,asker_id)
      VALUES (${workspaceId},${conversationId},'consult','harness',${harnessSlug},'applier')`;
    await db.adminSql`INSERT INTO harness_shared.coord_threads
      (workspace_id,thread_id,parent_kind,parent_ref)
      VALUES (${workspaceId},${threadId},'conversation',${conversationId})`;
    const [post] = await db.adminSql<Array<{ id: number }>>`INSERT INTO harness_shared.coord_thread_posts
      (workspace_id,thread_id,author_id,body)
      VALUES (${workspaceId},${threadId},'answerer',${'approve ' + subjectRef}) RETURNING id`;
    const postId = post!.id;
    await db.adminSql`INSERT INTO harness_shared.consult_post_meta
      (workspace_id,post_id,conversation_id,author_id,kind,evidence)
      VALUES (${workspaceId},${postId},${conversationId},'answerer','answer',
        ${JSON.stringify([{ session_id: 'review-transcript', turn_idx: 1 }])}::jsonb)`;
    await db.adminSql`INSERT INTO harness_shared.consult_state
      (workspace_id,conversation_id,requester_id,state,question,routing,outcome,dispatch_attempts)
      VALUES (${workspaceId},${conversationId},'applier','closed_answered','Review exact method',
        ${JSON.stringify({ policy: 'method-review', methodReviewRubricRef: seeded.rubricSlug })}::jsonb,
        ${JSON.stringify({ review: { version: 1, answers: [{ postId, reviewerId: 'answerer', subjectRef,
          coverage: 'complete', at: '2026-11-17T00:00:00Z' }], findings: [], dispositions: [] } })}::jsonb,
        ${JSON.stringify([{ sourceOwnerId: 'expert', answeringOwnerId: 'answerer', dispatched: true }])}::jsonb)`;
    return { workspaceId, harnessSlug, subjectPlan, fingerprint, reviewRef: 'thread-post:' + postId,
      postId, conversationId, threadId, rubricId: seeded.rubricSlug };
  }

  it('reads the exact local approval under its explicit workspace despite another ambient scope', async () => {
    const f = await fixture();
    await expect(runWithWorkspace('foreign-ambient', () => verifyMethodReviewAnswer(f)))
      .resolves.toMatchObject({ fingerprint: f.fingerprint, sourceOwnerId: 'expert', answeringOwnerId: 'answerer' });
  });
  it.each([false, true])('pins the real child and nested rubric reads to the durable authority plane (related=%s)', async related => {
    const f = await fixture();
    if (related) await db.adminSql`INSERT INTO harness_shared.adv_sessions
      (workspace_id,mode,coord_owner_id,launch_spec)
      VALUES (${f.workspaceId},'console','answerer',${JSON.stringify({ launchedBy: 'implementer' })}::jsonb)`;
    const { postId: _post, conversationId: _conversation, threadId: _thread, rubricId: _rubric, ...input } = f;
    const result = verifyNativeMethodAuthority(resolve(import.meta.dirname, '../../../..'), input, { env: {
      ...process.env, PAPERCUSP_TEST_RUNS_DB_URL: db.adminDsn,
      HARNESS_ADMIN_DATABASE_URL: 'postgresql://invalid-product:1/disposable',
      HARNESS_DATABASE_URL: 'postgresql://invalid-product:1/disposable', DATABASE_URL: 'postgresql://invalid-product:1/disposable',
    } });
    if (related) await expect(result).rejects.toThrow('method_review_identity_ineligible');
    else await expect(result).resolves.toMatchObject({ targetSource: 'env', review: { fingerprint: f.fingerprint } });
  }, 45_000);
  it('cannot approve from the product database when the durable authority has no answer', async () => {
    const f = await fixture();
    const durable = await createOrgTestDb();
    try {
      // The ambient product reader really can approve; the fresh reader must
      // still refuse because its explicitly selected authority has no record.
      await expect(verifyMethodReviewAnswer(f)).resolves.toMatchObject({ fingerprint: f.fingerprint });
      await expect(verifyNativeMethodAuthority(resolve(import.meta.dirname, '../../../..'), {
        workspaceId: f.workspaceId, harnessSlug: f.harnessSlug, subjectPlan: f.subjectPlan,
        fingerprint: f.fingerprint, reviewRef: f.reviewRef,
      }, { env: { ...process.env, PAPERCUSP_TEST_RUNS_DB_URL: durable.adminDsn,
        HARNESS_ADMIN_DATABASE_URL: db.adminDsn, HARNESS_DATABASE_URL: db.adminDsn, DATABASE_URL: db.adminDsn,
      } })).rejects.toThrow('method_review_answer_missing_or_superseded');
    } finally { await durable.cleanup(); }
  }, 45_000);
  it.each(['thread-parent', 'remote-post', 'meta-author', 'meta-conversation', 'missing-meta'])
    ('refuses a broken canonical %s join', async kind => {
      const f = await fixture();
      if (kind === 'thread-parent') await db.adminSql`UPDATE harness_shared.coord_threads
        SET parent_ref = 'another' WHERE workspace_id = ${f.workspaceId}`;
      if (kind === 'remote-post') await db.adminSql`UPDATE harness_shared.coord_thread_posts
        SET origin = 'remote' WHERE id = ${f.postId}`;
      if (kind === 'meta-author') await db.adminSql`UPDATE harness_shared.consult_post_meta
        SET author_id = 'substituted' WHERE workspace_id = ${f.workspaceId}`;
      if (kind === 'meta-conversation') await db.adminSql`UPDATE harness_shared.consult_post_meta
        SET conversation_id = 'another' WHERE workspace_id = ${f.workspaceId}`;
      if (kind === 'missing-meta') await db.adminSql`DELETE FROM harness_shared.consult_post_meta
        WHERE workspace_id = ${f.workspaceId}`;
      await expect(verifyMethodReviewAnswer(f)).rejects.toThrow('method_review_answer_missing_or_superseded');
    });
  it('refuses an original answer after a later canonical answer', async () => {
    const f = await fixture();
    const [later] = await db.adminSql<Array<{ id: number }>>`INSERT INTO harness_shared.coord_thread_posts
      (workspace_id,thread_id,author_id,body) VALUES (${f.workspaceId},${f.threadId},'answerer','Revised review') RETURNING id`;
    await db.adminSql`INSERT INTO harness_shared.consult_post_meta
      (workspace_id,post_id,conversation_id,author_id,kind)
      VALUES (${f.workspaceId},${later!.id},${f.conversationId},'answerer','answer')`;
    await expect(verifyMethodReviewAnswer(f)).rejects.toThrow('method_review_answer_missing_or_superseded');
  });
  it.each(['workspace', 'harness', 'plan'])('refuses a different requested %s', async kind => {
    const f = await fixture();
    await expect(verifyMethodReviewAnswer({ ...f,
      ...(kind === 'workspace' ? { workspaceId: 'foreign-workspace' }
        : kind === 'harness' ? { harnessSlug: 'foreign-harness' } : { subjectPlan: 'foreign-plan' }),
    })).rejects.toThrow(/method_review_/);
  });
  it.each(['expert', 'answerer'])('rejects %s lineage related to the plan implementer', async owner => {
    const f = await fixture();
    await db.adminSql`INSERT INTO harness_shared.adv_sessions
      (workspace_id,mode,coord_owner_id,launch_spec)
      VALUES (${f.workspaceId},'console',${owner},${JSON.stringify({ launchedBy: 'implementer' })}::jsonb)`;
    await expect(verifyMethodReviewAnswer(f)).rejects.toThrow('method_review_identity_ineligible');
  });
  it('rejects the same subject slug in another rubric subject harness', async () => {
    const f = await fixture();
    await db.adminSql`INSERT INTO harness_shared.harness_plans
      (workspace_id,harness_slug,plan_slug,content,content_hash,version,title,status,owner)
      VALUES (${f.workspaceId},'foreign-harness',${f.subjectPlan},'',md5('foreign'),1,'Other plan','active','other-owner')`;
    await db.adminSql`UPDATE harness_shared.harness_plans SET template_data =
      jsonb_set(template_data,'{subjectHarnessSlug}','"foreign-harness"'::jsonb)
      WHERE workspace_id = ${f.workspaceId} AND plan_slug = ${f.rubricId}`;
    await expect(verifyMethodReviewAnswer(f)).rejects.toThrow('method_review_subject_plan_mismatch');
  });
});
