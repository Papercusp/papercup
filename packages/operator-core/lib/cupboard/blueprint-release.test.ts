import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pinPackageInput } from '@papercusp/orchestrator/blueprint';
import {
  BlueprintLifecycleError,
  commitBlueprintRelease,
  prepareBlueprintPublicRelease,
  readBlueprintLifecycle,
  rollbackBlueprintRelease,
  uninstallBlueprintRelease,
} from './blueprint-release';
import { prepareReleaseForPublish } from './publish-release-gate';

let root = '';
let installedDir = '';

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'blueprint-release-'));
  installedDir = join(root, 'blueprints');
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function source(version: string, prompt: string, maxCostUsd: number) {
  const dir = join(root, `source-${version}`);
  const yaml =
    ['id: identity', `version: ${version}`, 'slots: [{ slot: domain }]', `knobs: { maxCostUsd: ${maxCostUsd} }`].join(
      '\n',
    ) + '\n';
  await fs.mkdir(join(dir, 'prompts'), { recursive: true });
  await fs.writeFile(join(dir, 'blueprint.yaml'), yaml);
  await fs.writeFile(join(dir, 'prompts', 'persona.md'), prompt);
  const pin = pinPackageInput({
    packageKind: 'blueprint',
    ref: 'identity',
    revision: version,
    files: [
      { path: 'blueprint.yaml', bytes: yaml },
      { path: 'prompts/persona.md', bytes: prompt },
    ],
    value: { id: 'identity', version, slots: [{ slot: 'domain' }], knobs: { maxCostUsd } },
  });
  return { dir, pin };
}

describe('immutable blueprint release lifecycle', () => {
  it('installs, updates with exact prompt/knob diffs, rolls back, and uninstalls without erasing pinned history', async () => {
    const v1 = await source('1.0.0', 'sell potatoes\n', 2);
    const first = await commitBlueprintRelease({
      installedDir,
      sourceDir: v1.dir,
      id: 'identity',
      version: '1.0.0',
      source: 'https://github.com/acme/identity',
      pins: [v1.pin],
      nowMs: 1,
    });
    expect(first.operation).toBe('install');
    expect(first.activationPreflight.ok).toBe(true);

    const v2 = await source('2.0.0', 'sell excellent potatoes\n', 5);
    const update = await commitBlueprintRelease({
      installedDir,
      sourceDir: v2.dir,
      id: 'identity',
      version: '2.0.0',
      source: 'https://github.com/acme/identity',
      pins: [v2.pin],
      nowMs: 2,
    });
    expect(update.operation).toBe('update');
    expect(update.diff.promptText[0]).toMatchObject({ path: 'identity/prompts/persona.md' });
    expect(update.diff.promptText[0]!.patch).toContain('-sell potatoes');
    expect(update.diff.promptText[0]!.patch).toContain('+sell excellent potatoes');
    expect(update.diff.burnKnobs).toEqual([{ path: 'maxCostUsd', before: 2, after: 5 }]);
    expect(await fs.readFile(join(installedDir, 'identity/prompts/persona.md'), 'utf8')).toContain('excellent');

    const rollback = await rollbackBlueprintRelease({ installedDir, id: 'identity', target: '1.0.0' });
    expect(rollback).toMatchObject({ operation: 'rollback', activationRequired: true, record: { version: '1.0.0' } });
    expect(await fs.readFile(join(installedDir, 'identity/prompts/persona.md'), 'utf8')).toBe('sell potatoes\n');

    const removed = await uninstallBlueprintRelease({ installedDir, id: 'identity', nowMs: 3 });
    expect(removed).toMatchObject({ operation: 'uninstall', activationRequired: true });
    expect(existsSync(join(installedDir, 'identity'))).toBe(false);
    expect(removed.retained.map((release) => release.version).sort()).toEqual(['1.0.0', '2.0.0']);
    const state = await readBlueprintLifecycle(installedDir, 'identity');
    expect(state.active).toBeNull();
    expect(state.releases).toHaveLength(2);
    for (const release of state.releases) {
      expect(
        existsSync(join(installedDir, '.releases', 'identity', release.contentHash, 'content/blueprint.yaml')),
      ).toBe(true);
    }
  });

  it('repairs active-dir drift on a package no-op', async () => {
    const v1 = await source('1.0.0', 'persona\n', 1);
    await commitBlueprintRelease({
      installedDir,
      sourceDir: v1.dir,
      id: 'identity',
      version: '1.0.0',
      source: 'repo',
      pins: [v1.pin],
    });
    await fs.writeFile(join(installedDir, 'identity/stale.txt'), 'stale');
    const again = await commitBlueprintRelease({
      installedDir,
      sourceDir: v1.dir,
      id: 'identity',
      version: '1.0.0',
      source: 'repo',
      pins: [v1.pin],
    });
    expect(again.operation).toBe('no-op');
    expect(existsSync(join(installedDir, 'identity/stale.txt'))).toBe(false);
  });

  it('refuses a listed-content mismatch and an exclusive-slot activation conflict before changing the active package', async () => {
    const v1 = await source('1.0.0', 'persona\n', 1);
    await expect(
      commitBlueprintRelease({
        installedDir,
        sourceDir: v1.dir,
        id: 'identity',
        version: '1.0.0',
        source: 'repo',
        pins: [v1.pin],
        expectedRelease: { contentHash: `sha256:${'0'.repeat(64)}` },
      }),
    ).rejects.toBeInstanceOf(BlueprintLifecycleError);
    expect(existsSync(join(installedDir, 'identity'))).toBe(false);

    await expect(
      commitBlueprintRelease({
        installedDir,
        sourceDir: v1.dir,
        id: 'identity',
        version: '1.0.0',
        source: 'repo',
        pins: [v1.pin],
        activationStack: [{ id: 'other-domain', slots: ['domain'] }],
      }),
    ).rejects.toThrow(/activation slot conflict.*domain/);
    expect(existsSync(join(installedDir, 'identity'))).toBe(false);
  });

  it('builds a signed publish-release manifest over the complete closure bytes', async () => {
    const v1 = await source('1.0.0', 'persona\n', 1);
    const prepared = await prepareBlueprintPublicRelease({
      blueprintFile: join(v1.dir, 'blueprint.yaml'),
      listingRef: 'identity',
      resolveExtends: () => null,
      signer: {
        githubUserId: 7,
        githubLogin: 'publisher',
        devicePubkey: 'device-key',
        sign: async (bytes) => Buffer.from(`signed:${bytes.length}`),
      },
    });
    expect(prepared.manifest.release).toMatchObject({
      listingKind: 'blueprint',
      listingRef: 'identity',
      releaseVersion: '1.0.0',
      publisher: { githubUserId: 7 },
    });
    expect(prepared.manifest.rootHash).toBe(prepared.source.archive.package.rootHash);
    expect(prepared.manifest.release.contentHash).toBe(prepared.source.archive.package.rootHash);
    expect(prepared.manifest.release.signature).toMatch(/^c2lnbmVkOj/);
    expect((prepared.release as { bytes?: Buffer }).bytes?.equals(prepared.source.archive.bytes)).toBe(true);
    expect(await prepareReleaseForPublish(prepared.release)).toMatchObject({ ok: true });
  });
});
