import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { layerContentHash } from '@papercusp/orchestrator/blueprint';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: null as unknown, get: vi.fn() }));
vi.mock('@papercusp/db-org', async (orig) => ({ ...(await orig<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql: h.sql }) }));
vi.mock('../memory/backend', () => ({ getMemoryBackend: () => ({ get: h.get }) }));
vi.mock('../sync-sse', () => ({ notifySyncInvalidate: vi.fn() }));
vi.mock('./config', () => ({ readKnowledgePackSettings: async () => ({ pendingCandidateCap: 20 }) }));

const { createOrgTestDb } = await import('../../test/_org-test-db');
const { proposeIdentityMemory } = await import('./identity-learning');
const { getIdentitySource } = await import('../agent-identities/source');
const { autoAdoptPendingCandidates, decideKnowledgePackCandidate, listKnowledgePackCandidates, stageKnowledgePackCandidate, AUTO_ADOPT_REVIEWER } = await import('./candidates');

const WS = 'ws-identity-learning';
const IDENTITY = 'identity-learning-local';
const PACK = 'identity-lesson-pack';
const WRITER = 'identity-learning-writer';

describe('explicit identity learning through reviewed candidates (real migrated PG)', () => {
  let db: OrgTestDb;
  let root: string;
  let sourceDir: string;
  let packDir: string;

  async function writeIdentity(id: string, installed = false) {
    const dir = join(root, installed ? 'blueprints' : '.papercusp/blueprints', id);
    const pack = join(dir, 'packages/knowledge-pack', PACK);
    await fs.mkdir(pack, { recursive: true });
    const identity = {
      id, extends: 'base', version: '1.0.0', slots: [{ slot: 'domain' }],
      bundles: [{ kind: 'knowledge-pack', ref: PACK, version: '1.0.0' }],
    };
    await fs.writeFile(join(dir, 'blueprint.yaml'), stringify({ ...identity,
      attestation: { contentHash: layerContentHash(identity), signedBy: 'approved-publisher' },
    }));
    await fs.writeFile(join(pack, 'manifest.yaml'), stringify({
      id: PACK, title: 'Identity lessons', description: 'Reviewed identity lessons', version: '1.0.0',
      author: 'local-author', custom_field: 'preserve-me',
    }));
    return { dir, pack };
  }

  async function memory(overrides: Record<string, unknown> = {}) {
    const id = randomUUID();
    const metadata = {
      source_session: WRITER, workspace_id: WS, worn_identity_ids: [IDENTITY],
      kind: 'feedback', shareable: false, scope: 'personal', ...overrides,
    };
    const payload = { text: 'Read the owning implementation before interpreting a metric; confirm its units before reporting a value.', metadata };
    await db.adminSql`INSERT INTO harness_shared.memory_canonical (id, payload) VALUES (${id}, ${JSON.stringify(payload)}::text::jsonb)`;
    return { id, payload };
  }

  async function propose(id: string, overrides: Record<string, string> = {}) {
    return proposeIdentityMemory({ memoryId: id, identityId: IDENTITY, ownerId: WRITER, workspaceId: WS, ...overrides });
  }

  beforeAll(async () => {
    db = await createOrgTestDb(); h.sql = db.adminSql;
    root = await fs.mkdtemp(join(tmpdir(), 'identity-learning-'));
    vi.stubEnv('PAPERCUSP_HOME', root);
    h.get.mockImplementation(async (id: string) => {
      const rows = await db.adminSql`SELECT payload FROM harness_shared.memory_canonical WHERE id = ${id}`;
      return rows[0] ? { id, ...rows[0].payload } : null;
    });
  }, 120_000);

  beforeEach(async () => {
    await db.adminSql`DELETE FROM harness_shared.knowledge_pack_candidates`;
    await fs.rm(join(root, '.papercusp/blueprints', IDENTITY), { recursive: true, force: true });
    const local = await writeIdentity(IDENTITY); sourceDir = local.dir; packDir = local.pack;
    vi.stubEnv('PAPERCUSP_LEARNING_CANDIDATE_CAP', '20');
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.stubEnv('PAPERCUSP_HOME', root); });
  afterAll(async () => { vi.unstubAllEnvs(); await fs.rm(root, { recursive: true, force: true }); await db?.cleanup(); });

  it('propose/list/adopt is explicit, workspace-scoped, preserves visibility, and bumps the authored pack and pin', async () => {
    const source = await memory();
    expect(await listKnowledgePackCandidates({ workspaceId: WS })).toEqual([]);
    const proposal = await propose(source.id);
    expect(proposal, JSON.stringify(proposal)).toMatchObject({ ok: true, staged: true });
    if (!('id' in proposal)) throw new Error(JSON.stringify(proposal));
    const id = String(proposal.id);
    expect(await propose(source.id)).toMatchObject({ ok: false, reason: 'duplicate-signature' });
    const rows = await listKnowledgePackCandidates({ workspaceId: WS, identityId: IDENTITY });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ workspaceId: WS, targetIdentityId: IDENTITY, targetPackId: PACK, sourceMemoryId: source.id, status: 'pending' });
    expect(await listKnowledgePackCandidates({ workspaceId: 'other-workspace' })).toEqual([]);
    expect(await listKnowledgePackCandidates()).toEqual([]);
    expect(await decideKnowledgePackCandidate({ id, action: 'dismiss', by: 'reviewer', workspaceId: 'other-workspace' })).toEqual({ ok: false, reason: 'not_found' });
    const review = vi.fn();
    expect(await autoAdoptPendingCandidates({ adoptionPolicy: 'auto' }, { review })).toEqual({ reviewed: 0, adopted: 0, dismissed: 0, failed: 0 });
    expect(review).not.toHaveBeenCalled();
    expect(await decideKnowledgePackCandidate({ id, action: 'adopt', by: AUTO_ADOPT_REVIEWER, workspaceId: WS })).toEqual({ ok: false, reason: 'explicit_review_required' });
    const adopted = await decideKnowledgePackCandidate({ id, action: 'adopt', by: 'reviewer', workspaceId: WS, transferBar: async () => ({ blocked: false }) });
    expect(adopted).toMatchObject({ ok: true, packId: PACK, packVersion: '1.0.1' });
    if (!adopted.ok || adopted.action !== 'adopt') throw new Error(JSON.stringify(adopted));
    const text = await fs.readFile(join(packDir, adopted.packItemId + '.md'), 'utf8');
    expect(text).toContain(source.payload.text);
    expect(text).not.toContain('across the fleet');
    expect(parse(await fs.readFile(join(packDir, 'manifest.yaml'), 'utf8'))).toMatchObject({ version: '1.0.1', custom_field: 'preserve-me' });
    expect(parse(await fs.readFile(join(sourceDir, 'blueprint.yaml'), 'utf8')).bundles[0].version).toBe('1.0.1');
    expect(await getIdentitySource(IDENTITY)).toMatchObject({ ok: true });
    const [unchanged] = await db.adminSql`SELECT payload FROM harness_shared.memory_canonical WHERE id = ${source.id}`;
    expect(unchanged.payload).toEqual(source.payload);
    expect(await decideKnowledgePackCandidate({ id, action: 'adopt', by: 'reviewer', workspaceId: WS })).toEqual({ ok: false, reason: 'not_pending' });
  });

  it('refuses foreign writers, workspace changes, missing provenance and identities not worn when written', async () => {
    const source = await memory();
    expect(await propose(source.id, { ownerId: 'foreign-writer' })).toMatchObject({ reason: 'memory_writer_required' });
    expect(await propose(source.id, { workspaceId: 'foreign-workspace' })).toMatchObject({ reason: 'memory_writer_required' });
    expect(await propose(source.id, { identityId: 'foreign-identity' })).toMatchObject({ reason: 'identity_not_worn_at_write' });
    const unstamped = await memory({ worn_identity_ids: undefined });
    expect(await propose(unstamped.id)).toMatchObject({ reason: 'identity_not_worn_at_write' });
    expect(await listKnowledgePackCandidates({ workspaceId: WS })).toEqual([]);
  });

  it('restores the authored files after a source write failure so retry adds exactly one lesson', async () => {
    const source = await memory();
    const proposal = await propose(source.id);
    if (!('id' in proposal)) throw new Error(JSON.stringify(proposal));
    const sourcePath = join(sourceDir, 'blueprint.yaml');
    const manifestPath = join(packDir, 'manifest.yaml');
    const originalSource = await fs.readFile(sourcePath, 'utf8');
    const originalManifest = await fs.readFile(manifestPath, 'utf8');
    const writeFile = fs.writeFile.bind(fs);
    let failed = false;
    vi.spyOn(fs, 'writeFile').mockImplementation(async (path, data, options) => {
      if (String(path) === sourcePath && !failed) {
        failed = true;
        throw new Error('injected identity source write failure');
      }
      return writeFile(path, data, options);
    });
    const decide = () => decideKnowledgePackCandidate({ id: String(proposal.id), action: 'adopt', by: 'reviewer', workspaceId: WS, transferBar: async () => ({ blocked: false }) });
    expect(await decide()).toMatchObject({ ok: false, reason: 'pack_write_failed' });
    expect(await fs.readFile(sourcePath, 'utf8')).toBe(originalSource);
    expect(await fs.readFile(manifestPath, 'utf8')).toBe(originalManifest);
    expect(await fs.readdir(packDir)).toEqual(['manifest.yaml']);
    expect(await listKnowledgePackCandidates({ workspaceId: WS, status: 'pending' })).toHaveLength(1);
    expect(await decide()).toMatchObject({ ok: true, packVersion: '1.0.1' });
    expect((await fs.readdir(packDir)).filter((file) => file.endsWith('.md'))).toHaveLength(1);
    expect(await getIdentitySource(IDENTITY)).toMatchObject({ ok: true });
  });

  it('serializes adoption into the same authored pack across proposing workspaces', async () => {
    const a = await memory();
    const b = await memory({ workspace_id: 'other-workspace' });
    const proposals = [await propose(a.id), await propose(b.id, { workspaceId: 'other-workspace' })];
    const writeFile = fs.writeFile.bind(fs);
    vi.spyOn(fs, 'writeFile').mockImplementation(async (path, data, options) => {
      // Give a competing transaction time to read the old manifest if the
      // lock were scoped to its workspace instead of the shared target.
      if (String(path).endsWith('.md')) await new Promise((resolve) => setTimeout(resolve, 40));
      return writeFile(path, data, options);
    });
    const adopted = await Promise.all(proposals.map((proposal, index) => {
      if (!('id' in proposal)) throw new Error(JSON.stringify(proposal));
      return decideKnowledgePackCandidate({ id: String(proposal.id), action: 'adopt', by: 'reviewer', workspaceId: index ? 'other-workspace' : WS, transferBar: async () => ({ blocked: false }) });
    }));
    expect(adopted).toEqual(expect.arrayContaining([
      expect.objectContaining({ ok: true, packVersion: '1.0.1' }),
      expect.objectContaining({ ok: true, packVersion: '1.0.2' }),
    ]));
    expect(parse(await fs.readFile(join(packDir, 'manifest.yaml'), 'utf8')).version).toBe('1.0.2');
    expect(parse(await fs.readFile(join(sourceDir, 'blueprint.yaml'), 'utf8')).bundles[0].version).toBe('1.0.2');
    expect((await fs.readdir(packDir)).filter((file) => file.endsWith('.md'))).toHaveLength(2);
  });

  it('stages an installed identity for review but refuses adoption without changing its closure; dismissal works', async () => {
    const installedId = 'identity-learning-installed';
    const installed = await writeIdentity(installedId, true);
    const original = await fs.readFile(join(installed.pack, 'manifest.yaml'), 'utf8');
    const source = await memory({ worn_identity_ids: [installedId] });
    const proposal = await propose(source.id, { identityId: installedId });
    expect(proposal, JSON.stringify(proposal)).toMatchObject({ ok: true, staged: true });
    if (!('id' in proposal)) throw new Error(JSON.stringify(proposal));
    const id = String(proposal.id);
    const refused = await decideKnowledgePackCandidate({ id, action: 'adopt', by: 'reviewer', workspaceId: WS, transferBar: async () => ({ blocked: false }) });
    expect(refused).toMatchObject({ ok: false, reason: 'immutable_identity_pack' });
    expect(await fs.readFile(join(installed.pack, 'manifest.yaml'), 'utf8')).toBe(original);
    expect(await fs.readdir(installed.pack)).toEqual(['manifest.yaml']);
    expect(await decideKnowledgePackCandidate({ id, action: 'dismiss', by: 'reviewer', workspaceId: WS })).toEqual({ ok: true, id, action: 'dismiss' });
  });

  it('separates identity cap/dedup from fleet candidates and serializes concurrent proposals', async () => {
    vi.stubEnv('PAPERCUSP_LEARNING_CANDIDATE_CAP', '1');
    const source = await memory(); const other = await memory();
    // Stored settings override the env cap; use 20 candidates to exercise that exact guard.
    const results = await Promise.all(Array.from({ length: 22 }, async () => {
      const row = await memory(); return propose(row.id);
    }));
    expect(results.filter((result) => result.ok)).toHaveLength(20);
    expect(results.filter((result) => !result.ok)).toEqual([expect.objectContaining({ reason: 'pending-cap' }), expect.objectContaining({ reason: 'pending-cap' })]);
    const fleet = await stageKnowledgePackCandidate({ signature: 'fleet-identity-isolation', title: 'Fleet lesson', draftText: source.payload.text, scopes: [], recurrenceCount: 2 });
    expect(fleet).toMatchObject({ staged: true });
    expect(await propose(other.id)).toMatchObject({ reason: 'pending-cap' });
    const foreign = await memory({ workspace_id: 'another-workspace' });
    expect(await propose(foreign.id, { workspaceId: 'another-workspace' })).toMatchObject({ ok: true });
  });
});
