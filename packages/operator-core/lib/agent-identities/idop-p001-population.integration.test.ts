/** D-043: exercise the default population SQL and execution receipt selector. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileAgentSpecification } from '@papercusp/orchestrator/blueprint';
import type { OrgTestDb } from '../../test/_org-test-db';
import { readIdopP001AppliedStackPopulation as readPopulation } from './idop-p001-baseline';

let db: OrgTestDb;
// Inject the connection only. The production anchor query, launch-row query,
// receipt narrowing and artifact replay all run against migrated PostgreSQL.
// No protected-module replacement or live host initialization is necessary.
const readIdopP001AppliedStackPopulation = (workspace: string, _dependencies?: undefined,
  options: { payloads: 'retained' | 'digests-only' } = { payloads: 'retained' }) => {
  if (!db) throw new Error('P001 private population database is not initialized');
  return readPopulation(workspace, undefined, { ...options, sql: db.adminSql });
};
const { createOrgTestDb } = await import('../../test/_org-test-db');

const artifact = (id: string) => compileAgentSpecification({
  source: { id, workItem: { kind: 'feature' }, spine: { edges: { DONE: { to: 'done' } } } },
  prompt: { text: `Public population fixture for ${id}.` },
});
const applied = artifact('population-applied');
const desired = artifact('population-desired');
// Canonical activation state revisions are opaque nonempty strings. Production
// includes the older 24-character watermark as well as newer SHA-256 values.
const pair = { specificationRevision: applied.specificationRevision, stateRevision: '1'.repeat(24) };
const receipt = { ...pair, stack: ['domain:population-applied'], specificationArtifact: applied };

async function anchor(workspace: string, owner: string, activation: unknown) {
  await db.adminSql`
    INSERT INTO harness_shared.session_briefs (workspace_id, owner_id, control_state)
    VALUES (${workspace}, ${owner}, ${JSON.stringify({ activation })}::text::jsonb)`;
}

async function launch(workspace: string, owner: string, record: unknown, ended = false) {
  const [row] = await db.adminSql<Array<{ id: number }>>`
    INSERT INTO harness_shared.adv_sessions
      (workspace_id, mode, coord_owner_id, launch_spec, ended_at)
    VALUES (${workspace}, 'console', ${owner}, ${JSON.stringify(record)}::text::jsonb,
            ${ended ? new Date() : null})
    RETURNING id`;
  return row.id;
}

describe('IDOP D-043 persisted applied population (real PostgreSQL)', () => {
  beforeAll(async () => {
    db = await createOrgTestDb();
    // The wrapper cannot call the reader until the private connection exists.
    expect(db.adminSql).toBeDefined();
  }, 180_000);
  afterAll(async () => { await db?.cleanup(); });

  it('keeps applied history in the latest registration, including ended wearers, within the requested workspace', async () => {
    const workspace = 'idop-population-applied';
    const owner = 'su-idop-population-ended';
    await anchor(workspace, owner, { applied: pair, desired: {
      specificationRevision: desired.specificationRevision, stateRevision: '2'.repeat(64),
    } });
    const predecessor = await launch(workspace, owner, { ...receipt, role: 'worker' });
    await launch(workspace, owner, {
      role: 'judge', specificationRevision: desired.specificationRevision,
      stateRevision: '2'.repeat(64), specificationArtifact: desired,
      stack: ['domain:population-desired'], identityHistory: [receipt],
    }, true);
    // A resume timestamp cannot replace the newer registration. A newer row
    // in another workspace cannot supply this workspace's launch artifact.
    await db.adminSql`UPDATE harness_shared.adv_sessions
      SET started_at = now() + interval '1 hour' WHERE id = ${predecessor}`;
    await launch('idop-population-foreign', owner, { invalid: true });
    await anchor('idop-population-foreign', 'su-idop-population-foreign', { applied: {} });
    await anchor(workspace, 'su-idop-population-no-applied', { desired: pair });
    await anchor(workspace, 'su-idop-population-null-applied', { applied: null });

    const result = await readIdopP001AppliedStackPopulation(workspace);
    expect(result).toMatchObject({ includesInactiveAnchors: true, livenessMeasured: false });
    expect(result.receiptFunctions.map(row => row.name)).toEqual(expect.arrayContaining([
      'selectAppliedReceipt', 'appliedIdentityArtifact', 'appliedOrCurrentIdentityArtifact',
      'resolveIdentityArtifact', 'identityWearerRole', 'SU_WEARER_ROLE',
    ]));
    expect(result.receiptSources.every(row => /^[a-f0-9]{64}$/.test(row.sha256))).toBe(true);
    expect(result.stacks).toHaveLength(1);
    expect(result.stacks[0]).toMatchObject({ ownerId: owner, applied: pair, role: 'judge',
      explicitStack: ['domain:population-applied'], artifact: applied });
    expect(result.stacks[0].layers).toContainEqual(expect.objectContaining({ ref: 'population-applied' }));
  });

  it('admits a control-only state revision through the canonical current-artifact fallback', async () => {
    const workspace = 'idop-population-control';
    const owner = 'su-idop-population-control';
    await anchor(workspace, owner, { applied: pair });
    await launch(workspace, owner, { ...receipt, stateRevision: '3'.repeat(64) });
    const result = await readIdopP001AppliedStackPopulation(workspace);
    expect(result.stacks).toHaveLength(1);
    expect(result.stacks[0]).toMatchObject({ ownerId: owner, applied: pair, role: 'su', artifact: applied });
  });

  it('preserves a persisted applied owner without a launch row as the canonical receipt refusal', async () => {
    const workspace = 'idop-population-missing';
    const owner = 'su-idop-population-missing';
    await anchor(workspace, owner, { applied: pair });
    const result = await readIdopP001AppliedStackPopulation(workspace);
    expect(result.stacks).toEqual([]);
    expect(result.refused).toMatchObject([{ ownerId: owner, applied: pair,
      resolution: { kind: 'stale-artifact', reason: 'receipt-missing' }, launchRecord: null }]);
    expect(result.refused).toHaveLength(1);
  });

  it('refuses malformed persisted applied state instead of silently excluding it', async () => {
    const workspace = 'idop-population-malformed';
    await anchor(workspace, 'su-idop-population-malformed', { applied: {
      specificationRevision: pair.specificationRevision,
    } });
    await expect(readIdopP001AppliedStackPopulation(workspace))
      .rejects.toThrow(/malformed applied anchor/);
  });

  it('keeps a refusal beyond the first body page in the complete persisted population', async () => {
    const workspace = 'idop-population-pages';
    const owners = Array.from({ length: 103 }, (_, index) => `su-idop-page-${String(index).padStart(3, '0')}`);
    for (const [index, owner] of owners.entries()) {
      await anchor(workspace, owner, { applied: pair });
      if (index !== 102) await launch(workspace, owner, receipt, true);
    }
    const result = await readIdopP001AppliedStackPopulation(workspace);
    expect(result.stacks).toHaveLength(102);
    expect(result.refused).toHaveLength(1);
    expect([...result.stacks, ...result.refused].map(row => row.ownerId).sort()).toEqual(owners);
    expect(result.refused[0]).toMatchObject({ ownerId: owners[102],
      resolution: { kind: 'stale-artifact', reason: 'receipt-missing' }, launchRecord: null });
  });

  it('returns an empty population only when the requested workspace has no applied anchors', async () => {
    expect(await readIdopP001AppliedStackPopulation('idop-population-empty'))
      .toMatchObject({ stacks: [], includesInactiveAnchors: true, livenessMeasured: false });
  });

  it('keeps the real SQL applied/history selection and refusals identical with digest-only retention', async () => {
    const workspace = 'idop-population-digests';
    const owner = 'su-idop-population-digests';
    await anchor(workspace, owner, { applied: pair });
    await anchor(workspace, 'su-idop-population-digests-refused', { applied: pair });
    await launch(workspace, owner, { role: 'judge', specificationRevision: desired.specificationRevision,
      stateRevision: '2'.repeat(64), specificationArtifact: desired,
      stack: ['domain:population-desired'], identityHistory: [receipt] }, true);
    const full = await readIdopP001AppliedStackPopulation(workspace);
    const compact = await readIdopP001AppliedStackPopulation(workspace, undefined, { payloads: 'digests-only' });
    expect(compact).toEqual({ ...full, payloads: 'digests-only',
      stacks: full.stacks.map(({ launchRecord: _record, artifact: _artifact, ...member }) => member),
      refused: full.refused.map(({ launchRecord: _record, ...member }) => member) });
    expect(compact.stacks[0]).toMatchObject({ role: 'judge', applied: pair,
      explicitStack: ['domain:population-applied'], artifactSha256: full.stacks[0].artifactSha256 });
    expect(compact.stacks[0]).not.toHaveProperty('artifact');
    expect(compact.refused).toMatchObject([{ ownerId: 'su-idop-population-digests-refused',
      resolution: { kind: 'stale-artifact', reason: 'receipt-missing' } }]);
  });
});
