/**
 * EI-10822: sync-backed screens can render after client-side navigation has
 * completed. The isolated Tauri verifier must offer a bounded DOM poll instead
 * of making callers guess a fixed sleep that races cold-boot queries.
 */
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, '../../../scripts/verify-tauri-headless.sh');
const src = readFileSync(SCRIPT, 'utf8');
const helper = src.match(/cat > "\$POLL" <<'POLL_SCRIPT'\n([\s\S]*?)\nPOLL_SCRIPT/)?.[1];

describe('EI-10822 — verify-tauri-headless DOM polling', () => {
  it('exports the per-run helper to assertion commands and boot-only sessions', () => {
    expect(src).toContain('export VERIFY_TAURI_POLL="$POLL"');
    // EI-20226754912676562 re-pointed this half of the guard. --boot-only used
    // to hand the helper path over by printing `export VERIFY_TAURI_POLL=...`
    // to stdout; concurrent callers redirecting that stream to one shared log
    // could source a PEER's block. The path now travels in the private per-run
    // env file and is re-exported only after that file re-verifies ownership.
    // Assert the NEW carrier — asserting the old one re-demands the bug.
    expect(src).toContain(
      String.raw`printf 'VERIFY_TAURI_POLL=%q\n' "$VERIFY_TAURI_POLL"`,
    );
    expect(src).toMatch(/^export VERIFY_TAURI_POLL VERIFY_TAURI_STOP\b/m);
    expect(helper).toBeTruthy();
  });

  it('retries a data-dependent check until it passes and pins the verified pid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verify-tauri-poll-'));
    const helperPath = join(dir, 'poll-dom.sh');
    const fakeTool = join(dir, 'tauri-agent-tools');
    const attempts = join(dir, 'attempts');
    writeFileSync(helperPath, helper!);
    chmodSync(helperPath, 0o755);
    writeFileSync(fakeTool, `#!/usr/bin/env bash\ncount=$(cat "${attempts}" 2>/dev/null || echo 0)\ncount=$((count + 1))\nprintf '%s' "$count" > "${attempts}"\n[ "$1 $2" = "check --pid" ] || exit 9\n[ "$3" = "4242" ] || exit 8\n[ "$count" -ge 3 ]\n`);
    chmodSync(fakeTool, 0o755);

    const result = spawnSync(helperPath, ['--selector', 'body', '--text', 'ready'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}${delimiter}${process.env.PATH ?? ''}`,
        VERIFY_TAURI_PID: '4242',
        VERIFY_TAURI_DOM_TIMEOUT: '5',
        VERIFY_TAURI_DOM_POLL_INTERVAL: '0',
      },
    });

    expect(result.status).toBe(0);
    expect(readFileSync(attempts, 'utf8')).toBe('3');
  });

  it('fails with the last assertion output when the bounded timeout expires', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verify-tauri-poll-timeout-'));
    const helperPath = join(dir, 'poll-dom.sh');
    const fakeTool = join(dir, 'tauri-agent-tools');
    writeFileSync(helperPath, helper!);
    chmodSync(helperPath, 0o755);
    writeFileSync(fakeTool, '#!/usr/bin/env bash\necho "still loading" >&2\nexit 1\n');
    chmodSync(fakeTool, 0o755);

    const result = spawnSync(helperPath, ['--selector', 'body', '--text', 'ready'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}${delimiter}${process.env.PATH ?? ''}`,
        VERIFY_TAURI_PID: '4242',
        VERIFY_TAURI_DOM_TIMEOUT: '0',
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('DOM assertion did not pass within 0s');
    expect(result.stderr).toContain('still loading');
  });

  it('supports quiet expected-miss probes without hiding a nonzero result', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verify-tauri-poll-quiet-'));
    const helperPath = join(dir, 'poll-dom.sh');
    const fakeTool = join(dir, 'tauri-agent-tools');
    writeFileSync(helperPath, helper!);
    chmodSync(helperPath, 0o755);
    writeFileSync(fakeTool, '#!/usr/bin/env bash\necho "[FAIL] optional panel absent" >&2\nexit 1\n');
    chmodSync(fakeTool, 0o755);

    const result = spawnSync(
      helperPath,
      ['--quiet', '--selector', 'body', '--text', 'optional panel'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${dir}${delimiter}${process.env.PATH ?? ''}`,
          VERIFY_TAURI_PID: '4242',
          VERIFY_TAURI_DOM_TIMEOUT: '0',
        },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toContain('DOM assertion did not pass within 0s');
    expect(result.stderr).not.toContain('[FAIL] optional panel absent');
  });
});
