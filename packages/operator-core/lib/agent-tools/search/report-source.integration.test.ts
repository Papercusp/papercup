import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runFullTextSearch, runHybridSearch } from '@papercusp/search';
import { EMBEDDER_DIM_SPECS } from '@papercusp/memory';
import { createReportSearchSource } from './report-source';
import { publishReport, retireReport } from '../../report-library';
import { indexReport } from '../../search/report-index';
import { SEARCH_SOURCES } from './sources';
import { scopeArg } from './scope';
import { SEARCH_SOURCE_SURFACES } from '../../search/coverage-gate';
import { stampEmbedderMode } from '../../search/embedder-mode-registry';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { resolveNamedQueryV2 } from '../../sync-resolver';

const flag = vi.hoisted(() => ({ enabled: true }));
const ui = vi.hoisted(() => ({ sql: undefined as unknown as import('postgres').Sql, workspaceId: '' }));
vi.mock('@papercusp/db-org', async actual => ({
  ...await actual<typeof import('@papercusp/db-org')>(), getOrgPg: () => ({ sql: ui.sql }),
}));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => ui.workspaceId }));
vi.mock('@papercusp/flags/server', () => ({ getFlag: async () => flag.enabled }));
const vector = (text: string) => [1, text.includes('zephyrquartz') ? 10 : 0, ...Array(766).fill(0)];
const embed = async (text: string) => vector(text);
const profileId = EMBEDDER_DIM_SPECS.gemma.profileId;
const documentEmbedder = { embed, profileId, mode: 'gemma' };
stampEmbedderMode(embed, 'gemma', profileId);

describe('Reports shared search (migrated PostgreSQL)', () => {
  let db: OrgTestDb;
  const workspaceId = `report-search-${Date.now()}`;
  beforeAll(async () => {
    db = await createOrgTestDb({ adminPoolMax: 3 });
    ui.sql = db.adminSql;
    ui.workspaceId = workspaceId;
  }, 180_000);
  afterAll(async () => { await db?.cleanup(); });
  const context = () => ({ sql: db.adminSql, workspaceId, query: 'zephyrquartz', scopeFilter: null, limit: 20 });
  const author = { authorOwnerId: 'writer', harnessSlug: 'pot-a' };
  async function publish(visibility: 'owner' | 'pot' | 'workspace', bodyMd = 'zephyrquartz findings') {
    const report = await publishReport(db.adminSql, { workspaceId, visibility, title: 'Search evidence', bodyMd }, author);
    await indexReport(db.adminSql, report, documentEmbedder);
    return report;
  }

  it('registers report scope and derives its sweep coverage mapping', () => {
    expect(SEARCH_SOURCES.some(s => s.name === 'report')).toBe(true);
    expect(scopeArg().parse(['reports'])).toEqual(['report']);
    expect(SEARCH_SOURCE_SURFACES.report).toContain('harness_shared.text_chunks.embedding');
  });

  it('routes Reports tab search and the registered source to the same live corpus, ignoring a parallel decoy', async () => {
    const report = await publish('owner', 'corpusquartzunique');
    // A real second corpus disagrees with the authoritative document. Routing
    // the UI to this legacy table must fail the positive and negative controls.
    await db.adminSql`INSERT INTO harness_shared.report_library_chunks
      (workspace_id, report_id, chunk_idx, text)
      VALUES (${workspaceId}, ${report.reportId}, 0, 'paralleldecoyunique')`;
    const uiIds = async (query: string) => {
      const rows = await resolveNamedQueryV2('reports.list', { query, limit: 200 });
      expect(Array.isArray(rows)).toBe(true);
      return (rows as Array<{ report_id: string }>).map(r => r.report_id);
    };
    const sourceIds = async (query: string) => (await createReportSearchSource({ isOwner: true })
      .lexical!({ ...context(), query })).map(r => r.row.source_id);
    for (const query of ['corpusquartzunique', 'paralleldecoyunique']) {
      const expected = query === 'corpusquartzunique' ? [report.reportId] : [];
      expect(await uiIds(query)).toEqual(expected);
      expect(await sourceIds(query)).toEqual(expected);
    }
    // Change only the canonical row: both paths must immediately follow its
    // generated search_tsv; the parallel corpus remains deliberately stale.
    await db.adminSql`UPDATE harness_shared.report_library SET body_md = 'corpusreplacementunique'
      WHERE workspace_id = ${workspaceId} AND report_id = ${report.reportId}`;
    expect(await uiIds('corpusquartzunique')).toEqual([]);
    expect(await sourceIds('corpusquartzunique')).toEqual([]);
    expect(await uiIds('corpusreplacementunique')).toEqual([report.reportId]);
    expect(await sourceIds('corpusreplacementunique')).toEqual([report.reportId]);
    expect(await uiIds('paralleldecoyunique')).toEqual([]);
    await retireReport(db.adminSql, workspaceId, report.reportId);
    expect(await uiIds('corpusreplacementunique')).toEqual([]);
    expect(await sourceIds('corpusreplacementunique')).toEqual([]);
  });

  it('finds a long report tail through lexical and semantic engines', async () => {
    const report = await publish('workspace', 'ordinary filler '.repeat(500) + ' zephyrquartz');
    const source = createReportSearchSource();
    const lexical = await runFullTextSearch([source], context());
    expect(lexical.results.map(r => r.source_id)).toContain(report.reportId);
    const semantic = await runHybridSearch([source], { ...context(), embedder: embed, mode: 'embeddings' });
    expect(semantic.results.map(r => r.source_id)).toContain(report.reportId);
    expect(semantic.results.find(r => r.source_id === report.reportId)?.rankers).toContain('embeddings');
    const chunks = await db.adminSql`SELECT count(*)::int AS n FROM harness_shared.text_chunks
      WHERE surface = 'report' AND parent_key = ${[workspaceId, report.reportId]}::text[] AND embedding IS NOT NULL`;
    expect(chunks[0].n).toBeGreaterThan(3);
  });

  it('enforces private, pot, author and workspace access before either ranker, even with spoofed author filters', async () => {
    const privateReport = await publish('owner');
    const potReport = await publish('pot');
    const publicReport = await publish('workspace');
    for (const [viewer, allowed] of [
      [{ ownerId: 'stranger', potSlug: 'pot-b' }, [publicReport.reportId]],
      [{ ownerId: 'peer', potSlug: 'pot-a' }, [potReport.reportId, publicReport.reportId]],
      [{ ownerId: 'writer', potSlug: 'pot-b' }, [privateReport.reportId, potReport.reportId, publicReport.reportId]],
      [{ isOwner: true }, [privateReport.reportId, potReport.reportId, publicReport.reportId]],
    ] as const) {
      const source = createReportSearchSource(viewer);
      for (const semantic of [false, true]) {
        const options = { ...context(), filters: { owners: ['writer'] } };
        const result = semantic ? await runHybridSearch([source], { ...options, embedder: embed, mode: 'embeddings' })
          : await runFullTextSearch([source], options);
        const actual = result.results.map(r => r.source_id).filter(id => [privateReport.reportId, potReport.reportId, publicReport.reportId].includes(id));
        expect(actual.sort()).toEqual([...allowed].sort());
      }
    }
  });

  it('returns latest editions and removes retired reports from both rankers', async () => {
    const old = await publish('workspace');
    const replacement = await publishReport(db.adminSql, { workspaceId, title: 'Corrected', bodyMd: 'zephyrquartz',
      supersedes: old.reportId, visibility: 'workspace' }, author);
    await indexReport(db.adminSql, replacement, documentEmbedder);
    for (const mode of ['lexical', 'embedding'] as const) {
      const source = createReportSearchSource();
      const rows = mode === 'lexical' ? await source.lexical!(context()) : await source.embedding!({ ...context(),
        qVec: JSON.stringify(vector('zephyrquartz')), embeddingProfile: { profileId, legacyMode: 'gemma' } });
      expect(rows.map(r => r.row.source_id)).toContain(replacement.reportId);
      expect(rows.map(r => r.row.source_id)).not.toContain(old.reportId);
    }
    await retireReport(db.adminSql, workspaceId, replacement.reportId);
    const rows = await createReportSearchSource().lexical!(context());
    expect(rows.map(r => r.row.source_id)).not.toContain(replacement.reportId);
  });

  it('fails closed when the library is disabled or vector identity is unknown', async () => {
    flag.enabled = false;
    const source = createReportSearchSource({ isOwner: true });
    expect(await source.lexical!(context())).toEqual([]);
    expect(await source.embedding!({ ...context(), qVec: JSON.stringify(vector('zephyrquartz')) })).toEqual([]);
    flag.enabled = true;
    expect(await source.embedding!({ ...context(), qVec: JSON.stringify(vector('zephyrquartz')) })).toEqual([]);
  });
});
