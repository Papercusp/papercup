import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { builtinBlueprintPath, layerContentHash, snapshotPackageDirectory } from '@papercusp/orchestrator/blueprint';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { getIdentitySource } from '../agent-identities/source';
import { commitBlueprintRelease, readBlueprintLifecycle, snapshotBlueprintReleaseSource,
  snapshotInstalledBlueprintPackage } from './blueprint-release';
import {
  OFFICIAL_BLUEPRINT_PUBLISHER,
  prepareOfficialIdentityMetadataTransition,
  stampIdentityAttestation,
  stampMirrorIdentityAttestations,
} from './identity-attestation';

// The official identities the identities-v1 R-7 journey installs from the Cupboard.
const OFFICIAL_IDENTITIES = ['papercusp-engineer', 'su.fleet-leader', 'su.fleet-member'] as const;

describe('stampIdentityAttestation (identities-v1 D-124)', () => {
  let root: string;
  let priorHome: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'identity-attestation-'));
    priorHome = process.env.PAPERCUSP_HOME;
    process.env.PAPERCUSP_HOME = root;
  });

  afterEach(async () => {
    if (priorHome === undefined) delete process.env.PAPERCUSP_HOME;
    else process.env.PAPERCUSP_HOME = priorHome;
    await rm(root, { recursive: true, force: true });
  });

  /** Place a built-in identity dir into the INSTALLED tier, optionally stamped. */
  async function install(id: string, stamp: boolean): Promise<string> {
    const source = join(builtinBlueprintPath(id), '..');
    const dir = join(root, 'blueprints', id);
    await mkdir(join(root, 'blueprints'), { recursive: true });
    await cp(source, dir, { recursive: true });
    if (stamp) {
      const file = join(dir, 'blueprint.yaml');
      const result = stampIdentityAttestation(await readFile(file, 'utf8'), 'papercupai');
      expect(result.stamped).toBe(true);
      await writeFile(file, result.text);
    }
    return dir;
  }

  it.each(OFFICIAL_IDENTITIES)('an installed, stamped %s passes the identity path', async (id) => {
    await install(id, true);
    const source = await getIdentitySource(id);
    expect(source.ok, JSON.stringify('errors' in source ? source.errors : source)).toBe(true);
    // It resolved from the installed tier, not the built-in fallback.
    expect('sourcePath' in source ? source.sourcePath : null).toBe(join(root, 'blueprints', id, 'blueprint.yaml'));
  });

  it.each(OFFICIAL_IDENTITIES)('control: the same installed %s WITHOUT the stamp is refused', async (id) => {
    await install(id, false);
    const source = await getIdentitySource(id);
    expect(source).toMatchObject({ ok: false, errors: [expect.objectContaining({ code: 'attestation-missing' })] });
  });

  it('attests the layer content hash, which excludes the attestation block itself', async () => {
    const text = 'id: zz-domain\n# a comment that must survive\nextends: base\nslots:\n  - slot: domain\n';
    const out = stampIdentityAttestation(text, 'papercupai');
    const raw = parseYaml(out.text) as Record<string, unknown>;
    expect(out.contentHash).toBe(layerContentHash(parseYaml(text)));
    expect(raw.attestation).toEqual({ contentHash: layerContentHash(raw), signedBy: 'papercupai' });
    expect(out.text).toContain('# a comment that must survive');
  });

  it('is idempotent and re-stamps a stale block after an edit', () => {
    const first = stampIdentityAttestation('id: zz\nslots:\n  - slot: domain\n', 'papercupai');
    expect(stampIdentityAttestation(first.text, 'papercupai').text).toBe(first.text);
    const edited = first.text.replace('id: zz', 'id: zz\ndescription: changed');
    const restamped = stampIdentityAttestation(edited, 'papercupai');
    expect(restamped.contentHash).not.toBe(first.contentHash);
    expect((parseYaml(restamped.text) as { attestation: { contentHash: string } }).attestation.contentHash)
      .toBe(restamped.contentHash);
  });

  it('leaves a non-identity blueprint untouched', () => {
    const text = 'id: zz-pot\nextends: base\n';
    expect(stampIdentityAttestation(text, 'papercupai')).toEqual({ text, stamped: false, contentHash: null });
  });

  it('stamps only the identity documents of a mirror built from the real built-in tree', async () => {
    const mirror = join(root, 'mirror');
    const ids = [...OFFICIAL_IDENTITIES, 'base'];
    for (const id of ids) await cp(join(builtinBlueprintPath(id), '..'), join(mirror, id), { recursive: true });
    const baseBefore = await readFile(join(mirror, 'base', 'blueprint.yaml'), 'utf8');

    const stamped = stampMirrorIdentityAttestations(mirror, ids);

    expect(stamped.map((entry) => entry.id)).toEqual([...OFFICIAL_IDENTITIES]);
    expect(await readFile(join(mirror, 'base', 'blueprint.yaml'), 'utf8')).toBe(baseBefore);
    for (const { id, contentHash } of stamped) {
      const raw = parseYaml(await readFile(join(mirror, id, 'blueprint.yaml'), 'utf8')) as Record<string, unknown>;
      expect(raw.attestation).toEqual({ contentHash, signedBy: OFFICIAL_BLUEPRINT_PUBLISHER });
      expect(layerContentHash(raw)).toBe(contentHash);
    }
    // A second sync over an already-stamped mirror is a no-op.
    const again = stampMirrorIdentityAttestations(mirror, ids);
    expect(again).toEqual(stamped);
  });

  it('refuses an empty publisher', () => {
    expect(() => stampIdentityAttestation('id: zz\nslots:\n  - slot: domain\n', ' ')).toThrow(/signedBy is required/);
  });

  const portable = { id: 'papercusp-engineer', version: '0.1.2', extends: 'identity-root',
    description: 'Engineering profession', slots: [{ slot: 'domain' }] };
  const legacy = (changes: Record<string, unknown> = {}, publisher = OFFICIAL_BLUEPRINT_PUBLISHER) => {
    const raw = { ...portable, extends: 'base', visibility: 'public', ...changes };
    return stringifyYaml({ ...raw, attestation: { contentHash: layerContentHash(raw), signedBy: publisher } });
  };

  it('converts only official legacy metadata, preserving comments and re-attesting the strict portable document', () => {
    const original = '# preserve this installed comment\n' + legacy();
    const result = prepareOfficialIdentityMetadataTransition(original, stringifyYaml(portable));
    const raw = parseYaml(result.text);
    expect(raw).toEqual({ ...portable,
      attestation: { contentHash: layerContentHash(portable), signedBy: OFFICIAL_BLUEPRINT_PUBLISHER } });
    expect(result.text).toContain('# preserve this installed comment');
    expect(result.stamped).toBe(true);
    expect(original).toContain('visibility: public');
  });

  it('converts an installed official package through retained releases and restores strict installed source loading', async () => {
    const id = 'papercusp-engineer';
    const installedDir = join(root, 'blueprints');
    const originalDir = join(root, 'legacy-source');
    const currentText = await readFile(builtinBlueprintPath(id), 'utf8');
    const raw = { ...parseYaml(currentText), extends: 'base', visibility: 'public' };
    const oldText = stringifyYaml({ ...raw,
      attestation: { contentHash: layerContentHash(raw), signedBy: OFFICIAL_BLUEPRINT_PUBLISHER } });
    await cp(join(builtinBlueprintPath(id), '..'), originalDir, { recursive: true });
    await writeFile(join(originalDir, 'blueprint.yaml'), oldText);
    const pin = snapshotPackageDirectory({ dir: originalDir, packageKind: 'blueprint', ref: id,
      revision: raw.version, value: parseYaml(oldText) });
    const oldRelease = await commitBlueprintRelease({ installedDir, sourceDir: originalDir, id,
      version: raw.version, source: 'official legacy fixture', pins: [pin] });
    expect((await getIdentitySource(id)).ok).toBe(false);
    const before = snapshotInstalledBlueprintPackage(installedDir, id);
    const candidate = join(root, 'candidate');
    await cp(oldRelease.installedTo, candidate, { recursive: true });
    const transformed = prepareOfficialIdentityMetadataTransition(oldText, currentText);
    await writeFile(join(candidate, 'blueprint.yaml'), transformed.text);
    const prepared = await snapshotBlueprintReleaseSource({ blueprintFile: join(candidate, 'blueprint.yaml'),
      resolveExtends: ref => builtinBlueprintPath(ref) });
    const applied = await commitBlueprintRelease({ installedDir, sourceDir: candidate, id,
      version: prepared.version, source: 'local official metadata transition', pins: prepared.archive.pins,
      expectedInstalledPackageHash: before.contentHash });
    expect(applied.operation).toBe('update');
    const selected = await getIdentitySource(id);
    expect(selected.ok, JSON.stringify(selected)).toBe(true);
    expect('sourcePath' in selected ? selected.sourcePath : null)
      .toBe(join(installedDir, id, 'blueprint.yaml'));
    expect(await readFile(join(oldRelease.historyDir, 'content/blueprint.yaml'), 'utf8')).toBe(oldText);
    expect((await readBlueprintLifecycle(installedDir, id)).releases).toHaveLength(2);
    const after = snapshotInstalledBlueprintPackage(installedDir, id);
    expect(after.files.filter(file => file.path !== 'blueprint.yaml'))
      .toEqual(before.files.filter(file => file.path !== 'blueprint.yaml'));
  });

  it.each([
    { description: 'custom profession' }, { version: '99.0.0' }, { id: 'other' },
    { grants: { requires: ['admin:*'] } }, { visibility: 'private' }, { extends: 'custom-parent' },
  ])('refuses semantic or unsupported legacy changes: %j', changes => {
    expect(() => prepareOfficialIdentityMetadataTransition(legacy(changes), stringifyYaml(portable)))
      .toThrow(/semantics differ|unsupported legacy/);
  });

  it('refuses missing, stale and non-official attestations', () => {
    for (const text of [stringifyYaml({ ...portable, extends: 'base', visibility: 'public' }),
      legacy().replace('Engineering profession', 'changed after attesting'), legacy({}, 'someone-else')]) {
      expect(() => prepareOfficialIdentityMetadataTransition(text, stringifyYaml(portable)))
        .toThrow(/invalid prior official attestation/);
    }
  });

  it('refuses mode transitions and malformed or non-identity inputs', () => {
    for (const builtin of [stringifyYaml({ id: 'workspace' }),
      stringifyYaml({ ...portable, mode: { policyRef: 'auto' } }), 'slots: [']) {
      expect(() => prepareOfficialIdentityMetadataTransition(legacy(), builtin)).toThrow();
    }
    expect(() => prepareOfficialIdentityMetadataTransition('null', stringifyYaml(portable))).toThrow();
  });
});
