import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
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
] as const;

describe('host runtime packages use the plain Node loader', () => {
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
