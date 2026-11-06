import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getLatestActivationAudit, getLatestPlanAudit, recordCurrentDiscoveryAudit,
  discoverySubjectSnapshot, type DiscoveryAuditContext } from './plan-audits';
import { cleanupPlans, seedPlan, setupPlanPgFixture, type PlanPgFixture } from './agent-tools/plans/__tests__/_pg-tool-fixture';

const harness = 'zzz-discovery-audit';
const slug = 'discovery-audit-fixture';
let fx: PlanPgFixture;
const declaration = {
  questions: [], notApplicable: 'The existing helper already establishes the small change; no material unknowns remain.',
  findings: [{ id: 'F-1', questions: [], conclusion: 'Reuse the existing helper at the missing caller.',
    evidenceRefs: ['source:helper.ts'], dispositions: [{ target: 'P-001', decision: 'reuse', reason: 'Current source covers the implementation.' }] }],
};
const draft = `---\nslug: ${slug}\nstatus: draft\n---\n# Draft\n\n## Now\nDraft\n\n## Phase 1\n\n- **P-001** \`todo\` Wire the existing helper\n\n## Discovery\n\n\`\`\`discovery\n${JSON.stringify(declaration)}\n\`\`\`\n`;
const context = async (): Promise<DiscoveryAuditContext> => ({
  targets: [{ ref: 'P-001', change: 'proposed' }],
  evidence: [{ ref: 'source:helper.ts', state: 'current', usable: true, fingerprint: 'a'.repeat(64) }],
});
const input = () => ({ workspaceId: fx.workspaceId, harnessSlug: harness, planSlug: slug, createdBy: 'su-discovery-test' });
async function revision(content = draft) {
  const hash = createHash('sha256').update(content).digest('hex');
  await seedPlan(fx.admin, fx.workspaceId, harness, slug, content);
  await fx.admin`UPDATE harness_shared.harness_plans SET content_hash=${hash}, version=version+1
    WHERE workspace_id=${fx.workspaceId} AND harness_slug=${harness} AND plan_slug=${slug}`;
  await fx.admin`INSERT INTO harness_shared.plan_revisions
    (workspace_id,harness_slug,plan_slug,seq,content_hash,content_snapshot,rationale,author_kind,author_id,session_id,session_kind,created_at)
    SELECT ${fx.workspaceId},${harness},${slug},COALESCE(MAX(seq),0)+1,${hash},${content},'discovery fixture','agent','su-test','test','codex',${Date.now()}
    FROM harness_shared.plan_revisions WHERE workspace_id=${fx.workspaceId} AND harness_slug=${harness} AND plan_slug=${slug}`;
}
beforeAll(async () => {
  fx = await setupPlanPgFixture({ isolated: true });
  // Exercise the migration itself, including on a baseline that predates it.
  const migration = await readFile(fileURLToPath(new URL('../../../libs/papercusp/libs/db/sql/1619-plan-discovery-audits.sql', import.meta.url)), 'utf8');
  await fx.admin.unsafe(migration);
}, 120_000);
afterAll(async () => { await fx?.dispose(); });
beforeEach(async () => {
  await fx.admin`DELETE FROM harness_shared.plan_audits WHERE workspace_id=${fx.workspaceId} AND harness_slug=${harness}`;
  await cleanupPlans(fx.admin, fx.workspaceId, harness);
  await revision();
});

describe('discovery uses existing revision and audit authorities', () => {
  it('persists one typed assessment, round-trips questions, and never substitutes for activation/completion', async () => {
    const result = await recordCurrentDiscoveryAudit(input(), { context });
    expect(result).toMatchObject({ ok: true, reused: false, discovery: { readiness: { ready: true } }, audit: { auditKind: 'discovery', items: [], activation: null } });
    const [row] = await fx.admin`SELECT content,discovery FROM harness_shared.harness_plans p
      JOIN harness_shared.plan_audits a USING(workspace_id,harness_slug,plan_slug)
      WHERE p.workspace_id=${fx.workspaceId} AND p.harness_slug=${harness} AND p.plan_slug=${slug}`;
    expect(row.content).toBe(draft);
    expect(row.discovery.evidence[0].fingerprint).toBe('a'.repeat(64));
    expect(await getLatestActivationAudit(slug, { workspaceId: fx.workspaceId })).toBeNull();
    expect(await getLatestPlanAudit(slug, { workspaceId: fx.workspaceId })).toBeNull();
  });
  it('reuses identical and cosmetic state with original provenance and no second write', async () => {
    const first = await recordCurrentDiscoveryAudit(input(), { context });
    const again = await recordCurrentDiscoveryAudit(input(), { context });
    expect(again).toMatchObject({ ok: true, reused: true, audit: { auditSeq: first.ok && 'audit' in first ? first.audit?.auditSeq : -1 } });
    await revision(draft.replace('## Now\nDraft', '## Now\nChanged bookkeeping').replace('Wire the existing helper', 'Wire   the existing helper'));
    expect(discoverySubjectSnapshot(draft)).toEqual(discoverySubjectSnapshot(draft.replace('Wire the existing helper', 'Wire   the existing helper')));
    expect(await recordCurrentDiscoveryAudit(input(), { context })).toMatchObject({ ok: true, reused: true });
    const [{ count }] = await fx.admin`SELECT count(*)::int AS count FROM harness_shared.plan_audits WHERE workspace_id=${fx.workspaceId} AND plan_slug=${slug}`;
    expect(count).toBe(1);
  });
  it('previews without writes and stores honest non-ready results without inventing approval', async () => {
    expect(await recordCurrentDiscoveryAudit({ ...input(), dryRun: true }, { context })).toMatchObject({ ok: true, preview: true });
    const unknown = async () => ({ ...await context(), evidence: [] });
    expect(await recordCurrentDiscoveryAudit(input(), { context: unknown })).toMatchObject({ ok: true, discovery: { readiness: { ready: false, state: 'unknown' } } });
    const [{ count }] = await fx.admin`SELECT count(*)::int AS count FROM harness_shared.plan_audits WHERE workspace_id=${fx.workspaceId} AND plan_slug=${slug}`;
    expect(count).toBe(1);
  });
  it('refuses moved evidence at the accepting boundary with zero audit effects', async () => {
    let calls = 0;
    const moving = async () => { const value = await context(); value.evidence[0]!.fingerprint = String(++calls); return value; };
    expect(await recordCurrentDiscoveryAudit(input(), { context: moving })).toMatchObject({ ok: false, error: 'discovery_subject_moved' });
    const [{ count }] = await fx.admin`SELECT count(*)::int AS count FROM harness_shared.plan_audits WHERE workspace_id=${fx.workspaceId} AND plan_slug=${slug}`;
    expect(count).toBe(0);
  });
  it('refuses a missing matching revision rather than attaching stale provenance', async () => {
    await fx.admin`UPDATE harness_shared.harness_plans SET content=content || E'\nchanged' WHERE workspace_id=${fx.workspaceId} AND harness_slug=${harness} AND plan_slug=${slug}`;
    expect(await recordCurrentDiscoveryAudit(input(), { context })).toMatchObject({ ok: false, error: 'plan_revision_unavailable' });
  });
});
