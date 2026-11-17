import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml, stringify as toYaml } from 'yaml';
import {
  BlueprintSchema,
  SLOT_REGISTRY,
  compileAgentSpecification,
  replayAgentSpecification,
  snapshotPackageDirectory,
  specificationPrompt,
  validateAgentInputClosure,
} from '@papercusp/orchestrator/blueprint';
import {
  prepareBlueprintPublicRelease,
  readBlueprintLifecycle,
  rollbackBlueprintRelease,
  uninstallBlueprintRelease,
} from './blueprint-release';
import { InstallBlueprintError, installBlueprintFromCupboardCore, type InstallBlueprintCoreDeps } from './install-blueprint-core';
import type { IdentityInstallConsent } from './identity-install-consent';
import { listingManifestSigningBytes, unsignedListingManifest, type CupboardReleaseManifest } from './listing-manifest';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../identity/ed25519';

// Real publish snapshot/signing, install validation, immutable filesystem store,
// and specification compiler/replay are composed here. Only the network clone
// boundary is replaced with fixture transport; no production module is mocked.
// This is tree-plane integration, not a deployed Cupboard or live-session drive.
let root = '';

afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
  root = '';
});

async function fixture() {
  root = await fs.mkdtemp(join(tmpdir(), 'blueprint-release-integration-'));
  const installedDir = join(root, 'installed');
  const recipeDir = join(root, 'recipe');
  await fs.mkdir(recipeDir);
  await fs.writeFile(join(recipeDir, 'recipe.json'), '{"id":"identity-recipe","script":"return 1"}');
  const keypair = generateEd25519KeypairDer();
  const resolvePackage = async () => snapshotPackageDirectory({
    packageKind: 'recipe',
    ref: 'identity-recipe',
    revision: '1.0.0',
    dir: recipeDir,
    value: JSON.parse(await fs.readFile(join(recipeDir, 'recipe.json'), 'utf8')),
  });
  let signCalls = 0;
  const signer = {
    githubUserId: 42,
    githubLogin: 'publisher',
    devicePubkey: keypair.pubkeyBase64,
    sign: async (bytes: Uint8Array) => {
      signCalls += 1;
      return signWithPrivateKeyDer(keypair.privateKeyDer, Buffer.from(bytes));
    },
  };
  const publish = (sourceDir: string, id = 'identity', resolveExtends: (id: string) => string | null = () => null) => prepareBlueprintPublicRelease({
    blueprintFile: join(sourceDir, 'blueprint.yaml'),
    listingRef: id,
    resolveExtends,
    resolvePackage,
    signer,
    license: 'MIT',
  });
  // The bundled recipe is shared content, so every install is a two-step
  // review: the refusal names the subject, and the administrator echoes it
  // (portable identities P-014, D-034). Any other refusal passes through.
  const install = async (
    sourceDir: string,
    manifest: CupboardReleaseManifest,
    activationStack?: Array<{ id: string; slots: string[] }>,
  ) => {
    try {
      return await installWith(sourceDir, manifest, activationStack);
    } catch (error) {
      if (!(error instanceof InstallBlueprintError) || error.code !== 'identity_install_consent_required') throw error;
      const review = error.data as { consentSubject: IdentityInstallConsent; subjects: { sharedContent: string[] } };
      expect(review.subjects.sharedContent).toEqual(['recipe:identity-recipe']);
      return installWith(sourceDir, manifest, activationStack, review.consentSubject);
    }
  };
  const installWith = (
    sourceDir: string,
    manifest: CupboardReleaseManifest,
    activationStack?: Array<{ id: string; slots: string[] }>,
    identityInstallConsent?: IdentityInstallConsent,
  ) => installBlueprintFromCupboardCore({
    githubUrl: 'https://github.com/acme/identity',
    expectedRelease: { manifest },
    activationStack,
    ...(identityInstallConsent ? { identityInstallConsent } : {}),
  }, {
    cloneRepo: async (_url, destination) => fs.cp(sourceDir, destination, { recursive: true }),
    installedBlueprintsDir: () => installedDir,
    tmpDir: () => root,
    resolveExtends: () => null,
    resolvePackage,
    resolveHostSets: async () => ({
      availableTools: new Set<string>(),
      installedPlugins: new Set<string>(),
      cupboardPlugins: new Set<string>(),
      cupboardReachable: true,
    }),
  } satisfies InstallBlueprintCoreDeps);
  return { installedDir, publish, install, keypair, signCalls: () => signCalls };
}

async function writeBlueprint(version: string, prompt: string, id = 'identity') {
  const sourceDir = join(root, `${id}-${version}`);
  const yaml = [
    `id: ${id}`,
    `version: ${version}`,
    'slots: [{ slot: domain }]',
    'contributions: [{ id: identity-recipe, purpose: resource, source: fixed, refresh: source-change, inputKind: package, ref: "recipe:identity-recipe" }]',
  ].join('\n') + '\n';
  await fs.mkdir(join(sourceDir, 'prompts'), { recursive: true });
  await fs.writeFile(join(sourceDir, 'blueprint.yaml'), yaml);
  await fs.writeFile(join(sourceDir, 'prompts', 'persona.md'), prompt);
  return sourceDir;
}

describe('R-2 signed blueprint release lifecycle (integration)', () => {
  it('R-13: Cupboard publish refuses a stack whose two layers claim one single-layer slot, naming the slot', async () => {
    const f = await fixture();
    const paths = new Map<string, string>();
    for (const id of ['first', 'second', 'named-stack']) {
      const dir = join(root, id);
      await fs.mkdir(dir);
      paths.set(id, join(dir, 'blueprint.yaml'));
    }
    const stackDir = join(root, 'named-stack');
    await fs.writeFile(paths.get('named-stack')!, toYaml({
      id: 'named-stack', version: '1.0.0', slots: [], extends: ['first', 'second'],
    }));
    const resolve = (id: string) => paths.get(id) ?? null;
    const writeLayers = async (slot: string) => {
      for (const id of ['first', 'second']) {
        await fs.writeFile(paths.get(id)!, toYaml({ id, version: '1.0.0', slots: [{ slot }] }));
      }
    };
    for (const spec of SLOT_REGISTRY.filter((slot) => slot.cardinality === 'exclusive')) {
      await writeLayers(spec.slot);
      await expect(f.publish(stackDir, 'named-stack', resolve))
        .rejects.toThrow(new RegExp(`exclusive slot "${spec.slot}"`));
      expect(f.signCalls(), `${spec.slot} reached signing`).toBe(0);
      expect(existsSync(f.installedDir)).toBe(false);
    }
    await writeLayers('practice');
    // This is the authored named-stack summary, whose slots remain empty.
    // Successful signing is the positive control for the inherited practices.
    expect((await f.publish(stackDir, 'named-stack', resolve)).source.slots).toEqual([]);
    expect(f.signCalls()).toBeGreaterThan(0);
  });

  it('R-13: Cupboard publish refuses multi-slot layers and launch-only grants before signing', async () => {
    const f = await fixture();
    const dir = await writeBlueprint('1.0.0', 'portable prompt\n');
    const file = join(dir, 'blueprint.yaml');
    const valid = parseYaml(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
    for (const slots of [
      [{ slot: 'domain' }, { slot: 'practice' }],
      [{ slot: 'practice' }, { slot: 'practice' }],
    ]) {
      await fs.writeFile(file, toYaml({ ...valid, slots }));
      await expect(f.publish(dir)).rejects.toThrow(/one slot/);
    }
    for (const slot of ['client', 'fleet-posture']) {
      for (const grants of [{}, { requires: ['claims.record@1.0.0'] }, { optional: ['email.message@1.0.0'] }]) {
        await fs.writeFile(file, toYaml({ ...valid, slots: [{ slot }], grants }));
        await expect(f.publish(dir)).rejects.toThrow(new RegExp(`${slot}.*grants`));
      }
    }
    expect(f.signCalls()).toBe(0);
    expect(existsSync(f.installedDir)).toBe(false);
    await fs.writeFile(file, toYaml(valid));
    expect((await f.publish(dir)).source.slots).toEqual(['domain']);
    expect(f.signCalls()).toBeGreaterThan(0);
  });

  it('R-1: Cupboard publish refuses every workspace runtime key in an identity', async () => {
    // Change detector at the production signed-release boundary. No network or
    // signer substitute: invalid sources must fail before the real signer runs.
    const f = await fixture();
    const dir = await writeBlueprint('1.0.0', 'portable prompt\n');
    const file = join(dir, 'blueprint.yaml');
    const valid = parseYaml(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
    const workspace = BlueprintSchema.parse({ id: 'runtime', workItem: { kind: 'feature' }, spine: { edges: { DONE: { to: 'done' } } } });
    const portable = new Set(['id', 'extends', 'version', 'description', 'slots', 'contributions',
      'asks', 'grants', 'ceiling', 'floors', 'lexicon', 'mode', 'publisher', 'attestation']);
    for (const key of Object.keys(BlueprintSchema.shape).filter((key) => !portable.has(key))) {
      const value = key === 'dispatch' ? { costCapUsd: 1 } : (workspace as Record<string, unknown>)[key] ?? null;
      await fs.writeFile(file, toYaml({ ...valid, [key]: value }));
      await expect(f.publish(dir)).rejects.toThrow(new RegExp(`Unrecognized key.*${key}`));
      expect(f.signCalls(), `${key} reached the release signer`).toBe(0);
      expect(existsSync(f.installedDir)).toBe(false);
    }
    await fs.writeFile(file, toYaml(valid));
    expect((await f.publish(dir)).source.slots).toEqual(['domain']);
    expect(f.signCalls()).toBeGreaterThan(0);
  });

  it('R-1: Cupboard publish refuses an unknown identity key, naming the key', async () => {
    // Preservation/positive controls: unknown-key refusal and real valid signing.
    const f = await fixture();
    const dir = await writeBlueprint('1.0.0', 'portable prompt\n');
    const file = join(dir, 'blueprint.yaml');
    const valid = parseYaml(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
    await fs.writeFile(file, toYaml({ ...valid, syntheticUnknownPolicy: true }));
    await expect(f.publish(dir)).rejects.toThrow(/Unrecognized key.*syntheticUnknownPolicy/);
    expect(f.signCalls()).toBe(0);
    expect(existsSync(f.installedDir)).toBe(false);
    await fs.writeFile(file, toYaml(valid));
    expect((await f.publish(dir)).source.slots).toEqual(['domain']);
    expect(f.signCalls()).toBeGreaterThan(0);
  });

  it('publishes and installs signed closure bytes, preserving a compiled pin through no-op, update, rollback and uninstall', async () => {
    const { installedDir, publish, install } = await fixture();
    const sourceDir = await writeBlueprint('1.0.0', 'sell potatoes\n');
    const published = await publish(sourceDir);
    const first = await install(sourceDir, published.manifest.release);
    expect(first.operation).toBe('install');
    expect(first.release.contentHash).toBe(published.manifest.rootHash);
    expect(first.depCheck?.pins?.map((pin) => `${pin.packageKind}:${pin.ref}`).sort())
      .toEqual(published.source.archive.pins.map((pin) => `${pin.packageKind}:${pin.ref}`).sort());
    expect(first.depCheck?.pins?.map((pin) => pin.ref).sort()).toEqual(['identity', 'identity-recipe']);
    expect(await fs.readFile(join(installedDir, 'identity/prompts/persona.md'), 'utf8')).toBe('sell potatoes\n');
    const specification = compileAgentSpecification({
      source: { id: 'pinned-session', workItem: { kind: 'feature' }, spine: { edges: { DONE: { to: 'done' } } } },
      inputClosure: first.depCheck!.pins!,
      prompt: { files: [{ path: join(installedDir, 'identity/prompts/persona.md') }] },
    });
    const saved = JSON.stringify(specification);
    expect((await install(sourceDir, published.manifest.release)).operation).toBe('no-op');

    // Nothing but the prompt changes: no version bump can explain this diff.
    await fs.writeFile(join(sourceDir, 'prompts/persona.md'), 'sell excellent potatoes\n');
    const changed = await publish(sourceDir);
    expect(changed.manifest.rootHash).not.toBe(published.manifest.rootHash);
    const update = await install(sourceDir, changed.manifest.release);
    expect(update.operation).toBe('update');
    expect(update.release.packageContentHash).not.toBe(first.release.packageContentHash);
    expect(update.diff.promptText[0]?.patch).toContain('+sell excellent potatoes');
    expect(update.diff.burnKnobs).toEqual([
      { path: 'promptBytes', before: Buffer.byteLength('sell potatoes\n'), after: Buffer.byteLength('sell excellent potatoes\n') },
    ]);
    const rollback = await rollbackBlueprintRelease({
      installedDir, id: 'identity', target: first.release.packageContentHash,
    });
    expect(rollback).toMatchObject({ operation: 'rollback', activationRequired: true, record: { version: '1.0.0' } });
    expect(await fs.readFile(join(installedDir, 'identity/prompts/persona.md'), 'utf8')).toBe('sell potatoes\n');
    const removed = await uninstallBlueprintRelease({ installedDir, id: 'identity', nowMs: 3 });
    expect(removed).toMatchObject({ operation: 'uninstall', activationRequired: true });
    expect(existsSync(join(installedDir, 'identity'))).toBe(false);
    expect(removed.retained.map((release) => release.contentHash).sort())
      .toEqual([first.release.packageContentHash, update.release.packageContentHash].sort());
    const state = await readBlueprintLifecycle(installedDir, 'identity');
    expect(state.active).toBeNull();
    expect(state.releases).toHaveLength(2);
    const historicDir = join(installedDir, '.releases/identity', first.release.packageContentHash);
    expect(await fs.readFile(join(historicDir, 'content/prompts/persona.md'), 'utf8')).toBe('sell potatoes\n');
    const historic = JSON.parse(await fs.readFile(join(historicDir, 'closure.json'), 'utf8'));
    expect(validateAgentInputClosure(historic.pins)).toEqual(published.source.archive.pins);
    await fs.rm(sourceDir, { recursive: true });
    await fs.rm(join(root, 'recipe'), { recursive: true });
    const replayed = replayAgentSpecification(JSON.parse(saved));
    expect(replayed).toEqual(specification);
    expect(specificationPrompt(replayed)).toBe('sell potatoes\n');
  });

  it('refuses altered signatures, authentic wrong pins and tampered prompt bytes before replacing installed content', async () => {
    const { installedDir, publish, install, keypair } = await fixture();
    const sourceDir = await writeBlueprint('1.0.0', 'original prompt\n');
    const published = await publish(sourceDir);
    const manifest = published.manifest.release;
    const first = await install(sourceDir, manifest);
    await expect(install(sourceDir, { ...manifest, license: 'PROPRIETARY' }))
      .rejects.toThrow(/identity.*INVALID publisher signature/);
    const wrongPin = { ...unsignedListingManifest(manifest), contentHash: `sha256:${'0'.repeat(64)}` };
    await expect(install(sourceDir, {
      ...wrongPin,
      signature: signWithPrivateKeyDer(keypair.privateKeyDer, listingManifestSigningBytes(wrongPin)).toString('base64'),
    })).rejects.toThrow(/signed manifest for identity@1\.0\.0 pins/);
    await fs.writeFile(join(sourceDir, 'prompts/persona.md'), 'tampered prompt\n');
    await expect(install(sourceDir, manifest)).rejects.toThrow(/signed manifest for identity@1\.0\.0 pins/);
    expect((await readBlueprintLifecycle(installedDir, 'identity')).active?.contentHash)
      .toBe(first.release.packageContentHash);
    expect(await fs.readFile(join(installedDir, 'identity/prompts/persona.md'), 'utf8')).toBe('original prompt\n');
  });

  it('keeps installed alternatives inactive and refuses conflicting activation and exact pins in both orders', async () => {
    const { installedDir, publish, install } = await fixture();
    const a = await writeBlueprint('1.0.0', 'first persona\n');
    const b = await writeBlueprint('1.0.0', 'second persona\n', 'alternative');
    const publishedA = await publish(a);
    const publishedB = await publish(b, 'alternative');
    const first = await install(a, publishedA.manifest.release);
    expect((await install(b, publishedB.manifest.release)).operation).toBe('install');
    expect(await fs.readFile(join(installedDir, 'identity/prompts/persona.md'), 'utf8')).toBe('first persona\n');
    await expect(install(b, publishedB.manifest.release, [{ id: 'identity', slots: ['domain'] }]))
      .rejects.toThrow(/activation slot conflict.*domain/);
    await expect(install(a, publishedA.manifest.release, [{ id: 'alternative', slots: ['domain'] }]))
      .rejects.toThrow(/activation slot conflict.*domain/);
    await fs.writeFile(join(a, 'prompts/persona.md'), 'conflicting same-version bytes\n');
    const changed = await publish(a);
    for (const pins of [
      [...first.depCheck!.pins!, ...changed.source.archive.pins],
      [...changed.source.archive.pins, ...first.depCheck!.pins!],
    ]) {
      expect(() => validateAgentInputClosure(pins)).toThrow(/package-pin-conflict.*blueprint:identity/);
    }
  });
});
