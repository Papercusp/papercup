/** Current disk → lexical/compiler candidates → persisted prior → independent reread. */
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Sql } from 'postgres';
import { afterEach, describe, expect, it } from 'vitest';
import { getPilotCapabilityManifest } from './capability-catalog';
import { capabilityHash } from './capability-contracts';
import { CAPABILITY_PRIOR_KINDS } from './capability-review';
import { buildCapabilityReviewSources, discoverCapabilityReviewCode } from './capability-review-sources';
import { readCapabilitySource } from './capability-packets';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const scope = { workspaceId: 'review-workspace', potSlug: 'review-pot', repositoryId: 'review-repository' };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'native-p024-priors-')); roots.push(root);
  const source = 'import { helper } from "./helper";\nexport function rollbackReplayBridge() { return helper(); }\n';
  await writeFile(join(root, 'existing.ts'), source);
  await writeFile(join(root, 'helper.ts'), 'export function helper() { return "EXISTING_ROLLBACK_AND_REPLAY"; }\n');
  const sources = () => buildCapabilityReviewSources({ sql: {} as Sql, scope, rootPath: root,
    manifest: getPilotCapabilityManifest(), packets: [] }, {
    plans: async () => ({ rows: [], truncated: false }), plan: async () => null,
    ideas: async () => [], runs: async () => [], run: async () => null,
    verifyPacket: async () => ({ fresh: true }), code: discoverCapabilityReviewCode, readCode: readCapabilitySource,
  });
  const request = { facet: 'mechanism' as const, query: 'rollbackReplayBridge', scope, kinds: CAPABILITY_PRIOR_KINDS, limit: 8 };
  return { root, source, sources, request };
}
describe('native P024 current existing-integration source priors beyond the catalogue', () => {
  it('returns only complete existing filenames when broad source retrieval overflows its bounded capture', async () => {
    const f = await fixture();
    const text = 'export const boundedCaptureNeedle = true;\n';
    // More than 32K of filenames, with capture boundaries inside a filename.
    await Promise.all(Array.from({ length: 640 }, (_, i) => writeFile(
      join(f.root, 'a'.repeat(64) + String(i).padStart(4, '0') + '.ts'), text,
    )));
    const result = await discoverCapabilityReviewCode(f.root, scope.repositoryId, ['boundedCaptureNeedle']);
    expect(result.truncated).toBe(true);
    expect(result.paths).toHaveLength(12);
    for (const path of result.paths) {
      expect(path).toMatch(/^a{64}\d{4}\.ts$/);
      expect(await readFile(join(f.root, path), 'utf8')).toBe(text);
    }
  }, 30_000);

  it('supplies the existing integration and its renamed helper with exact source versions to independent review', async () => {
    const f = await fixture(), adapter = f.sources(), result = await adapter.search(f.request);
    expect(result.status).toBe('current');
    expect(result.matches.map(row => row.ref).sort(), result.note).toEqual(['code-source:existing.ts', 'code-source:helper.ts']);
    expect(result.matches.find(row => row.ref === 'code-source:existing.ts')).toMatchObject({ sourceHash: capabilityHash(f.source),
      candidateHash: null, evidenceHash: null, locator: { kind: 'code', id: 'source:existing.ts', path: 'existing.ts' } });
    expect(result.note).toContain('not proof of absence');
    for (const prior of result.matches) expect(await adapter.readCurrent(prior)).toEqual(prior);
    const saved = JSON.parse(JSON.stringify(result.matches));
    const independent = f.sources();
    for (const prior of saved) expect(await independent.readCurrent(prior)).toEqual(prior);
  }, 30_000);
  it('detects changed integration source after retrieval and preserves an empty-search unknown rather than claiming novelty', async () => {
    const f = await fixture(), adapter = f.sources();
    const prior = (await adapter.search(f.request)).matches.find(row => row.ref === 'code-source:existing.ts')!;
    await writeFile(join(f.root, 'existing.ts'), 'export const changedIntegration = true;\n');
    expect((await adapter.readCurrent(prior))!.sourceHash).not.toBe(prior.sourceHash);
    const absent = await adapter.search({ ...f.request, query: 'nonsensezzqwerty' });
    expect(absent.matches).toEqual([]); expect(absent.note).toContain('global novelty is not established');
  }, 30_000);
  it('rejects a persisted candidate path that traverses into or symlinks to an unauthorized repository', async () => {
    const f = await fixture(), adapter = f.sources();
    const prior = (await adapter.search(f.request)).matches[0]!;
    await mkdir(join(f.root, 'other'));
    const external = await mkdtemp(join(tmpdir(), 'native-p024-unauthorized-')); roots.push(external);
    await writeFile(join(external, 'secret.ts'), 'export const secret = "UNAUTHORIZED_SOURCE";\n');
    await symlink(join(external, 'secret.ts'), join(f.root, 'escaped.ts'));
    const forged = { ...prior, ref: 'code-source:escaped.ts', locator: { kind: 'code' as const, id: 'source:escaped.ts', path: 'escaped.ts' } };
    await expect(adapter.readCurrent(forged)).rejects.toThrow('escapes repository');
    expect(await adapter.readCurrent({ ...prior, scope: { ...scope, workspaceId: 'other-workspace' } })).toBeNull();
  }, 30_000);
});
