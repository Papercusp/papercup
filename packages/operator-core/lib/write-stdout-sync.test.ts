/**
 * EI-21465977848777714 — synchronous stdout has two distinct contracts.
 *
 * Line-oriented diagnostics keep the historical "append one newline" behavior.
 * Byte-oriented reads such as `set-doc-part --show` must preserve the payload exactly,
 * including whether a final newline is absent, present, or repeated. Exercise the real
 * file descriptor writer in a child process so a test-double cannot hide transport drift.
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const WRITER_URL = pathToFileURL(resolve(REPO_ROOT, 'scripts/lib/write-stdout-sync.mjs')).href;

function runWriter(exportName: 'writeStdoutSync' | 'writeStdoutExactSync', payload: string): Buffer {
  const program = [
    `import { ${exportName} as write } from ${JSON.stringify(WRITER_URL)};`,
    "write(Buffer.from(process.argv[1] ?? '', 'base64').toString('utf8'));",
  ].join('\n');
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', program, Buffer.from(payload).toString('base64')],
    { encoding: 'buffer', timeout: 10_000, killSignal: 'SIGKILL' },
  );

  expect(result.status, result.stderr.toString('utf8')).toBe(0);
  return result.stdout;
}

describe('writeStdoutExactSync', () => {
  it.each(['body without terminator', 'body with one terminator\n', 'body with two terminators\n\n', ''])(
    'preserves the exact UTF-8 payload bytes for %j',
    (payload) => {
      expect(runWriter('writeStdoutExactSync', payload)).toEqual(Buffer.from(payload));
    },
  );
});

describe('writeStdoutSync', () => {
  it('retains the existing line-oriented trailing-newline contract', () => {
    expect(runWriter('writeStdoutSync', 'diagnostic')).toEqual(Buffer.from('diagnostic\n'));
    expect(runWriter('writeStdoutSync', 'diagnostic\n')).toEqual(Buffer.from('diagnostic\n'));
  });
});
