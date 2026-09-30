/**
 * psu-launcher hosted-customer mode (D-002 rules 2 and 4, plan
 * psu-cloud-connector-liveness-multi-signin-2026-09-29 P-008).
 *
 * A psu the workspace host starts for a customer runs as the SERVICE user, so its own launcher
 * re-applies the host's argv allowlist before anything else runs (including `--version` and the
 * connection front controller), and never prompts for identity, fleet or a backend install.
 *
 * Only refused argv is launched here: an admitted one would start a real session.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { pickIdentity } from './psu-launcher.mjs';

const LAUNCHER = fileURLToPath(new URL('./psu-launcher.mjs', import.meta.url));

function launch(argv: string[]) {
  return spawnSync(process.execPath, [LAUNCHER, ...argv], {
    // An unroutable operator: a gate that let an argument through would fail loudly, not launch.
    env: { ...process.env, PAPERCUSP_PSU_HOSTED_CUSTOMER: '1', PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:9' },
    encoding: 'utf8',
    timeout: 60_000,
  });
}

describe('psu launcher in hosted-customer mode (D-002)', () => {
  it.each([
    [['--version'], '--version'],
    [['--launch-context=/etc/shadow'], '--launch-context'],
    [['--connect=portal.example.test/ws'], '--connect'],
    [['--fleet=ops'], '--fleet'],
    [['--', 'claude'], '--'],
    [['--agent', 'bash'], 'flag_value_refused:--agent'],
  ])('refuses %j before doing anything else', (argv, named) => {
    const result = launch(argv);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('psu: this cloud workspace does not accept these arguments');
    expect(result.stderr).toContain(named);
  });

  describe('prompts', () => {
    const saved = process.env.PAPERCUSP_PSU_HOSTED_CUSTOMER;
    afterEach(() => {
      if (saved === undefined) delete process.env.PAPERCUSP_PSU_HOSTED_CUSTOMER;
      else process.env.PAPERCUSP_PSU_HOSTED_CUSTOMER = saved;
    });

    it('launches as plain su without asking for an identity or calling the operator', async () => {
      process.env.PAPERCUSP_PSU_HOSTED_CUSTOMER = '1';
      await expect(pickIdentity('ws', 'h')).resolves.toEqual({ stack: [], selectedIdentityRevision: null });
    });
  });
});
