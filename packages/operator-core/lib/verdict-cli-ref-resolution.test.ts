/**
 * Regression guard for verdict-cli accessibility refs.
 *
 * Refs are generated from the ARIA snapshot's accessible names. A substring
 * locator makes a ref for the exact "Location" field resolve to an earlier
 * field whose name merely contains "Location", so a fill silently writes to
 * the wrong control. This exercises the real CLI/daemon boundary and proves
 * that the ref remains bound to the field shown in the snapshot.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

describe('verdict-cli accessibility ref resolution', () => {
  it('fills the exact accessible-name match when another field contains its name', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'verdict-cli-ref-resolution-'));
    const dataDir = join(fixtureRoot, 'data');
    const sessionName = 'exact-name-match';
    const cli = require.resolve('verdict-cli/bin/browse.mjs');
    const page =
      '<!doctype html><label for="message">Message (include Location details)</label>' +
      '<input id="message"><label for="location">Location</label>' +
      '<input id="location"><button>Send</button>';
    const env = {
      ...process.env,
      VERDICT_DATA_DIR: dataDir,
      VERDICT_SESSION: sessionName,
      PAPERCUSP_SID: '',
      CODEX_SESSION_ID: '',
      VERDICT_START_TIMEOUT_MS: '10_000',
    };
    const run = async (...args: string[]) => {
      const result = await execFileAsync(process.execPath, [cli, ...args], {
        env,
        maxBuffer: 32 * 1024,
        timeout: 15_000,
      });
      return result.stdout;
    };

    try {
      await run('goto', `data:text/html,${encodeURIComponent(page)}`);
      const snapshot = await run('snapshot', '-i');
      expect(snapshot).toContain('@e1 - textbox "Message (include Location details)"');
      expect(snapshot).toContain('@e2 - textbox "Location"');

      await run('fill', '@e2', '123 Main St');
      const values = await run(
        'js',
        'JSON.stringify([...document.querySelectorAll("input")].map((input) => ({ id: input.id, value: input.value })))',
      );
      expect(JSON.parse(values)).toEqual([
        { id: 'message', value: '' },
        { id: 'location', value: '123 Main St' },
      ]);
    } finally {
      await run('stop').catch(() => undefined);
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  }, 45_000);
});
