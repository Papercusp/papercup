import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Plan agent-capacity-and-cost-gcp-2026-09-30, S7 / WI-10004395. The capacity baseline must
// start the server with PAPERCUSP_DISABLE_DOGFOOD_HIVE=1 from its FIRST boot (WI-10004421).
// The package's postinst enables the user unit for every user, so the first start happens at
// `loginctl enable-linger`, not at `systemctl --user enable --now`: the drop-in has to exist
// before linger. The earlier version of this test checked the drop-in at `enable --now`, which
// passed while the real VM (cap-s7-b, 2026-09-30) started one second before the drop-in landed.
// The script therefore also verifies the RUNNING process's environment.
const SCRIPT = path.join(__dirname, 'install-server.sh');
const SHA = 'a'.repeat(64);
const DROPIN = '.config/systemd/user/papercusp-server.service.d/capacity-env.conf';
const VAR = 'PAPERCUSP_DISABLE_DOGFOOD_HIVE=1';

describe('vm/install-server.sh extra KEY=VAL environment (faked sudo/systemctl/apt)', () => {
  let dir: string;
  const bin = () => path.join(dir, 'bin');
  const home = () => path.join(dir, 'home');
  const stub = (name: string, body: string) => {
    writeFileSync(path.join(bin(), name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(path.join(bin(), name), 0o755);
  };
  /** The fake server process's /proc/<pid>/environ (NUL-separated, like the kernel's). */
  const setEnviron = (file: 'environ' | 'environ.after', vars: string[]) =>
    writeFileSync(path.join(dir, file), vars.map((v) => `${v}\0`).join(''));
  const log = () => readFileSync(path.join(dir, 'systemctl.log'), 'utf8');

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'install-server-'));
    mkdirSync(bin());
    mkdirSync(home());
    // sudo: drop `-u <user>` and env assignments; answer the marker read so the fetch+apt
    // step is skipped; serve the fake process environ; strip -o/-g from `install`.
    stub(
      'sudo',
      [
        'while [ "$1" = "-u" ]; do shift 2; done',
        'while [[ "$1" == *=* ]]; do shift; done',
        'case "$1" in',
        '  test) exit 0 ;;',
        '  cat) case "$2" in',
        `         /var/lib/papercusp-capacity-installed.sha256) echo ${SHA}; exit 0 ;;`,
        `         /proc/999/environ) [ -f "${dir}/environ" ] && exec cat "${dir}/environ"; exit 1 ;;`,
        '       esac ;;',
        '  install) shift; a=(); while [ $# -gt 0 ]; do case "$1" in -o|-g) shift 2 ;; *) a+=("$1"); shift ;; esac; done; exec install "${a[@]}" ;;',
        'esac',
        'exec "$@"',
      ].join('\n'),
    );
    stub(
      'systemctl',
      [
        `echo "$@" >> "${dir}/systemctl.log"`,
        '[[ "$*" == *"ControlGroup"* ]] && echo /cg',
        '[[ "$*" == *"MainPID"* ]] && echo 999',
        `[[ "$*" == *" restart "* ]] && [ -f "${dir}/environ.after" ] && mv "${dir}/environ.after" "${dir}/environ"`,
        'exit 0',
      ].join('\n'),
    );
    // The first start: record whether the drop-in already existed when linger started the unit.
    stub(
      'loginctl',
      [`[ -f "${home()}/${DROPIN}" ] && echo DROPIN_PRESENT_AT_LINGER >> "${dir}/systemctl.log"`, 'exit 0'].join('\n'),
    );
    stub('dpkg-query', 'exit 0');
    stub('pgrep', 'exit 1');
    stub('id', '[ "$1" = "-u" ] && echo 4321; exit 0');
    stub('journalctl', 'echo "operator_hint=1"');
    stub('find', 'exit 0');
    stub('ss', 'exit 0');
    stub('curl', `echo '{"ok":true}'`);
    stub('sleep', 'exit 0');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const env = () => ({ ...process.env, PATH: `${bin()}:${process.env.PATH}`, SVC_HOME: home() });
  const run = (...extra: string[]) =>
    spawnSync('bash', [SCRIPT, 'gs://b/server.deb', SHA, ...extra], { encoding: 'utf8', env: env(), stdio: ['ignore', 'pipe', 'pipe'] });

  it('writes the drop-in before linger starts the unit, and verifies the running process carries it', () => {
    setEnviron('environ', ['HOME=/var/empty', VAR, 'FOO_BAR=x']);
    const out = execFileSync('bash', [SCRIPT, 'gs://b/server.deb', SHA, VAR, 'FOO_BAR=x'], {
      encoding: 'utf8',
      env: env(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(out).toContain(`SERVER_ENV=${VAR}`);
    expect(out).toContain('SERVER_ENV=FOO_BAR=x');
    expect(out).toContain(`SERVER_ENV_VERIFIED=${VAR}`);
    expect(out).toContain('SERVER_ENV_VERIFIED=FOO_BAR=x');
    expect(out).not.toContain('SERVER_RESTARTED_FOR_ENV');
    expect(out).toMatch(/^SERVER_PORT=1$/m);
    expect(readFileSync(path.join(home(), DROPIN), 'utf8')).toBe(`[Service]\nEnvironment=${VAR}\nEnvironment=FOO_BAR=x\n`);
    expect(log()).toContain('DROPIN_PRESENT_AT_LINGER');
    expect(log()).not.toMatch(/ restart /);
  });

  it('restarts once when the running process started without a variable, and says so', () => {
    setEnviron('environ', ['HOME=/var/empty']);
    setEnviron('environ.after', ['HOME=/var/empty', VAR]);
    const r = run(VAR);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`SERVER_RESTARTED_FOR_ENV (first start lacked: ${VAR})`);
    expect(r.stdout).toContain(`SERVER_ENV_VERIFIED=${VAR}`);
    expect(log()).toMatch(/ restart papercusp-server\.service/);
  });

  it('refuses (exit 7) when the variable never reaches the running process', () => {
    setEnviron('environ', ['HOME=/var/empty']);
    const r = run(VAR);
    expect(r.status).toBe(7);
    expect(r.stdout).toContain(`SERVER_ENV_NOT_APPLIED=${VAR}`);
    expect(r.stdout).not.toContain('SERVER_ENV_VERIFIED');
    expect(r.stdout).not.toContain('SERVER_PORT=');
  });

  it('refuses (exit 7) when the process environ cannot be read at all', () => {
    const r = run(VAR); // no environ fixture: the read fails
    expect(r.status).toBe(7);
    expect(r.stdout).toContain(`SERVER_ENV_NOT_APPLIED=${VAR}`);
  });

  it('writes no drop-in and skips verification when no variable is given', () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(existsSync(path.join(home(), DROPIN))).toBe(false);
    expect(r.stdout).not.toContain('SERVER_ENV');
  });

  it('refuses a malformed variable before touching anything', () => {
    const r = run('lower=1');
    expect(r.status).toBe(2);
    expect(r.stdout).toContain('BAD_ENV_ARG lower=1');
    expect(existsSync(path.join(dir, 'systemctl.log'))).toBe(false);
  });
});
