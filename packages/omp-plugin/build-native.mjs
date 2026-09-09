/** Package-owned JS artifacts: plain Node and installed OMP need no TS loader. */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const common = { bundle: true, platform: 'node', target: 'node20', packages: 'bundle', logLevel: 'warning' };
await build({
  ...common, entryPoints: [root + 'packages/operator-core/lib/agent-mcp-client.ts'],
  outfile: root + 'packages/omp-plugin/dist/native-client.cjs', format: 'cjs',
});
await build({
  ...common, entryPoints: [root + 'packages/omp-plugin/src/native-extension.ts'],
  outfile: root + 'packages/omp-plugin/dist/native-extension.mjs', format: 'esm',
  banner: { js: "import { createRequire as createNativeRequire } from 'node:module'; const require = createNativeRequire(import.meta.url);" },
});
