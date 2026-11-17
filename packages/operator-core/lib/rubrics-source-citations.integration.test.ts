import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import type { OrgTestDb } from '../test/_org-test-db';
import { runWithWorkspace } from './workspace-als';
import { dialogAnswerText } from './transcript-wire';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async orig => ({
  ...await orig<typeof import('@papercusp/db-org')>(),
  getOrgPg: () => ({ sql: h.sql }),
  withWorkspace: async <T>(workspace: string, cb: (sql: postgres.Sql) => Promise<T>) =>
    h.sql.begin(async tx => {
      await tx`SELECT set_config('app.workspace_id', ${workspace}, true)`;
      return cb(tx as unknown as postgres.Sql);
    }),
}));
const { createOrgTestDb } = await import('../test/_org-test-db');
const { proposeRubric, amendRubric, getRubric, ratifyRubric } = await import('./rubrics');
const { parseRequirementBars } = await import('./acceptance-bar-seed');
const { resolveRubricSourceCitations, rubricSourceCitationDeps } = await import('./rubrics-source-citations');
const workspace = 'rubric-source-citation-test';
const actor = 'source-citation-author';
let db: OrgTestDb;
const content = '---\nslug: intent-source\ntitle: Original intent\nstatus: active\n---\n\n## Requirements\n\n**R-1 — Complete export.** All rows survive.\n\n## Decisions\n\n### D-001 — Preserve all data\n\nNo silent caps.\n';
const criterion = (sourceRefs?: string[]) => ({ key: 'export', title: 'Complete export',
  model: 'Every record is exported.', method: 'Compare the complete input and output identities.',
  driftMarkers: 'Any input identity is missing.',
  ...(sourceRefs ? { intent: { request: 'Export every row.', sourceRefs } } : {}) });
const create = (refs?: string[]) => proposeRubric({ rubricId: 'cited-standard', characteristic: 'export',
  title: 'Cited standard', criteria: [criterion(refs)], by: actor });

beforeAll(async () => {
  // Validate the maintained fixture with the native parser BEFORE expensive DB
  // bootstrap. A hand-authored heading cannot masquerade as a canonical R-N.
  const parsed = parseRequirementBars(content);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.problems));
  expect(parsed.bars.map(bar => bar.barKey)).toEqual(['R-1']);
  db = await createOrgTestDb(); h.sql = db.adminSql;
}, 120_000);
afterAll(async () => { await db?.cleanup(); });
beforeEach(async () => {
  await db.adminSql`TRUNCATE harness_shared.harness_plans CASCADE`;
  await db.adminSql`DELETE FROM harness_shared.session_turns WHERE workspace_id=${workspace}`;
  await db.adminSql`INSERT INTO harness_shared.harness_plans
    (workspace_id,harness_slug,plan_slug,content,content_hash,version,title,status,owner,origin)
    VALUES (${workspace},'papercusp','intent-source',${content},md5(${content}),1,'Original intent','active',${actor},'local')`;
});

describe('source citation guards at the real rubric writers', () => {
  it('creates and amends a standard rubric with real plan sources and reads back unchanged citations', async () => {
    await runWithWorkspace(workspace, async () => {
      const original = ['plan:intent-source#R-1'];
      await create(original);
      expect((await getRubric('cited-standard'))!.criteria[0]!.intent!.sourceRefs).toEqual(original);
      const updated = ['plan:papercusp/intent-source#D-001', ...original];
      await amendRubric({ rubricId: 'cited-standard', requirement: { key: 'export',
        intent: { request: 'Retain every record.', sourceRefs: updated } }, by: actor });
      expect((await getRubric('cited-standard'))!.criteria[0]!.intent!.sourceRefs).toEqual(updated);
    });
  });

  it.each(['plan:absent#R-1', 'plan:intent-source#R-404', 'plan:intent-source#D-404'])
    ('refuses a missing real store source before any rubric persists: %s', async ref => {
      await runWithWorkspace(workspace, async () => {
        await expect(create([ref])).rejects.toThrow('rubric_source_citation_unresolved');
        expect(await getRubric('cited-standard')).toBeNull();
      });
    });

  it('refuses a bad citation amendment atomically and leaves uncited legacy criteria amendable', async () => {
    await runWithWorkspace(workspace, async () => {
      await create();
      await amendRubric({ rubricId: 'cited-standard', criterion: { key: 'export', field: 'method',
        mode: 'append', text: 'Also verify order and duplicated identities.' }, by: actor });
      const before = await getRubric('cited-standard');
      await expect(amendRubric({ rubricId: 'cited-standard', requirement: { key: 'export',
        intent: { request: 'Export all rows.', sourceRefs: ['plan:intent-source#D-404'] } }, by: actor }))
        .rejects.toThrow('rubric_source_citation_unresolved');
      expect((await getRubric('cited-standard'))!.revision).toBe(before!.revision);
      expect((await getRubric('cited-standard'))!.criteria).toEqual(before!.criteria);
    });
  });

  it('validates added criterion citations before writing and requires fresh standard ratification', async () => {
    await runWithWorkspace(workspace, async () => {
      await create();
      await ratifyRubric('cited-standard', 'independent-source-reviewer');
      const before = await getRubric('cited-standard');
      expect(before!.status).toBe('active');
      const added = { ...criterion(['plan:intent-source#D-404']), key: 'added' };
      await expect(amendRubric({ rubricId: 'cited-standard', criteria: [...before!.criteria, added], by: actor }))
        .rejects.toThrow('rubric_source_citation_unresolved');
      expect((await getRubric('cited-standard'))!.revision).toBe(before!.revision);
      const valid = { ...added, intent: { request: 'Preserve every source row.', sourceRefs: ['plan:intent-source#R-1'] } };
      await amendRubric({ rubricId: 'cited-standard', criteria: [...before!.criteria, valid], by: actor });
      const after = await getRubric('cited-standard');
      expect(after!.criteria.map(c => c.key)).toEqual(['export', 'added']);
      expect(after!.criteria[1]!.intent!.sourceRefs).toEqual(valid.intent.sourceRefs);
      expect(after!.status).toBe('proposed');
      expect(after!.ratifiedBy).toBeFalsy();
    });
  });

  it.each([
    ['owner-typed', 'Keep every row.', 'verified-owner'],
    ['owner-dialog', dialogAnswerText('Keep every row.', 'human'), 'verified-owner'],
    ['unenrolled-origin', 'Keep every row.', 'unverified'],
    ['agent-injected', '⟦turn-origin:loop-fire⟧ Keep every row.', 'refused'],
  ])('uses canonical indexed provenance for %s', async (verdict, text, expected) => {
    await db.adminSql`INSERT INTO harness_shared.session_turns
      (workspace_id,source_kind,session_id,turn_idx,text,speaker,owner,ts,turn_origin_verdict)
      VALUES (${workspace},'codex','citation-source',0,${text},'user',${actor},'2026-11-01T00:00:00Z',${verdict})`;
    await runWithWorkspace(workspace, async () => {
      const refs = ['session_turn:codex:citation-source:0'];
      const read = await resolveRubricSourceCitations([criterion(refs)], rubricSourceCitationDeps(workspace, actor));
      expect(read[0]!.citations[0]!.status).toBe(expected);
      if (expected === 'refused') await expect(create(refs)).rejects.toThrow('rubric_source_citation_unresolved');
      else {
        await create(refs);
        expect((await getRubric('cited-standard'))!.criteria[0]!.intent!.sourceRefs).toEqual(refs);
      }
    });
  });
});
