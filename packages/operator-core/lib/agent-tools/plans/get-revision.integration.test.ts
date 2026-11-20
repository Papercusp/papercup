import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setupPlanPgFixture, seedPlan, type PlanPgFixture } from './__tests__/_pg-tool-fixture';
import { recordPlanRevisionInTransaction } from './revisions';
import { hashPlanContent } from './content-hash';
import { shapePlansGet } from './get-shape';
import tool, { narrowDecisionPayload } from './get';
import revisionDiff from './revision-diff';
import { getActivationAuditEditNotice } from '../../plan-audits';

const HARNESS = 'zzz-get-revision';
const SLUG = 'immutable-evidence';
const original = `---
slug: ${SLUG}
title: Immutable evidence
status: draft
---

## Now

State: Original state.
Next: Preserve evidence.

## Work

- **P-001** \`todo\` — Original task.

## Decisions

### D-001 — Original ruling

Date: 2026-10-23

The original ruling remains the evidence.
`;
const updated = original.replace('Original task.', 'Changed task.')
  .replace('The original ruling remains the evidence.', 'The later ruling is different.');
let fx: PlanPgFixture;

const context = (workspaceId = 'default', harnessSlug = HARNESS): Parameters<typeof tool.handler>[1] => ({
  workspaceId, harnessSlug, role: 'judge', isSuperuser: true,
  signal: new AbortController().signal, log: vi.fn(), progress: vi.fn(), emit: vi.fn(),
});

async function read(input: Record<string, unknown>, workspaceId = 'default') {
  const result = await tool.handler(tool.args.parse({ slug: SLUG, harness: HARNESS, ...input }), context(workspaceId));
  expect(result).toHaveProperty('data.results');
  return (result as { data: { results: Array<Record<string, unknown>> } }).data.results[0]!;
}

async function revision(content: string, workspaceId = 'default', harnessSlug = HARNESS, planSlug = SLUG, contentHash?: string) {
  return fx.admin.begin((tx) => recordPlanRevisionInTransaction(tx, {
    workspaceId, harnessSlug, planSlug, content, contentHash,
    identity: { ownerId: 'revision-reader-test', ownerLabel: 'revision reader test', source: 'static-client', workspaceId, userId: null },
  }));
}

beforeAll(async () => {
  fx = await setupPlanPgFixture({ isolated: true });
  await seedPlan(fx.admin, fx.workspaceId, HARNESS, SLUG, original);
  await revision(original);
}, 120_000);
afterAll(async () => { await fx?.dispose(); });

describe('plans:get immutable revision reader', () => {
  it('continues the edit notice against its original audit and saved revision after another edit', async () => {
    const slug = 'compare-audit-pages';
    const ids = Array.from({ length: 35 }, (_, i) => `P-${String(i + 1).padStart(3, '0')}`);
    const before = ['---', `slug: ${slug}`, 'title: Compare pages', 'status: ready', '---', '', '## Work', '',
      ...ids.map((id, i) => `- **${id}** \`todo\` ${i === 0 ? 'Source' : `Reader blocked-by: ${ids[i - 1]}`}`)].join('\n');
    const after = before.replace('`todo` Source', '`todo` New source');
    await seedPlan(fx.admin, fx.workspaceId, HARNESS, slug, before);
    const prior = await revision(before, fx.workspaceId, HARNESS, slug);
    await fx.admin`INSERT INTO harness_shared.plan_audits
      (workspace_id,harness_slug,plan_slug,audit_seq,created_by,audit_kind,activation,audited_plan_revision_id,
       audited_plan_revision_seq,audited_plan_content_hash)
      SELECT workspace_id,harness_slug,plan_slug,1,'original-reviewer','activation',
        ${JSON.stringify({ sourceRanges: [], mappings: [], repairedOmissions: [], rejectedOrSuperseded: [], unresolvedBlockers: [] })}::jsonb,
        id,seq,content_hash FROM harness_shared.plan_revisions WHERE workspace_id=${fx.workspaceId}
          AND harness_slug=${HARNESS} AND plan_slug=${slug} AND seq=${prior.seq} AND content_hash=${prior.contentHash}`;
    await revision(after, fx.workspaceId, HARNESS, slug);
    const notice = await getActivationAuditEditNotice({ workspaceId: fx.workspaceId, harnessSlug: HARNESS, planSlug: slug,
      currentContent: after, currentContentHash: hashPlanContent(after), planVersion: 2 });
    const first = notice!.affectedTargets!;
    expect(first.total).toBe(35);
    expect(first.remaining).toBe(3);
    await revision(after.replace('New source', 'Third version'), fx.workspaceId, HARNESS, slug);
    const command = first.next!;
    const result = await revisionDiff.handler(revisionDiff.args.parse(command.args), context(fx.workspaceId));
    const last = JSON.parse((result as { content: { text: string }[] }).content[0]!.text).affectedTargets;
    expect(last).toMatchObject({ observation: first.observation, total: 35, remaining: 0, next: null });
    expect([...first.targets, ...last.targets].map(row => row.id)).toEqual(ids);
  });

  it('replays the original bytes and decision after a later plan write', async () => {
    const before = await read({ revision: 1, decisionId: 'D-001' });
    await seedPlan(fx.admin, fx.workspaceId, HARNESS, SLUG, updated);
    await revision(updated);
    const after = await read({ revision: 1, decisionId: 'D-001' });
    expect(after).toEqual(before);
    expect(after).toMatchObject({ ok: true, readSource: 'revision', revision: 1,
      contentHash: hashPlanContent(original), contentSnapshotHash: hashPlanContent(original),
      decisions: [{ id: 'D-001', body: expect.stringContaining('original ruling remains') }] });
    expect(after).not.toHaveProperty('version');
    expect(after).not.toHaveProperty('latestActivationAudit');
    expect(await read({ revision: 1, mode: 'full', includeRaw: true })).toMatchObject({ raw: original });
    expect(await read({ revision: 2, heading: 'Decisions' })).toMatchObject({
      section: { body: expect.stringContaining('later ruling is different') },
    });
    const current = await read({ heading: 'Decisions' });
    expect(current).toMatchObject({ section: { body: expect.stringContaining('later ruling is different') } });
    expect(current).not.toHaveProperty('readSource', 'revision');
  });

  it('selects by content hash and keeps explicit item and decision bodies through shaping', async () => {
    const result = await read({ revision: hashPlanContent(original), items: ['P-001', 'P-999'], decisionId: 'D-001' });
    expect(result).toMatchObject({ revision: 1,
      items: [{ id: 'P-001', text: expect.stringContaining('Original task') }],
      itemSelection: { matched: ['P-001'], missing: ['P-999'] },
    });
    const shaped = shapePlansGet({ ok: true, results: [result] }, 'trimmed');
    expect(shaped).toMatchObject({ results: [{ revision: 1, decisions: result.decisions }] });
  });

  it('selects exact immutable bytes by hash when a newer enriched receipt shares that hash', async () => {
    const slug = 'enriched-revision';
    const hash = hashPlanContent(original);
    const receipt = JSON.stringify({ event: 'execution-start', contentHash: hash });
    await seedPlan(fx.admin, fx.workspaceId, HARNESS, slug, updated);
    await revision(original, fx.workspaceId, HARNESS, slug);
    await revision(receipt, fx.workspaceId, HARNESS, slug, hash);

    expect(await read({ slug, revision: hash, mode: 'full', includeRaw: true })).toMatchObject({
      ok: true, revision: 1, contentHash: hash, contentSnapshotHash: hash, raw: original,
    });
    // An explicit sequence still selects that exact receipt, without rewriting history.
    expect(await read({ slug, revision: 2, mode: 'full', includeRaw: true })).toMatchObject({
      ok: true, revision: 2, contentHash: hash, contentSnapshotHash: hashPlanContent(receipt), raw: receipt,
    });
  });

  it('refuses a hash with only enriched receipts instead of substituting the mutable body', async () => {
    const slug = 'receipt-without-immutable-body';
    const hash = hashPlanContent(original);
    await seedPlan(fx.admin, fx.workspaceId, HARNESS, slug, original);
    await revision(JSON.stringify({ event: 'execution-start' }), fx.workspaceId, HARNESS, slug, hash);

    expect(await read({ slug, revision: hash })).toMatchObject({ ok: false, error: 'revision_not_found' });
  });

  it('fails closed for missing revisions and foreign plan, harness and workspace hashes', async () => {
    const foreign = original.replace('Original task.', 'Foreign evidence.');
    await seedPlan(fx.admin, 'other-workspace', HARNESS, SLUG, foreign);
    await revision(foreign, 'other-workspace');
    await seedPlan(fx.admin, fx.workspaceId, 'zzz-other-revision', SLUG, foreign);
    await revision(foreign, fx.workspaceId, 'zzz-other-revision');
    await seedPlan(fx.admin, fx.workspaceId, HARNESS, 'other-plan', foreign);
    await revision(foreign, fx.workspaceId, HARNESS, 'other-plan');
    for (const input of [
      { revision: 999 },
      { revision: hashPlanContent(foreign) },
      { slug: 'other-plan', revision: hashPlanContent(original) },
      { harness: 'zzz-other-revision', revision: hashPlanContent(original) },
    ]) {
      expect(await read(input)).toMatchObject({ ok: false, error: 'revision_not_found' });
    }
    expect(await read({ revision: hashPlanContent(original) }, 'other-workspace'))
      .toMatchObject({ ok: false, error: 'revision_not_found' });
    expect(await read({ revision: 1 }, 'other-workspace')).toMatchObject({
      contentSnapshotHash: hashPlanContent(foreign),
    });
  });

  it('pins decision continuation calls to the same historical revision', async () => {
    const base = await read({ revision: 1, mode: 'meta' });
    const decisions = ['D-001', 'D-002'].map((id) => ({ id, body: 'long ruling '.repeat(100) }));
    const page = narrowDecisionPayload(base, ['D-001', 'D-002'], decisions, 100);
    expect(page).toMatchObject({ revision: 1, decisionContinuation: {
      call: { slug: SLUG, harness: HARNESS, revision: 1, decisions: ['D-002'] },
    } });
  });

  it('rejects ambiguous or live-state options instead of mixing current evidence into a snapshot', () => {
    for (const input of [
      { revision: 0 }, { revision: -1 }, { revision: 1.5 }, { revision: 'latest' },
      { revision: 1, slugs: [SLUG] }, { revision: 1, includeHistory: true },
      { revision: 1, includeEnrichments: true }, { revision: 1, shipReadiness: true },
      { revision: 1, activationReadiness: true }, { revision: 1, operationalBrief: true },
      { revision: 1, efficiency: true }, { revision: 1, priorAttemptRefs: ['WI-1'] },
    ]) expect(tool.args.safeParse({ slug: SLUG, ...input }).success).toBe(false);
    expect(tool.agentRoles).toContain('judge');
    expect(tool.capability).toBe('plans:read');
  });
});
