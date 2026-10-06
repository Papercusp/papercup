import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
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
