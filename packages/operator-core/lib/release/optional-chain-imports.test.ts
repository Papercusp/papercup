import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// HOST uses one ESM bundle without splitting. An internal dynamic import does
// not defer a static external import: esbuild hoists it into the entry module.
describe('optional chain SDK imports in the single-file HOST bundle', () => {
  for (const leaf of [
    '../agent-tools/pot/equity.ts',
    '../cupboard/ledger-anchor-eas.ts',
    '../cupboard/transparency-statement.ts',
  ]) {
    it(`keeps the viem client entry out of startup for ${leaf}`, async () => {
      const result = await build({
        entryPoints: [fileURLToPath(new URL(leaf, import.meta.url))],
        bundle: true,
        platform: 'node',
        format: 'esm',
        packages: 'external',
        treeShaking: false,
        write: false,
        metafile: true,
      });
      const imports = Object.values(result.metafile!.outputs).flatMap(output => output.imports);
      expect(imports.filter(item => item.path === 'viem' && item.kind === 'import-statement')).toEqual([]);
      // The check must inspect real package boundaries, not an empty artifact.
      expect(imports.some(item => item.path.startsWith('viem'))).toBe(true);
    });
  }
});

describe('optional AWS SDK imports in the single-file HOST bundle', () => {
  for (const leaf of [
    '../workspace-host/aws-configured-provider.ts',
    '../workspace-host/hosted-aws-host-discovery.ts',
  ]) {
    it(`defers EC2 and SSM loading for ${leaf}`, async () => {
      const entry = fileURLToPath(new URL(leaf, import.meta.url));
      const result = await build({
        entryPoints: [entry],
        bundle: true,
        platform: 'node',
        format: 'esm',
        packages: 'external',
        treeShaking: false,
        write: false,
        metafile: true,
      });
      const imports = Object.values(result.metafile!.outputs).flatMap(output => output.imports);
      expect(imports.filter(item => item.kind === 'import-statement' &&
        ['@aws-sdk/client-ec2', '@aws-sdk/client-ssm'].includes(item.path))).toEqual([]);
      expect(Object.keys(result.metafile!.inputs).some(path => path.endsWith('aws-sdk-client.ts'))).toBe(true);
    });
  }
});

describe('optional SDK inclusion in packaged bundles', () => {
  it('constructs the packaged synchronous EAS backend without runtime node_modules', async () => {
    const root = mkdtempSync(join(tmpdir(), 'packaged-eas-'));
    try {
      const result = await build({
        stdin: { contents: `
          import { easAnchorBackend, ANCHOR_CHAINS } from '../cupboard/ledger-anchor-eas';
          import { http } from 'viem';
          const backend = easAnchorBackend({ chain: ANCHOR_CHAINS[84532].chain,
            transport: http('http://127.0.0.1:1'), privateKey: '0x' + '01'.repeat(32) });
          console.log(JSON.stringify({ kind: backend.kind, attester: backend.attester }));
        `, resolveDir: dirname(fileURLToPath(import.meta.url)), loader: 'ts' },
        bundle: true,
        platform: 'node',
        format: 'esm',
        // The same native require bridge used by HOST and desktop bundles.
        banner: { js: "import { createRequire as nativeRequire } from 'node:module'; const require = nativeRequire(import.meta.url);" },
        write: false,
      });
      const entry = join(root, 'entry.mjs');
      writeFileSync(entry, result.outputFiles![0].text);
      const run = spawnSync(process.execPath, [entry], { cwd: root, encoding: 'utf8', timeout: 20_000,
        env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' } });
      expect(run.error).toBeUndefined();
      expect(run.status, run.stderr).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual({ kind: 'eas', attester: '0x1a642f0E3c3aF545E7AcBD38b07251B3990914F1' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  for (const [leaf, required] of [
    ['../cupboard/ledger-anchor-eas.ts', ['viem']],
    ['../workspace-host/aws-sdk-client.ts', ['@aws-sdk/client-ec2', '@aws-sdk/client-ssm']],
    ['../workspace-host/hosted-aws-host-discovery.ts', ['@aws-sdk/client-ec2']],
  ] as const) {
    it(`retains statically discoverable SDK dependencies for ${leaf}`, async () => {
      const require = createRequire(import.meta.url);
      const result = await build({
        entryPoints: [fileURLToPath(new URL(leaf, import.meta.url))],
        bundle: true,
        platform: 'node',
        format: 'esm',
        packages: 'external',
        write: false,
        metafile: true,
        // Only inline the dependencies under test. Other package boundaries
        // remain external so this is a focused distribution-contract check.
        plugins: [{ name: 'package-sdk-under-test', setup(builder) {
          builder.onResolve({ filter: /^(viem|@aws-sdk\/client-(ec2|ssm))$/ }, args =>
            ({ path: require.resolve(args.path) }));
        } }],
      });
      const inputs = Object.keys(result.metafile!.inputs);
      for (const sdk of required) expect(inputs.some(path => path.includes(`node_modules/${sdk}/`)), sdk).toBe(true);
    });
  }
});
