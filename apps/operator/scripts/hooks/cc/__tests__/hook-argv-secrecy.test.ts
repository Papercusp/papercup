/**
 * Regression guard for EI-21270327070599812.
 *
 * Hook event JSON can contain arbitrary tool input and the local superuser
 * bearer is a live credential. Neither may cross into a child process argv,
 * which any same-user process inspector can read. The shell family transports
 * event JSON on fd 3 and passes only the permission-restricted token path.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOOK_DIR = join(__dirname, '..');
const AUTH_HOOKS = [
  'ask-gate-mirror.sh',
  'lifecycle-report.sh',
  'posttoolbatch-locks-release.sh',
  'posttooluse-activity-report.sh',
  'posttooluse-locks-release.sh',
  'posttooluse-objective-title.sh',
  'pretooluse-activity-report.sh',
  'pretooluse-bash-resource-gate.sh',
  'pretooluse-locks-acquire.sh',
  'pretooluse-plans-read-guard.sh',
  'statusline-fleet.sh',
  'stop-turn-journal.sh',
  'workitem-verify-nudge.sh',
] as const;

describe('cc hook child-process argv secrecy', () => {
  it('keeps the complete superuser-auth hook family on the shared safe transport', () => {
    const discovered = readdirSync(HOOK_DIR)
      .filter((name) => name.endsWith('.sh'))
      .filter((name) =>
        readFileSync(join(HOOK_DIR, name), 'utf8').includes(
          'TOKEN_PATH="${HOME}/.papercusp/superuser-token"',
        ),
      )
      .sort();
    expect(discovered).toEqual([...AUTH_HOOKS].sort());

    for (const name of discovered) {
      const source = readFileSync(join(HOOK_DIR, name), 'utf8');
      expect(source, `${name} must never materialize the bearer in shell state`).not.toMatch(
        /TOKEN\s*=\s*\$\(\s*cat\s+"?\$TOKEN_PATH/,
      );
      expect(source, `${name} must read the bearer inside Python`).toContain('read_token_file');

      for (const line of source
        .split('\n')
        .filter((candidate) => /^\s*python3\s+-\s/.test(candidate))) {
        const argvPrefix = line.split(/\s+3<<<|\s+<<['"]?PYEOF/)[0]!;
        expect(argvPrefix, `${name}: token value reached Python argv`).not.toContain('"$TOKEN"');
        expect(argvPrefix, `${name}: raw hook JSON reached Python argv`).not.toContain('"$INPUT"');
      }
    }
  });

  it('delivers a real PostToolUse payload on fd 3 while argv carries only the token path', () => {
    const root = mkdtempSync(join(tmpdir(), 'hook-argv-secrecy-'));
    const home = join(root, 'home');
    const bin = join(root, 'bin');
    const argvCapture = join(root, 'argv.bin');
    const payloadCapture = join(root, 'payload.json');
    const fakePython = join(bin, 'python3');
    const token = '8c91f74d2e6a4bbf90f44a71d142d095';
    const rawSentinel = 'RAW-HOOK-PAYLOAD-SENTINEL-7f18c9';
    const payload = JSON.stringify({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: rawSentinel },
      session_id: 'native-session',
    });

    try {
      mkdirSync(join(home, '.papercusp'), { recursive: true });
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(home, '.papercusp', 'superuser-token'), `${token}\n`, { mode: 0o600 });
      writeFileSync(
        fakePython,
        [
          '#!/usr/bin/env bash',
          'printf "%s\\0" "$@" > "$ARGV_CAPTURE"',
          'cat <&3 > "$PAYLOAD_CAPTURE"',
          '',
        ].join('\n'),
      );
      chmodSync(fakePython, 0o755);

      const result = spawnSync('bash', [join(HOOK_DIR, 'posttooluse-activity-report.sh')], {
        input: payload,
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: home,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          PAPERCUSP_SID: 'su-argv-regression',
          PAPERCUSP_COORD_FOLD: '1',
          PAPERCUSP_LOCKS_CACHE_DIR: join(root, 'cache'),
          ARGV_CAPTURE: argvCapture,
          PAYLOAD_CAPTURE: payloadCapture,
        },
      });

      expect(result.status).toBe(0);
      const argv = readFileSync(argvCapture).toString('utf8').split('\0').filter(Boolean);
      expect(argv).toContain(join(home, '.papercusp', 'superuser-token'));
      expect(argv.join(' ')).not.toContain(token);
      expect(argv.join(' ')).not.toContain(rawSentinel);
      expect(readFileSync(payloadCapture, 'utf8').trim()).toBe(payload);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
