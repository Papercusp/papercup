import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Only the exact post-read block belongs in source. The full machine-specific
// execution packet stays in the canonical artifact store, outside release source.
const proposal = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/bun-source-only-2929ed-proposal.json'), 'utf8'),
);
const command: string = proposal.postReadCommand;
if (!command) throw new Error('proposal post-read block is missing');
const guards = command;
const head = proposal.sourcePin as string;

describe('Bun source-only proposal post-read guards (D-020)', () => {
  let scratch: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'bun-source-read-guards-'));
    mkdirSync(join(scratch, 'bin'));
    mkdirSync(join(scratch, '.git'));
    writeFileSync(join(scratch, 'bin/git'), [
      '#!/bin/sh',
      'case "$3" in',
      '  rev-parse) printf "%s\\n" "$READ_HEAD_TEXT"; mode=$READ_HEAD_MODE ;;',
      '  status) printf "%s" "$READ_STATUS_TEXT"; mode=$READ_STATUS_MODE ;;',
      '  submodule) mode=$READ_SUBMODULE_MODE ;;',
      '  *) exit 97 ;;',
      'esac',
      'case "$mode" in',
      '  fail) exit 42 ;;',
      '  timeout) exec /bin/sleep 30 ;;',
      '  ok) exit 0 ;;',
      '  *) exit 98 ;;',
      'esac',
      '',
    ].join('\n'), { mode: 0o755 });
  });

  afterEach(() => rmSync(scratch, { recursive: true, force: true }));

  function run(overrides: Record<string, string> = {}) {
    // Exercise real GNU timeout, shortening deadlines without changing guard flow.
    const bounded = guards.replaceAll(proposal.destination, scratch)
      .replaceAll('timeout 10s ', 'timeout 0.15s ')
      .replaceAll('timeout 20s ', 'timeout 0.15s ');
    return spawnSync('/bin/bash', ['-c',
      'set -euo pipefail\n' + bounded + '\nprintf "%s\\n" POST_READ_READY\n',
    ], {
      encoding: 'utf8',
      timeout: 5_000,
      env: {
        ...process.env,
        PATH: join(scratch, 'bin') + ':/usr/bin:/bin',
        READ_HEAD_TEXT: head,
        READ_HEAD_MODE: 'ok',
        READ_STATUS_TEXT: '',
        READ_STATUS_MODE: 'ok',
        READ_SUBMODULE_MODE: 'ok',
        ...overrides,
      },
    });
  }

  it('has valid Bash syntax for the exact proposed post-read block', () => {
    const result = spawnSync('/bin/bash', ['-n'], { input: command, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
  });

  it('accepts successful exact HEAD, clean status and complete submodule reads', () => {
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('POST_READ_READY');
  });

  it.each([
    ['HEAD failure after correct output', { READ_HEAD_MODE: 'fail' }, 42],
    ['HEAD timeout after correct output', { READ_HEAD_MODE: 'timeout' }, 124],
    ['empty status failure', { READ_STATUS_MODE: 'fail' }, 42],
    ['empty status timeout', { READ_STATUS_MODE: 'timeout' }, 124],
    ['recursive submodule failure', { READ_SUBMODULE_MODE: 'fail' }, 42],
    ['recursive submodule timeout', { READ_SUBMODULE_MODE: 'timeout' }, 124],
    ['wrong successful HEAD', { READ_HEAD_TEXT: '0'.repeat(40) }, 1],
    ['dirty successful status', { READ_STATUS_TEXT: '?? untracked\n' }, 1],
  ])('rejects %s without publishing readiness', (_label, overrides, code) => {
    const result = run(overrides);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(code);
    expect(result.stdout).not.toContain('POST_READ_READY');
  });
});
