/**
 * Regression coverage for sync-staging-checkout.sh's WI-5710 restart gates.
 *
 * THE BUG: the script gated its `systemctl restart papercusp-staging-api` on
 * `target != current` alone — i.e. it used "the `staging` branch moved" as a
 * proxy for "the code the running :3170 process holds changed". Under a fleet
 * where git-sync auto-commits the whole tree every ~3min, that proxy decoupled
 * from the thing it proxied: :3170 restarted every ~6min forever (measured
 * 2026-07-26: restarts at 15:38 / 15:44 / 15:50 / 15:56 / 16:02 / 16:08, 42
 * Started|Stopping journal entries in 90min), each a ~10-13s hard-down window
 * that drops every live SSE/sync session.
 *
 * TWO gates now stand between "the branch moved" and "kill the process":
 *
 *  1. paths_require_restart() — relevance. The SPA needs no restart at all
 *     (host-spa.ts serves dist FROM DISK PER REQUEST), so an SPA/docs/tests-only
 *     advance rebuilds and skips the restart entirely.
 *  2. current_commit_age_sec() + staging_live_client_count() — deferral. A
 *     restart that IS required waits while someone is actually connected to
 *     :3170, bounded by a staleness ceiling so it can never freeze forever.
 *
 * The FAIL-SAFE DIRECTION of gate 1 is the load-bearing property and the thing
 * most likely to be silently inverted by a future edit: a restart is required
 * UNLESS *every* changed path is provably inert. An unknown/new path shape must
 * fall through to a restart. The inverse ("skip unless known-server") would mean
 * a newly-added server directory silently stops being picked up — a far worse
 * failure than one extra restart. Several tests below exist only to pin that
 * direction.
 *
 * Same isolation pattern as the sibling setup-release-checkout-deps.test.ts: we
 * sed-extract ONLY the named function out of the REAL script (so these track the
 * shipped logic, never a copy) and drive it under controlled inputs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { createServer, connect, type Server, type Socket } from 'node:net';

// apps/operator/lib/release → apps/operator/bin/release/sync-staging-checkout.sh
const SCRIPT_PATH = join(__dirname, '../../bin/release/sync-staging-checkout.sh');

function runScriptArgs(
  args: string[],
  opts: { env?: Record<string, string> } = {},
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('bash', [SCRIPT_PATH, ...args], {
    env: { ...process.env, ...(opts.env ?? {}) },
    encoding: 'utf8',
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Extract one function (plus any it depends on) from the live script and run it. */
function runFn(
  fns: string[],
  call: string,
  opts: { env?: Record<string, string>; input?: string } = {},
): { status: number | null; stdout: string; stderr: string } {
  const sourced = fns
    .map((f) => `source <(sed -n "/^${f}()/,/^}/p" "$SYNC_SCRIPT")`)
    .join('\n');
  const wrapper = ['set -uo pipefail', sourced, call].join('\n');
  const r = spawnSync('bash', ['-c', wrapper], {
    env: { ...process.env, SYNC_SCRIPT: SCRIPT_PATH, ...(opts.env ?? {}) },
    input: opts.input,
    encoding: 'utf8',
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/**
 * Run the real paths_require_restart() over `paths`.
 * Returns true when a process restart IS required (the script's exit-0 contract).
 */
function requiresRestart(paths: string[]): boolean {
  const r = runFn(['path_needs_no_restart', 'paths_require_restart'], 'paths_require_restart', {
    input: paths.join('\n') + (paths.length ? '\n' : ''),
  });
  if (r.status !== 0 && r.status !== 1) {
    throw new Error(`paths_require_restart exited unexpectedly (${r.status}): ${r.stderr || r.stdout}`);
  }
  return r.status === 0;
}

function execForcesLoopback(execStart: string): boolean {
  const r = runFn(
    ['staging_exec_forces_loopback'],
    'staging_exec_forces_loopback "$EXEC_START"',
    { env: { EXEC_START: execStart } },
  );
  if (r.status !== 0 && r.status !== 1) {
    throw new Error(`staging_exec_forces_loopback exited unexpectedly (${r.status}): ${r.stderr || r.stdout}`);
  }
  return r.status === 0;
}

function healthMatchesTarget(healthSha: string, targetSha: string): boolean {
  const r = runFn(
    ['health_sha_matches_target'],
    'health_sha_matches_target "$HEALTH_SHA" "$TARGET_SHA"',
    { env: { HEALTH_SHA: healthSha, TARGET_SHA: targetSha } },
  );
  if (r.status !== 0 && r.status !== 1) {
    throw new Error(`health_sha_matches_target exited unexpectedly (${r.status}): ${r.stderr || r.stdout}`);
  }
  return r.status === 0;
}

describe('sync-staging-checkout.sh argument parsing', () => {
  it('prints help and exits before touching the live sync workflow', () => {
    const r = runScriptArgs(['--help'], {
      // If argument parsing regresses and falls through, this invalid root makes
      // the live path fail instead of accidentally operating on this checkout.
      env: { PAPERCUSP_INTEGRATION_ROOT: '/definitely/not-a-live-checkout' },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Usage: sync-staging-checkout.sh');
    expect(r.stdout).toContain('--help');
    expect(r.stdout).not.toContain('[staging-sync]');
    expect(r.stderr).toBe('');
  });

  it('rejects unknown arguments without entering the live sync workflow', () => {
    const r = runScriptArgs(['--not-an-option'], {
      env: { PAPERCUSP_INTEGRATION_ROOT: '/definitely/not-a-live-checkout' },
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('unknown argument: --not-an-option');
    expect(r.stderr).toContain('Usage: sync-staging-checkout.sh');
    expect(r.stdout).toBe('');
  });
});

describe('sync-staging-checkout.sh staging launch contract (EI-19457080109574347)', () => {
  it('accepts the shipped shape: source .env.local, then explicitly force loopback', () => {
    expect(execForcesLoopback(
      "set -a; [ -f .env.local ] && . ./.env.local; set +a; export PAPERCUSP_HONO_PORT=3170 PAPERCUSP_BIND_HOST=127.0.0.1; exec node dist-host/hono-host.mjs",
    )).toBe(true);
  });

  it('rejects sourcing the shared env without a later bind override', () => {
    expect(execForcesLoopback(
      'export PAPERCUSP_BIND_HOST=127.0.0.1; set -a; . ./.env.local; set +a; exec node dist-host/hono-host.mjs',
    )).toBe(false);
  });

  it('rejects an off-loopback assignment that supersedes an earlier loopback value', () => {
    expect(execForcesLoopback(
      'set -a; . ./.env.local; set +a; export PAPERCUSP_BIND_HOST=127.0.0.1; export PAPERCUSP_BIND_HOST=0.0.0.0; exec node dist-host/hono-host.mjs',
    )).toBe(false);
  });

  it('rejects an implicit/default bind because the effective staging policy is not proven', () => {
    expect(execForcesLoopback('exec node dist-host/hono-host.mjs')).toBe(false);
  });
});

describe('sync-staging-checkout.sh runtime source identity (EI-22636310973765418)', () => {
  it('accepts the short SHA baked into the exact target commit', () => {
    expect(healthMatchesTarget('6370b7fa98', '6370b7fa98c4f2d54f3a2d968e0137a9fd5d8a3a')).toBe(true);
  });

  it('rejects a healthy process serving any other commit', () => {
    expect(healthMatchesTarget('6370b7fa98', 'a5de12953b978f6e5f7fe58b891e7d4d8fd7d3fc')).toBe(false);
    expect(healthMatchesTarget('', 'a5de12953b978f6e5f7fe58b891e7d4d8fd7d3fc')).toBe(false);
  });
});

describe('sync-staging-checkout.sh paths_require_restart() — restart relevance gate (WI-5710)', () => {
  describe('restart-EXEMPT advances (the whole point: no process kill)', () => {
    it('SPA source under apps/operator-vite/src only', () => {
      expect(requiresRestart(['apps/operator-vite/src/main.tsx'])).toBe(false);
    });

    it('SPA components under apps/operator/app only (compiled in via vite `@` alias)', () => {
      // Verified tree-wide that no server module imports from apps/operator/app.
      expect(
        requiresRestart(['apps/operator/app/adv/hud/HudBoard.tsx', 'apps/operator/app/adv/hud/hud.css']),
      ).toBe(false);
    });

    it('prose only — .md / .mdx / docs trees', () => {
      expect(
        requiresRestart([
          'docs/plans/some-plan.md',
          'apps/operator/public/internal/docs/agent-insights/x.md',
          'apps/operator-docs/src/content/docs/system/y.mdx',
        ]),
      ).toBe(false);
    });

    it('tests only — they never run inside the operator process', () => {
      expect(
        requiresRestart([
          'packages/operator-core/lib/a.test.ts',
          'apps/operator/app/adv/hud/HudBoard.test.tsx',
          'apps/operator/e2e/b.spec.ts',
          'packages/operator-core/lib/__tests__/c.ts',
        ]),
      ).toBe(false);
    });

    it('the papercusp-desktop submodule pointer (the Tauri shell embeds the operator, never the reverse)', () => {
      expect(requiresRestart(['papercusp-desktop'])).toBe(false);
    });

    it('a realistic mixed SPA + docs + tests commit', () => {
      expect(
        requiresRestart([
          'apps/operator/app/adv/hud/HudView.tsx',
          'apps/operator/app/adv/hud/HudBoard.test.tsx',
          'docs/plans/hud.md',
          'papercusp-desktop',
        ]),
      ).toBe(false);
    });
  });

  describe('restart-REQUIRED advances', () => {
    it('server code under packages/operator-core', () => {
      expect(requiresRestart(['packages/operator-core/lib/agent-tools/index.ts'])).toBe(true);
    });

    it('server code under apps/operator/lib (NOT apps/operator/app — the one-word difference that flips it)', () => {
      expect(requiresRestart(['apps/operator/lib/release/green-checkpoint.ts'])).toBe(true);
    });

    it('the libs/papercusp submodule pointer (harness/db/blueprints — real server code)', () => {
      expect(requiresRestart(['libs/papercusp'])).toBe(true);
    });

    it('ONE server path poisons an otherwise-exempt set (all-or-nothing, not majority-vote)', () => {
      expect(
        requiresRestart([
          'apps/operator-vite/src/main.tsx',
          'docs/plans/x.md',
          'packages/operator-core/lib/sync-sse.ts', // the only non-exempt entry
        ]),
      ).toBe(true);
    });

    it('flags / lockfiles / CI config are not exempt', () => {
      expect(requiresRestart(['libs/flags/src/types.ts'])).toBe(true);
      expect(requiresRestart(['package.json'])).toBe(true);
    });
  });

  describe('FAIL-SAFE DIRECTION — the property a future edit must never invert', () => {
    it('an UNKNOWN/new path shape falls through to a restart (never silently skipped)', () => {
      expect(requiresRestart(['some/brand/new/server-dir/thing.ts'])).toBe(true);
    });

    it('an EMPTY path list means "could not establish what changed" ⇒ restart, not "nothing changed" ⇒ skip', () => {
      // The caller no-ops on an unmoved HEAD long before this, so reaching here
      // with no paths means the diff failed — the dangerous case to get wrong.
      expect(requiresRestart([])).toBe(true);
    });

    it('a .ts file that merely LIVES beside exempt files is still a restart', () => {
      expect(requiresRestart(['apps/operator-vite/vite.config.ts'])).toBe(true);
    });

    it('a docs-LOOKING path that is actually code is still a restart', () => {
      expect(requiresRestart(['packages/operator-core/lib/docs-tool.ts'])).toBe(true);
    });
  });
});

describe('sync-staging-checkout.sh current_commit_age_sec() — deferral staleness ceiling (WI-5710)', () => {
  let repo: string;
  let sha: string;

  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
      encoding: 'utf8',
    }).trim();

  /** Commit with a controlled COMMITTER date — the script reads %ct, not %at. */
  const gitCommitAt = (epoch: number, msg: string) =>
    execFileSync(
      'git',
      ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', msg],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_COMMITTER_DATE: `@${epoch} +0000`,
          GIT_AUTHOR_DATE: `@${epoch} +0000`,
        },
      },
    );

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'sync-age-')));
    git('init', '-q');
    writeFileSync(join(repo, 'f.txt'), 'v1');
    git('add', '-A');
    git('commit', '-q', '-m', 'c1');
    sha = git('rev-parse', 'HEAD');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  function age(shaArg: string): number {
    const r = runFn(['current_commit_age_sec'], `current_commit_age_sec "${shaArg}"`, {
      env: { INTEGRATION_ROOT: repo },
    });
    expect(r.status).toBe(0);
    return Number(r.stdout.trim());
  }

  it('a just-made commit reports a near-zero age (so a live session IS deferred for)', () => {
    const a = age(sha);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(120);
  });

  it('an OLD commit reports a large age (so the ceiling fires and the restart lands)', () => {
    const oldEpoch = Math.floor(Date.now() / 1000) - 7200; // 2h ago
    writeFileSync(join(repo, 'f.txt'), 'v2');
    git('add', '-A');
    gitCommitAt(oldEpoch, 'old');
    const oldSha = git('rev-parse', 'HEAD');
    expect(age(oldSha)).toBeGreaterThan(3600);
  });

  it('the literal "none" (a fresh checkout) reports a huge age — never defers a first sync', () => {
    expect(age('none')).toBeGreaterThan(100000);
  });

  it('an UNRESOLVABLE sha reports a huge age (fail-safe: forces the restart, never an infinite defer)', () => {
    expect(age('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')).toBeGreaterThan(100000);
  });
});

describe('sync-staging-checkout.sh staging_live_client_count() — live-session probe (WI-5710)', () => {
  let server: Server | undefined;
  let sockets: Socket[] = [];

  afterEach(async () => {
    for (const s of sockets) s.destroy();
    sockets = [];
    await new Promise<void>((res) => (server ? server.close(() => res()) : res()));
    server = undefined;
  });

  function count(port: number): number {
    const r = runFn(['staging_live_client_count'], `staging_live_client_count ${port}`, {
      env: { STAGING_PORT: String(port) },
    });
    expect(r.status).toBe(0);
    return Number(r.stdout.trim());
  }

  const haveSs = spawnSync('ss', ['-V'], { encoding: 'utf8' }).status === 0;

  it('reports 0 for a port nobody is connected to', () => {
    if (!haveSs) return; // no iproute2 (CI container) — the function fail-softs to 0 anyway
    // A port with no listener at all: no ESTABLISHED sockets can exist on it.
    expect(count(59_431)).toBe(0);
  });

  it('reports >0 while a client holds an ESTABLISHED connection (the SSE-session signal)', async () => {
    if (!haveSs) return;
    const port = await new Promise<number>((res) => {
      server = createServer((s) => {
        sockets.push(s);
      });
      server.listen(0, '127.0.0.1', () => {
        res((server!.address() as { port: number }).port);
      });
    });
    // Hold two long-lived connections open, like two live operator windows.
    await Promise.all(
      [0, 1].map(
        () =>
          new Promise<void>((res) => {
            const c = connect(port, '127.0.0.1', () => res());
            sockets.push(c);
          }),
      ),
    );
    expect(count(port)).toBeGreaterThan(0);
  });

  it('drops back to 0 once the clients disconnect (so an idle :3170 restarts promptly)', async () => {
    if (!haveSs) return;
    const port = await new Promise<number>((res) => {
      server = createServer((s) => {
        sockets.push(s);
      });
      server.listen(0, '127.0.0.1', () => {
        res((server!.address() as { port: number }).port);
      });
    });
    await new Promise<void>((res) => {
      const c = connect(port, '127.0.0.1', () => res());
      sockets.push(c);
    });
    expect(count(port)).toBeGreaterThan(0);
    for (const s of sockets) s.destroy();
    sockets = [];
    await new Promise((r) => setTimeout(r, 250));
    expect(count(port)).toBe(0);
  });
});

describe('sync-staging-checkout.sh coordinated restart result', () => {
  const accepted = (result: unknown) => runFn(
    ['restart_result_is_accepted'],
    'restart_result_is_accepted',
    { input: typeof result === 'string' ? result : JSON.stringify(result) },
  ).status === 0;

  it('accepts only a real restart or a verified coalesce', () => {
    expect(accepted({ ok: true, restarted: true })).toBe(true);
    expect(accepted({ ok: true, restarted: false, coalesced: true, verified: true })).toBe(true);
    expect(
      accepted({
        ok: true,
        restarted: false,
        restartScheduled: true,
        restartObserved: true,
        stagingReadiness: { ready: false, outcome: 'starting' },
      }),
    ).toBe(true);
    expect(accepted({ ok: false, reason: 'restart_withheld' })).toBe(false);
    expect(accepted({ ok: true, restarted: false, coalesced: false })).toBe(false);
    expect(
      accepted({
        ok: true,
        restarted: false,
        restartScheduled: true,
        restartObserved: false,
        stagingReadiness: { ready: false, outcome: 'starting' },
      }),
    ).toBe(false);
    expect(
      accepted({
        ok: true,
        restarted: false,
        restartScheduled: true,
        restartObserved: true,
        stagingReadiness: { ready: false, outcome: 'failed' },
      }),
    ).toBe(false);
    expect(accepted('not-json')).toBe(false);
  });
});

describe('sync-staging-checkout.sh coordinated restart identity (EI-24077446541707229)', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'staging-sync-identity-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const resolve = (home: string, sid = '') => runFn(
    ['resolve_ptool_client_sid'],
    'resolve_ptool_client_sid',
    { env: { HOME: home, PAPERCUSP_SID: sid } },
  );

  it('uses the installed machine identity when a systemd invocation has no session SID', () => {
    mkdirSync(join(home, '.papercusp'));
    const machineSid = '43279960-9a3b-4b55-80d3-44110bf48834';
    writeFileSync(join(home, '.papercusp', 'su-agent-id'), `${machineSid}\n`, { mode: 0o600 });
    expect(resolve(home)).toMatchObject({ status: 0, stdout: `${machineSid}\n`, stderr: '' });
  });

  it('preserves an explicit agent session SID without reading the machine file', () => {
    expect(resolve(home, 'su-real-session')).toMatchObject({ status: 0, stdout: 'su-real-session\n' });
  });

  it('fails closed when the machine identity is missing or malformed', () => {
    expect(resolve(home).status).not.toBe(0);
    mkdirSync(join(home, '.papercusp'));
    writeFileSync(join(home, '.papercusp', 'su-agent-id'), 'not-a-uuid\n');
    expect(resolve(home).status).not.toBe(0);
  });

  it('passes the resolved identity to the audited dev:restart call', () => {
    const script = readFileSync(SCRIPT_PATH, 'utf8');
    expect(script).toContain('PTOOL_CLIENT_SID="$(resolve_ptool_client_sid)"');
    expect(script).toContain('PAPERCUSP_SID="$PTOOL_CLIENT_SID" "$PTOOL_BIN" dev:restart --url="http://127.0.0.1:${STAGING_PORT}" --json -');
    expect(script).not.toContain('"$PTOOL_BIN" dev:restart --json -');
  });
});

describe('sync-staging-checkout.sh post-restart readiness budget (EI-23131564135958331)', () => {
  const script = readFileSync(SCRIPT_PATH, 'utf8');

  function normalize(value: string): { status: number | null; stdout: string; stderr: string } {
    return runFn(
      ['normalize_staging_readiness_timeout_sec'],
      'normalize_staging_readiness_timeout_sec "$VALUE"',
      { env: { VALUE: value } },
    );
  }

  it('accepts a migration-sized default and explicit positive overrides', () => {
    expect(normalize('300')).toMatchObject({ status: 0, stdout: '300\n' });
    expect(normalize('480')).toMatchObject({ status: 0, stdout: '480\n' });
  });

  it('rejects zero and malformed values so the readiness wait stays bounded and intentional', () => {
    expect(normalize('0').status).toBe(1);
    expect(normalize('30s').status).toBe(1);
    expect(normalize('-1').status).toBe(1);
    expect(normalize('').status).toBe(1);
  });

  it('uses the configured positive timeout rather than the old fixed ~60s attempt count', () => {
    expect(script).toContain('PAPERCUSP_STAGING_SYNC_READINESS_TIMEOUT_SEC:-300');
    expect(script).toContain('normalize_staging_readiness_timeout_sec');
    expect(script).toContain('while [ "$readiness_elapsed_sec" -lt "$READINESS_TIMEOUT_SEC" ]');
    expect(script).toContain('within ${READINESS_TIMEOUT_SEC}s after restart');
    expect(script).not.toContain('seq 1 30');
  });

  it('validates the readiness budget before requesting dev:restart', () => {
    const validationIdx = script.indexOf('invalid PAPERCUSP_STAGING_SYNC_READINESS_TIMEOUT_SEC');
    const restartIdx = script.indexOf('requesting coordinated restart');
    expect(validationIdx).toBeGreaterThan(-1);
    expect(restartIdx).toBeGreaterThan(validationIdx);
  });
});

/**
 * Structural guards. The gates above are only worth anything if the shipped
 * script actually consults them on the path to the restart — an edit that
 * extracts the functions but stops calling them would leave every unit test
 * above green while :3170 flapped exactly as before.
 */
describe('sync-staging-checkout.sh — the shipped script actually wires the gates (WI-5710)', () => {
  const script = readFileSync(SCRIPT_PATH, 'utf8');

  it('checks the effective staging launch bind before even the unchanged-HEAD no-op', () => {
    const guardIdx = script.indexOf('assert_staging_unit_loopback || exit 1');
    const targetIdx = script.indexOf('target="$(git -C');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(targetIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(targetIdx);
  });

  it('proves the unit serves the same isolated checkout before any sync decision', () => {
    const guardIdx = script.indexOf('assert_staging_unit_checkout || exit 1');
    const targetIdx = script.indexOf('target="$(git -C');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(targetIdx);
    expect(script).toContain('PAPERCUSP_BUNDLE_REUSE_FRESH=1');
  });

  it('treats checkout equality as a no-op only when the running bundle reports that target SHA', () => {
    const equalityIdx = script.indexOf('if [ "$target" = "$current" ]');
    const noOpIdx = script.indexOf('running :3170 bundle already at', equalityIdx);
    const mismatchIdx = script.indexOf('restart still required', equalityIdx);
    expect(equalityIdx).toBeGreaterThan(-1);
    expect(script.slice(equalityIdx, noOpIdx)).toContain('health_sha_matches_target');
    expect(mismatchIdx).toBeGreaterThan(noOpIdx);
  });

  it('consults paths_require_restart() before restarting', () => {
    expect(script).toMatch(/paths_require_restart/);
    expect(script).toMatch(/restart_required=0/);
  });

  it('the SPA-only path skips the restart but still runs the rebuild', () => {
    // The skip must come AFTER setup-release-checkout.sh (dist refreshed on
    // disk), not instead of it — otherwise :3170 serves a stale SPA forever.
    const buildIdx = script.indexOf('setup-release-checkout.sh');
    const skipIdx = script.indexOf('skipping restart — all');
    expect(buildIdx).toBeGreaterThan(-1);
    expect(skipIdx).toBeGreaterThan(buildIdx);
  });

  it('the live-session deferral happens BEFORE the checkout advances (SPA/server lockstep)', () => {
    // Advancing the checkout while keeping the old process would serve a NEW
    // SPA against an OLD server. The defer must therefore precede the build.
    const deferIdx = script.indexOf('deferring sync —');
    const buildIdx = script.indexOf('bash "$INTEGRATION_ROOT/apps/operator/bin/release/setup-release-checkout.sh"');
    expect(deferIdx).toBeGreaterThan(-1);
    expect(script.indexOf('staging_live_client_count "$STAGING_PORT"')).toBeGreaterThan(-1);
    if (buildIdx > -1) expect(deferIdx).toBeLessThan(buildIdx);
  });

  it('the deferral is bounded by a staleness ceiling (never an indefinite freeze)', () => {
    expect(script).toMatch(/MAX_STALE_SEC/);
    expect(script).toMatch(/staleness ceiling reached/);
  });

  it('keeps the EI-13221 recent-restart grace and strengthens health to exact source identity', () => {
    expect(script).toMatch(/RECENT_RESTART_GRACE_SEC/);
    expect(script).toContain('staging_health_source_sha');
    expect(script).toMatch(/did not report target source/);
  });

  it('routes a required restart through audited dev:restart, never raw systemctl', () => {
    expect(script).toContain('"$PTOOL_BIN" dev:restart --url="http://127.0.0.1:${STAGING_PORT}" --json -');
    expect(script).toContain('"confirm":true,"authorize":true');
    expect(script).not.toContain('systemctl --user restart "$UNIT"');
  });

  it('prebuilds the proof-bound host bundle before requesting the coordinated restart', () => {
    const prebuildIdx = script.indexOf('prebuilding proof-bound host bundle');
    const restartIdx = script.indexOf('requesting coordinated restart');
    expect(prebuildIdx).toBeGreaterThan(-1);
    expect(restartIdx).toBeGreaterThan(prebuildIdx);
    expect(script.slice(prebuildIdx, restartIdx)).toContain('PAPERCUSP_BUNDLE_REUSE_FRESH=1');
  });

  it('accepts post-restart health only when /api/health reports the target source SHA', () => {
    const healthLoopIdx = script.indexOf('last_health_sha=');
    expect(healthLoopIdx).toBeGreaterThan(-1);
    expect(script.slice(healthLoopIdx)).toContain('health_sha_matches_target "$last_health_sha" "$target"');
  });

  it('fails before advancing when the coordinated restart mechanism is unavailable', () => {
    const ptoolGateIdx = script.indexOf('coordinated dev:restart seam cannot run');
    const buildIdx = script.indexOf('bash "$INTEGRATION_ROOT/apps/operator/bin/release/setup-release-checkout.sh"');
    expect(ptoolGateIdx).toBeGreaterThan(-1);
    expect(buildIdx).toBeGreaterThan(-1);
    expect(ptoolGateIdx).toBeLessThan(buildIdx);
  });
});

/**
 * EI-22102474093310851 — a transient git-sync refusal must not fail the unit.
 *
 * THE BUG: the dev:restart call was a ONE-SHOT, and any refusal was FATAL exit 1.
 * dev:restart's own guidance says the opposite is needed: "git-sync fires hold the
 * barrier only ~5-10s, so a short drain usually succeeds where a one-shot attempt
 * always fails." Measured over 24h on 2026-09-03: 13 unit failures, 9 on
 * `git_sync_barrier_draining` and 4 on `git_sync_collision_operation_in_flight_unknown`
 * — and ZERO build/tsc errors, despite the filed title naming the tsc step.
 *
 * The fix has two halves and BOTH are load-bearing:
 *   1. pass `git_sync_drain_sec` so the call WAITS for the barrier;
 *   2. if a git-sync refusal outlasts even that, DEFER (exit 0) rather than fail —
 *      but bounded by the same MAX_STALE_SEC ceiling the live-client deferral uses,
 *      so a genuinely stuck barrier still goes loud instead of silently leaving
 *      :3170 on stale code forever.
 */
describe('sync-staging-checkout.sh — transient git-sync refusals defer, they do not fail (EI-22102474093310851)', () => {
  const script = readFileSync(SCRIPT_PATH, 'utf8');

  /** Run the REAL predicate over a dev:restart result payload. */
  function isTransient(result: unknown): boolean {
    const r = runFn(['restart_refusal_is_transient_git_sync'], 'restart_refusal_is_transient_git_sync', {
      input: JSON.stringify(result),
    });
    if (r.status !== 0 && r.status !== 1) {
      throw new Error(`predicate exited ${r.status}: ${r.stderr}`);
    }
    return r.status === 0;
  }

  it('classifies the two REAL refusals measured in the journal as transient', () => {
    // Verbatim shapes from papercup-staging-sync.service, 2026-09-03.
    expect(isTransient({ ok: false, target: 'staging', reason: 'git_sync_barrier_draining', restarted: false })).toBe(true);
    expect(
      isTransient({
        ok: false,
        target: 'staging',
        reason: 'git_sync_collision_operation_in_flight_unknown',
        restarted: false,
        git_sync_collision: { kind: 'operation-in-flight-unknown', unknownResources: ['git-sync:papercusp'] },
      }),
    ).toBe(true);
  });

  it('matches the PREFIX dev:restart owns, so a future collision kind cannot drift past it', () => {
    // restart.ts derives these as `git_sync_collision_${kind.replace(/-/g,'_')}` and
    // `git_sync_barrier_${reason.replace(/-/g,'_')}` over an OPEN enum. A predicate
    // enumerating today's suffixes would silently start failing the unit the day a
    // new kind lands; matching the code-owned prefix is what prevents that.
    expect(isTransient({ ok: false, reason: 'git_sync_collision_some_future_kind_nobody_has_written_yet' })).toBe(true);
    expect(isTransient({ ok: false, reason: 'git_sync_barrier_some_future_reason' })).toBe(true);
  });

  it('does NOT swallow a refusal that is not a git-sync coordination refusal', () => {
    expect(isTransient({ ok: false, reason: 'gate_collision' })).toBe(false);
    expect(isTransient({ ok: false, reason: 'not_authorized' })).toBe(false);
    expect(isTransient({ ok: false })).toBe(false);
    // a reason that merely CONTAINS the token, rather than being prefixed by it
    expect(isTransient({ ok: false, reason: 'unrelated_git_sync_collision_thing' })).toBe(false);
    expect(isTransient('not json at all')).toBe(false);
  });

  it('the shipped script WAITS for the barrier instead of one-shotting the restart', () => {
    expect(script).toContain('"git_sync_drain_sec":${GIT_SYNC_DRAIN_SEC}');
    expect(script).toContain('normalize_git_sync_drain_sec');
    expect(script).toMatch(/PAPERCUSP_STAGING_SYNC_GIT_SYNC_DRAIN_SEC:-45/);
  });

  describe('the wire budget stays compatible with the oldest live staging schema', () => {
    function normalize(value: string): { status: number | null; stdout: string; stderr: string } {
      return runFn(['normalize_git_sync_drain_sec'], 'normalize_git_sync_drain_sec "$VALUE"', {
        env: { VALUE: value },
      });
    }

    it('preserves a valid short override', () => {
      expect(normalize('7')).toMatchObject({ status: 0, stdout: '7\n' });
    });

    it('clamps the stale-runtime-incompatible default/override ceiling to 45s', () => {
      expect(normalize('60')).toMatchObject({ status: 0, stdout: '45\n' });
      expect(normalize('120')).toMatchObject({ status: 0, stdout: '45\n' });
    });

    it('rejects non-numeric values instead of emitting invalid JSON', () => {
      expect(normalize('45s').status).toBe(1);
    });
  });

  it('the deferral is BOUNDED — a stuck barrier still goes FATAL rather than hiding stale code', () => {
    const branchIdx = script.indexOf('restart_refusal_is_transient_git_sync; then');
    const ceilingIdx = script.indexOf('staleness ceiling reached', branchIdx);
    const fatalIdx = script.indexOf('FATAL: coordinated dev:restart was refused', branchIdx);
    expect(branchIdx).toBeGreaterThan(-1);
    // the transient branch consults the SAME age ceiling the live-client deferral uses…
    expect(script.slice(branchIdx, fatalIdx)).toContain('current_commit_age_sec');
    expect(script.slice(branchIdx, fatalIdx)).toContain('MAX_STALE_SEC');
    // …and the FATAL exit is still reachable past it, not replaced by the deferral.
    expect(ceilingIdx).toBeGreaterThan(branchIdx);
    expect(fatalIdx).toBeGreaterThan(ceilingIdx);
  });
});
