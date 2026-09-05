import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildManifest } from '../../../scripts/p2p-witness-manifest.mjs';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'p2p-witness-manifest-'));
  await mkdir(join(root, 'libs/papercusp/libs/db/sql'), { recursive: true });
  await mkdir(join(root, 'libs/papercusp/packages/embedded-postgres-server/bin'), { recursive: true });
  await writeFile(join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');
  await writeFile(join(root, 'libs/papercusp/libs/db/sql/001.sql'), 'create table witness;\n');
  await writeFile(join(root, 'libs/papercusp/packages/embedded-postgres-server/bin/build-seed.mjs'), 'export {};\n');
  const output = join(root, 'out');
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'serve.mjs'), 'console.log("witness");\n');
  return { root, output };
}

describe('P2P witness manifest', () => {
  it('is deterministic and carries the source, runtime, migration, and seed identities', async () => {
    const f = await fixture();
    const args = {
      repoRoot: f.root,
      outputDir: f.output,
      sourceSha: 'source-a',
      submoduleSha: 'submodule-a',
    };
    const first = await buildManifest(args);
    const second = await buildManifest(args);
    expect(second).toEqual(first);
    expect(first.inputs.source).toEqual({ superprojectSha: 'source-a', papercuspSha: 'submodule-a' });
    expect(first.inputs.runtime.bundleSha256).toHaveLength(64);
    expect(first.inputs.migrations[0].sha256).toHaveLength(64);
    expect(first.inputs.seeds[0].sha256).toHaveLength(64);
  });

  it('changes the artifact identity when an optional pack changes', async () => {
    const f = await fixture();
    const model = join(f.root, 'model-pack');
    await mkdir(model);
    await writeFile(join(model, 'weights.bin'), 'v1');
    const first = await buildManifest({ repoRoot: f.root, outputDir: f.output, sourceSha: 'source-a', submoduleSha: 'submodule-a', modelPackPath: model });
    await writeFile(join(model, 'weights.bin'), 'v2');
    const second = await buildManifest({ repoRoot: f.root, outputDir: f.output, sourceSha: 'source-a', submoduleSha: 'submodule-a', modelPackPath: model });
    expect(first.inputs.optionalPacks.model?.sha256).not.toBe(second.inputs.optionalPacks.model?.sha256);
    expect(first.artifactId).not.toBe(second.artifactId);
  });

  it('uses canonical JSON for a stable manifest payload', async () => {
    const f = await fixture();
    const manifest = await buildManifest({ repoRoot: f.root, outputDir: f.output, sourceSha: 'source-a', submoduleSha: 'submodule-a' });
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.artifactId).toMatch(/^[0-9a-f]{64}$/);
    expect(await readFile(join(f.output, 'serve.mjs'), 'utf8')).toContain('witness');
  });
});
