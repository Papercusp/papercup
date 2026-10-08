/** Real Reports journey inside the maintained, owned, isolated Tauri verifier. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const isolated = process.env.PAPERCUSP_VERIFY_TAURI_ISOLATED === '1';

describe.skipIf(!isolated)('Reports library in the isolated native desktop', () => {
  it('publishes through the real tool and proves SSE, reader and agent controls in Tauri', async () => {
    const sourceRoot = process.env.OPERATOR_SOURCE_ROOT;
    expect(sourceRoot, 'Use scripts/verify-tauri-headless.sh with a committed source pin').toBeTruthy();
    expect(process.env.VERIFY_TAURI_SOURCE_RECEIPT, 'A verified source receipt is required').toBeTruthy();
    expect(process.env.PAPERCUSP_TEST_RUNS_DB_URL, 'Keep the result in the shared test ledger').toBeTruthy();
    expect(process.env.PAPERCUSP_APP_OPERATION_LIVE_PROFILE, 'Measure the owned running host').toBeTruthy();
    const receipt = JSON.parse(readFileSync(process.env.VERIFY_TAURI_SOURCE_RECEIPT!, 'utf8'));
    expect(receipt).toBeTypeOf('object');

    // The assertions and the host load the same frozen source. The maintained
    // driver owns fixture publication, DOM polling, source integrity and screenshots.
    const result = await execute(process.execPath, ['--import', 'tsx',
      join(sourceRoot!, 'scripts/tauri-surface-verify-reports.mts')], {
      cwd: sourceRoot, env: process.env, timeout: 280_000, maxBuffer: 4 * 1024 * 1024,
    });
    const match = result.stdout.match(/REPORTS_LIBRARY_TAURI_PASS evidence=(.+)/);
    expect(match, `${result.stdout}\n${result.stderr}`).not.toBeNull();
    const manifestPath = join(match![1].trim(), 'phases/native/manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(manifest.result).toBe('pass');
    expect(manifest.original).not.toBe(manifest.correction);
    expect(manifest.privatePeer).toBeTruthy();
    expect(manifest.checked).toEqual(expect.arrayContaining([
      'publish-tool', 'SSE-arrival', 'deep-link', 'metadata', 'Mermaid-render',
      'copy-exact-Markdown', 'immutable-citation', 'history-navigation',
      'agent-tools-filter-state-roundtrip', 'agent-tools-reader-close-reopen',
      'filter-negative-control', 'reader-width', 'human-owner-private-read',
    ]));
    // Preserve exact receipts in the recorded test output, so bindings can cite
    // the native evidence rather than substituting an earlier successful run.
    console.log(`REPORTS_NATIVE_E2E_MANIFEST=${manifestPath}`);
    console.log(`REPORTS_NATIVE_E2E_SOURCE_RECEIPT=${process.env.VERIFY_TAURI_SOURCE_RECEIPT}`);
  }, 300_000);
});
