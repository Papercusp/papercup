import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

const hostEntry = resolve(__dirname, '../../../apps/operator/dist-host/hono-host.mjs');
const packages = [
  ['undici', 'Agent'],
  ['@dbos-inc/dbos-sdk', 'DBOS'],
  ['mingo', 'aggregate'],
  ['acorn', 'parse'],
  ['fast-check', 'assert'],
  ['@mcp-ui/server', 'createUIResource'],
  ['viem', 'parseEther'],
  ['iconv-lite', 'encode'],
  ['@smithy/core', 'getSmithyContext'],
  ['@aws-sdk/client-ec2', 'EC2Client'],
  ['@aws-sdk/client-ssm', 'SSMClient'],
] as const;

describe('host runtime packages use the plain Node loader', () => {
  it('prepares external dependencies for a custom output, preserving existing trees and refusing broken links', () => {
    const root = mkdtempSync(join(tmpdir(), 'host-external-output-'));
    try {
      const repo = join(root, 'checkout');
      const output = join(root, 'private-output');
      const packageDir = join(repo, 'node_modules', 'external-fixture');
      mkdirSync(packageDir, { recursive: true });
      mkdirSync(output);
      writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ type: 'module', exports: './index.js' }));
      writeFileSync(join(packageDir, 'index.js'), 'export const value = "checkout";');
      const entry = join(output, 'host.mjs');
      writeFileSync(entry, 'import { value } from "external-fixture"; console.log(value);');
      expect(() => execFileSync(process.execPath, [entry], { stdio: 'pipe' })).toThrow();

      const recipe = readFileSync(resolve(__dirname, '../../../apps/operator/bin/bundle-host.sh'), 'utf8');
      const prepare = recipe.split('# >>> custom-output runtime dependencies (EI-25510203057543967)\n')[1]!
        .split('# <<< custom-output runtime dependencies')[0]!;
      const run = () => execFileSync('bash', ['-c', `set -euo pipefail\n${prepare}\nprepare_host_runtime_dependencies "$1" "$2"`, 'test', repo, output], { stdio: 'pipe' });
      run();
      run();
      expect(readlinkSync(join(output, 'node_modules'))).toBe(join(repo, 'node_modules'));
      expect(execFileSync(process.execPath, [entry], { encoding: 'utf8' }).trim()).toBe('checkout');

      rmSync(join(output, 'node_modules'));
      const supplied = join(output, 'node_modules', 'external-fixture');
      mkdirSync(supplied, { recursive: true });
      writeFileSync(join(supplied, 'package.json'), JSON.stringify({ type: 'module', exports: './index.js' }));
      writeFileSync(join(supplied, 'index.js'), 'export const value = "caller";');
      run();
      expect(execFileSync(process.execPath, [entry], { encoding: 'utf8' }).trim()).toBe('caller');

      rmSync(join(output, 'node_modules'), { recursive: true });
      symlinkSync(join(root, 'missing'), join(output, 'node_modules'));
      expect(run).toThrow();
      expect(readlinkSync(join(output, 'node_modules'))).toBe(join(root, 'missing'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the generated AWS SDK source outside the maintained host bundle boundary', async () => {
    const recipe = readFileSync(resolve(__dirname, '../../../apps/operator/bin/bundle-host.sh'), 'utf8');
    const runtimeBoundary = recipe.match(/^HOST_EXTERNALS\+=\(([\s\S]*?)^\)/m)?.[1];
    expect(runtimeBoundary).toBeDefined();
    const external = [...runtimeBoundary!.matchAll(/--external:([^\s#]+)/g)].map(match => match[1]!);
    const options = {
      stdin: {
        contents: "import { EC2Client } from '@aws-sdk/client-ec2'; import { SSMClient } from '@aws-sdk/client-ssm'; console.log(EC2Client.name, SSMClient.name);",
        // The production builder runs from apps/operator. dist-host is a
        // generated output directory and is absent in a clean test checkout.
        resolveDir: resolve(dirname(hostEntry), '..'),
      },
      bundle: true, platform: 'node' as const, format: 'cjs' as const, write: false, metafile: true,
    };
    const result = await build({ ...options, external });
    // Removing either SDK's real recipe boundary pulls megabytes of generated
    // package source into this otherwise tiny graph; loadability is checked below.
    expect(Object.keys(result.metafile!.inputs).filter(file => /node_modules\/(?:@aws-sdk|@smithy)\//.test(file))).toEqual([]);
    expect(result.outputFiles![0]!.contents.byteLength).toBeLessThan(16_384);
    const inlined = await build({ ...options, external: external.filter(name => !name.startsWith('@aws-sdk/')) });
    expect(Object.keys(inlined.metafile!.inputs).some(file => /node_modules\/@aws-sdk\//.test(file))).toBe(true);
    expect(inlined.outputFiles![0]!.contents.byteLength - result.outputFiles![0]!.contents.byteLength).toBeGreaterThan(1_000_000);
  });

  it.each(packages)('%s resolves compiled JavaScript and supplies %s beside the host', (name, symbol) => {
    // Use a fresh plain Node process: Vitest's TypeScript loader would hide a
    // source-only dependency that the bundled production entry cannot load.
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { createRequire } from 'node:module';
      import { pathToFileURL } from 'node:url';
      const [entry, name, symbol] = process.argv.slice(1);
      const file = createRequire(entry).resolve(name);
      const value = await import(pathToFileURL(file).href);
      console.log(JSON.stringify({ file, type: typeof (value[symbol] ?? value.default?.[symbol]) }));
    `, hostEntry, name, symbol], { encoding: 'utf8', timeout: 15_000 });
    const result = JSON.parse(output) as { file: string; type: string };
    expect(result.file).toMatch(/\.(?:c|m)?js$/);
    expect(result.type).toBe('function');
  });
});
