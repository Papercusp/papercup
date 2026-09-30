import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Plan agent-capacity-and-cost-gcp-2026-09-30, S7 / WI-10004395. The capacity baseline must
// start the server with PAPERCUSP_DISABLE_DOGFOOD_HIVE=1 from its FIRST boot (WI-10004421),
// so the drop-in has to exist before `systemctl --user enable --now` runs.
const SCRIPT = path.join(__dirname, 'install-server.sh');
const SHA = 'a'.repeat(64);
const DROPIN = '.config/systemd/user/papercusp-server.service.d/capacity-env.conf';

describe('vm/install-server.sh extra KEY=VAL environment (faked sudo/systemctl/apt)', () => {
  let dir: string;
  const bin = () => path.join(dir, 'bin');
  const home = () => path.join(dir, 'home');
  const stub = (name: string, body: string) => {
    writeFileSync(path.join(bin(), name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(path.join(bin(), name), 0o755);
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'install-server-'));
    mkdirSync(bin());
    mkdirSync(home());
    // sudo: drop `-u <user>` and env assignments; answer the marker read so the fetch+apt
    // step is skipped; strip -o/-g from `install` (the test is not root).
    stub(
      'sudo',
      [
        'while [ "$1" = "-u" ]; do shift 2; done',
        'while [[ "$1" == *=* ]]; do shift; done',
        'case "$1" in',
        '  test) exit 0 ;;',
        `  cat) [ "$2" = /var/lib/papercusp-capacity-installed.sha256 ] && { echo ${SHA}; exit 0; } ;;`,
        '  install) shift; a=(); while [ $# -gt 0 ]; do case "$1" in -o|-g) shift 2 ;; *) a+=("$1"); shift ;; esac; done; exec install "${a[@]}" ;;',
        'esac',
        'exec "$@"',
      ].join('\n'),
    );
    stub(
      'systemctl',
      [
        `echo "$@" >> "${dir}/systemctl.log"`,
        `[[ "$*" == *"enable --now"* ]] && { [ -f "${home()}/${DROPIN}" ] && echo DROPIN_PRESENT_AT_ENABLE >> "${dir}/systemctl.log"; }`,
        '[[ "$*" == *"ControlGroup"* ]] && echo /cg',
        'exit 0',
      ].join('\n'),
    );
    stub('dpkg-query', 'exit 0');
    stub('pgrep', 'exit 1');
    stub('id', '[ "$1" = "-u" ] && echo 4321; exit 0');
    stub('loginctl', 'exit 0');
    stub('journalctl', 'echo "operator_hint=1"');
    stub('find', 'exit 0');
    stub('ss', 'exit 0');
    stub('curl', `echo '{"ok":true}'`);
    stub('sleep', 'exit 0');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const env = () => ({ ...process.env, PATH: `${bin()}:${process.env.PATH}`, SVC_HOME: home() });

  it('writes the drop-in before the first start and reports each variable', () => {
    const out = execFileSync('bash', [SCRIPT, 'gs://b/server.deb', SHA, 'PAPERCUSP_DISABLE_DOGFOOD_HIVE=1', 'FOO_BAR=x'], {
      encoding: 'utf8',
      env: env(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(out).toContain('SERVER_ENV=PAPERCUSP_DISABLE_DOGFOOD_HIVE=1');
    expect(out).toContain('SERVER_ENV=FOO_BAR=x');
    expect(out).toMatch(/^SERVER_PORT=1$/m);
    expect(readFileSync(path.join(home(), DROPIN), 'utf8')).toBe(
      '[Service]\nEnvironment=PAPERCUSP_DISABLE_DOGFOOD_HIVE=1\nEnvironment=FOO_BAR=x\n',
    );
    expect(readFileSync(path.join(dir, 'systemctl.log'), 'utf8')).toContain('DROPIN_PRESENT_AT_ENABLE');
  });

  it('writes no drop-in when no variable is given', () => {
    execFileSync('bash', [SCRIPT, 'gs://b/server.deb', SHA], { encoding: 'utf8', env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
    expect(existsSync(path.join(home(), DROPIN))).toBe(false);
  });

  it('refuses a malformed variable before touching anything', () => {
    const r = spawnSync('bash', [SCRIPT, 'gs://b/server.deb', SHA, 'lower=1'], { encoding: 'utf8', env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
    expect(r.status).toBe(2);
    expect(r.stdout).toContain('BAD_ENV_ARG lower=1');
    expect(existsSync(path.join(dir, 'systemctl.log'))).toBe(false);
  });
});
