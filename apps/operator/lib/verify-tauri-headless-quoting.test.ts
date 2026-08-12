/**
 * EI-20207763368144905 — quote-safe HUD assertions for verify-tauri-headless.
 *
 * A nested `bash -c` can silently concatenate adjacent double-quoted shell
 * fragments. The command still exits successfully, but tauri-agent-tools sees
 * `to: /settings/p2p` instead of the quoted JS string, so the run is invalid.
 * Keep the documented outer-double/single-JS-quote recipe executable here.
 */
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, '../../../scripts/verify-tauri-headless.sh');
const src = readFileSync(SCRIPT, 'utf8');
const EXPRESSION = 'window.__TSR_ROUTER__?.navigate({ to: "/settings/p2p" })';

function fakeCommandDir() {
  const dir = mkdtempSync(join(tmpdir(), 'verify-tauri-quoting-'));
  const evalCapture = join(dir, 'eval.txt');
  const pollCapture = join(dir, 'poll.txt');
  const fakeTool = join(dir, 'tauri-agent-tools');
  const fakePoll = join(dir, 'poll-dom.sh');
  writeFileSync(
    fakeTool,
    `#!/usr/bin/env bash
set -u
[ "$1" = eval ] || exit 20
[ "$2" = --pid ] || exit 21
[ "$3" = 4242 ] || exit 22
printf '%s' "$4" > "$VERIFY_TAURI_EVAL_CAPTURE"
`,
  );
  writeFileSync(
    fakePoll,
    `#!/usr/bin/env bash
set -u
printf '%s\\n' "$@" > "$VERIFY_TAURI_POLL_CAPTURE"
`,
  );
  chmodSync(fakeTool, 0o755);
  chmodSync(fakePoll, 0o755);
  return { dir, evalCapture, pollCapture, fakePoll };
}

describe('EI-20207763368144905 — nested HUD assertion quoting', () => {
  it('documents the safe outer-double/single-JS-quote recipe', () => {
    expect(src).toContain(`'${EXPRESSION.replaceAll('"', '\\"')}'`);
    expect(src).not.toContain(`"${EXPRESSION}"`);
  });

  it('preserves the JS route and poll arguments through bash -c', () => {
    const { dir, evalCapture, pollCapture, fakePoll } = fakeCommandDir();
    const recipe = [
      'tauri-agent-tools eval --pid "$VERIFY_TAURI_PID" \\',
      `  '${EXPRESSION}'`,
      '"$VERIFY_TAURI_POLL" --selector body --text Peer --no-errors',
    ].join('\\n');
    const result = spawnSync('bash', ['-c', recipe], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}${delimiter}${process.env.PATH ?? ''}`,
        VERIFY_TAURI_PID: '4242',
        VERIFY_TAURI_POLL: fakePoll,
        VERIFY_TAURI_EVAL_CAPTURE: evalCapture,
        VERIFY_TAURI_POLL_CAPTURE: pollCapture,
      },
    });

    expect(result.status).toBe(0);
    expect(readFileSync(evalCapture, 'utf8')).toBe(EXPRESSION);
    expect(readFileSync(pollCapture, 'utf8')).toBe(
      '--selector\nbody\n--text\nPeer\n--no-errors\n',
    );
  });
});
