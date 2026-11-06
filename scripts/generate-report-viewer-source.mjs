/** Embed the typed reader as data so host compaction cannot change its source. */
import { readFileSync, writeFileSync } from 'node:fs';
import { transform } from 'esbuild';

const reader = new URL('../packages/operator-core/lib/report-sharing-browser.ts', import.meta.url);
const output = new URL('../packages/operator-core/lib/report-sharing-browser-source.ts', import.meta.url);
const { code } = await transform(readFileSync(reader, 'utf8'), {
  loader: 'ts', format: 'iife', globalName: 'PapercuspReportReader',
  target: 'es2022', minify: true, legalComments: 'none',
});
writeFileSync(output, '// Generated from report-sharing-browser.ts. Regenerate with node scripts/generate-report-viewer-source.mjs.\n'
  + 'export const REPORT_READER_SOURCE = ' + JSON.stringify(code) + ';\n');
