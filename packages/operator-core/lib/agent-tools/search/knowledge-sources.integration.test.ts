import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EMBEDDER_DIM_SPECS } from '@papercusp/memory';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { createDocSearchSource, createPlanSearchSource } from './knowledge-sources';
import { splitDocSections } from '../../search/doc-embed-sync';
import { runChunkSyncTick } from '../../search/chunks/tick';
import { PLANS_CHUNK_SURFACE } from '../../search/chunks/registry';

const profileId = EMBEDDER_DIM_SPECS.gemma.profileId;
const vec = (match: boolean) => JSON.stringify([1, match ? 10 : 0, ...Array(766).fill(0)]);

describe('complete knowledge sections against canonical PostgreSQL', () => {
  let db: OrgTestDb;
  const workspaceId = `knowledge-${process.pid}-${Date.now()}`;
  const otherWorkspace = `${workspaceId}-other`;
  const params = () => ({ sql: db.adminSql, workspaceId, query: 'zephyrquartz', scopeFilter: null,
    limit: 1, qVec: vec(true), embeddingProfile: { profileId, legacyMode: 'gemma' } });
  beforeAll(async () => {
    db = await createOrgTestDb({ adminPoolMax: 3 });
    await db.adminSql`INSERT INTO harness_shared.harness_registry (workspace_id,payload)
      VALUES (${workspaceId},${db.adminSql.json({ projects: [{ slug: 'pot-a' }, { slug: 'pot-b' }] })}),
        (${otherWorkspace},${db.adminSql.json({ projects: [{ slug: 'foreign-pot' }] })})`;
    for (const [ws,harness,slug,content] of [
      [workspaceId,'pot-a','late-plan', 'ordinary filler '.repeat(5_000) + '\n## Late repair\nPrerequisite: retain the snapshot.\nApply zephyrquartz recovery.'],
      [workspaceId,'pot-b','crowding-plan','zephyrquartz '.repeat(20)],
      [otherWorkspace,'pot-a','foreign-plan','zephyrquartz '.repeat(30)],
    ]) {
      await db.adminSql`INSERT INTO harness_shared.harness_plans
        (workspace_id,harness_slug,plan_slug,title,content,status,embedding,embedding_profile,embedding_mode)
        VALUES (${ws},${harness},${slug},'Knowledge plan',${content},'active',${vec(false)}::vector,${profileId},'gemma')`;
    }
    const synced = await runChunkSyncTick({ sql: db.adminSql, surfaces: [{ ...PLANS_CHUNK_SURFACE,
      eligibleSql: `p.workspace_id = '${workspaceId}' AND p.harness_slug = 'pot-a'` }] });
    expect(synced).toHaveProperty('surfaces');
    await db.adminSql`UPDATE harness_shared.text_chunks SET embedding =
      CASE WHEN content LIKE '%zephyrquartz%' THEN ${vec(true)}::vector ELSE ${vec(false)}::vector END,
      embedding_profile = ${profileId}, embedding_mode = 'gemma'
      WHERE surface = 'plans' AND parent_key[1] = ${workspaceId}`;
    const body = Array.from({ length: 300 },(_,i) => `## Procedure ${i}\n${i === 299
      ? 'Prerequisite: retain the snapshot. Apply zephyrquartz recovery.' : 'Ordinary guidance.'}`).join('\n');
    for (const [sourceKey,slug,text] of [
      ['harness:pot-a','late-doc',body],
      ['harness:pot-b','crowding-doc','## Wrong scope\nzephyrquartz '.repeat(20)],
      ['harness:foreign-pot','foreign-doc','## Foreign scope\nzephyrquartz '.repeat(30)],
    ]) {
      for (const section of splitDocSections('Recovery procedure',text)) {
        await db.adminSql`INSERT INTO harness_shared.doc_sections
          (source_key,slug,anchor,title,url,content,page_sha,embedding,embedding_profile,embedding_mode)
          VALUES (${sourceKey},${slug},${section.anchor},${section.title},${`/docs/${slug}`},
            ${section.content},'fixture',${vec(section.content.includes('zephyrquartz'))}::vector,${profileId},'gemma')`;
      }
    }
  },180_000);
  afterAll(async () => { await db?.cleanup(); });

  it('retrieves a plan body beyond the old 32-window cap with its heading and prerequisite', async () => {
    const source = createPlanSearchSource({ harnessSlugs: ['pot-a'], automatic: true });
    for (const leg of [source.lexical!,source.embedding!]) {
      const rows = await leg(params());
      expect(rows.map(r=>r.row.source_id)).toEqual(['pot-a:late-plan']);
      expect(rows[0].row.excerpt).toContain('retain the snapshot');
      expect(rows[0].row.excerpt).toContain('zephyrquartz');
      expect(rows[0].row.meta?.section).toBe('Late repair');
    }
  });

  it('retrieves a deep doc section and excludes foreign/crowding harnesses before the limit', async () => {
    const source = createDocSearchSource({ harnessSlugs: ['pot-a'], automatic: true });
    for (const leg of [source.lexical!,source.embedding!]) {
      const rows = await leg(params());
      expect(rows.map(r=>r.row.source_id)).toEqual(['harness:pot-a:late-doc']);
      expect(rows[0].row.excerpt).toContain('retain the snapshot');
      expect(rows[0].row.meta?.section).toBe('procedure-299');
      expect(rows[0].row.meta?.path).toBe('/docs/late-doc#procedure-299');
    }
  });

  it('applies ambient fences and canonical retirement before either ranker', async () => {
    for (const [source,ref] of [
      [createPlanSearchSource,'plan:pot-a:late-plan'],
      [createDocSearchSource,'doc:harness:pot-a:late-doc'],
    ] as const) {
      const fenced = source({ harnessSlugs: ['pot-a'], automatic: true, excludedRefs: new Set([ref]) });
      expect(await fenced.lexical!(params())).toEqual([]);
      expect(await fenced.embedding!(params())).toEqual([]);
    }
    await db.adminSql`UPDATE harness_shared.harness_plans SET superseded_by = 'replacement'
      WHERE workspace_id = ${workspaceId} AND plan_slug = 'late-plan'`;
    const plans = createPlanSearchSource({ harnessSlugs: ['pot-a'], automatic: true });
    expect(await plans.lexical!(params())).toEqual([]);
    expect(await plans.embedding!(params())).toEqual([]);
    await db.adminSql`INSERT INTO harness_shared.harness_docs
      (workspace_id,harness_slug,doc_id,retired_at) VALUES (${workspaceId},'pot-a','late-doc.mdx',now())`;
    const docs = createDocSearchSource({ harnessSlugs: ['pot-a'], automatic: true });
    expect(await docs.lexical!(params())).toEqual([]);
    expect(await docs.embedding!(params())).toEqual([]);
  });
});
