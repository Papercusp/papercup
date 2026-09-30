/**
 * physical-drill-iteration-speed-2026-09-29 P-005 (R-4), design = plan decision D-003:
 * the physical hive-git scenario runs against the same-box two-instance rig from the SAME
 * entry point the physical rig uses (bin/hive-git-drill.sh -> hive-git-physical-probe.sh ->
 * hive-git-physical-scenario.sh), so harness timing and lifecycle bugs cost minutes instead
 * of an 18-26 minute physical run.
 *
 * Falsifier (R-4): the scenario cannot be run against the same-box rig, or same-box mode goes
 * through a different entry point. Every case runs the REAL scripts against stub hosts:
 * a temp rig directory stands in for the two instances, and the same-box transport refuses
 * every host but its sentinel, so nothing here can reach the physical rig.
 *
 * Subject paths are overridable so scripts/mutation-probe.sh can point this guard at a
 * mutated COPY (copy-out tier) instead of mutating the shared tree.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'papercusp-desktop', 'bin', 'hive-git-drill.sh'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('could not locate papercusp-desktop/bin/hive-git-drill.sh');
}

const root = repoRoot();
const desktopBin = join(root, 'papercusp-desktop', 'bin');
const vmRig = join(desktopBin, 'vm-rig');
const profileLib = process.env.RIG_PROFILE_LIB_UNDER_TEST ?? join(vmRig, 'lib', 'rig-profile.sh');
const transportDir = process.env.SAME_BOX_TRANSPORT_UNDER_TEST ?? join(vmRig, 'lib', 'same-box-transport');
const drillPath = process.env.DRILL_SCRIPT_UNDER_TEST ?? join(desktopBin, 'hive-git-drill.sh');
const probePath = process.env.PHYSICAL_PROBE_UNDER_TEST ?? join(vmRig, 'hive-git-physical-probe.sh');
const scenarioPath = process.env.DRILL_SCENARIO_UNDER_TEST ?? join(vmRig, 'hive-git-physical-scenario.sh');
const selectLib = join(desktopBin, 'lib', 'physical-phase-select.sh');
const tsx = join(root, 'node_modules', '.bin', 'tsx');

/** Anything in a value that can only mean the physical rig. */
const PHYSICAL_HOST_MARKERS = /172\.31\.44\.|\/Users\/|\/Applications\//;
/** Seeded into every host variable before the profile runs; none may survive it. */
const PHYSICAL_SEED = 'PHYSICAL-RIG-SEED';

const scratch = mkdtempSync(join(tmpdir(), 'hive-git-rehearsal-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let seq = 0;

function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of [
    'HIVE_GIT_RIG',
    'HIVE_GIT_SAME_BOX_RIG',
    'HIVE_GIT_PHYSICAL_PROBE_CMD',
    'HIVE_GIT_PHYSICAL_PHASES',
    'HIVE_GIT_PHYSICAL_EXECUTE',
    'HIVE_GIT_PHYSICAL_PLAN',
    'REQUIRE_ZERO_SKIPS',
    'SAME_BOX_VM_HOME',
    'SAME_BOX_VM_PORT',
    'SAME_BOX_VM_PG_PORT',
    'SAME_BOX_TOWER_HOME',
    'SAME_BOX_TOWER_PORT',
    'SAME_BOX_TOWER_PG_PORT',
    'SAME_BOX_TSX',
    'SAME_BOX_NODE',
    'SAME_BOX_RIG_DIR',
    'PAPERCUSP_PG_PORT',
    'PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID',
  ]) {
    delete env[k];
  }
  return { ...env, ...extra };
}

/** A stub same-box rig: two throwaway homes and a rig.env the profile accepts. */
function stubRig(overrides: Record<string, string> = {}, extraLines: string[] = []) {
  const dir = join(scratch, `rig-${seq++}`);
  const towerHome = join(dir, 'tower-home');
  const vmHome = join(dir, 'vm-home');
  mkdirSync(towerHome, { recursive: true });
  mkdirSync(vmHome, { recursive: true });
  const env: Record<string, string> = {
    SB_TOWER_HOME: towerHome,
    SB_TOWER_PORT: '41001',
    SB_TOWER_PG_PORT: '41101',
    SB_VM_HOME: vmHome,
    SB_VM_PORT: '41002',
    SB_VM_PG_PORT: '41102',
    SB_NODE: process.execPath,
    SB_TSX: tsx,
    SB_POT_HOME: 'same-box-pot',
    SB_GIT_SYNC_SLUG: 'same-box-member',
    SB_REPO_KEY: 'gh-1296269',
    SB_GITHUB_REMOTE: 'https://github.com/octocat/Hello-World',
    SB_WORKSPACE: 'same-box-ws',
    SB_PHYSICAL_ONLY_PHASES: "'E:needs the GitHub remote only the physical rig owns'",
    ...overrides,
  };
  const body = [...Object.entries(env).map(([k, v]) => `${k}=${v}`), ...extraLines].join('\n');
  writeFileSync(join(dir, 'rig.env'), `${body}\n`);
  return { dir, towerHome, vmHome };
}

/** What a converged same-box owner pair actually writes (r5 rig, 2026-09-30). */
function converge(rig: ReturnType<typeof stubRig>) {
  for (const home of [rig.towerHome, rig.vmHome]) {
    mkdirSync(join(home, '.papercusp', 'identity'), { recursive: true });
    writeFileSync(join(home, '.papercusp', 'local-announce-identity.json'), '{}\n');
    mkdirSync(join(home, '.papercusp', 'pot-git', 'same-box-pot', 'gh-1296269.git'), { recursive: true });
  }
  for (const f of ['vmcall.sh', 'mcp-call.mjs', 'boot-vm.sh']) writeFileSync(join(rig.dir, f), '');
  symlinkSync(root, join(rig.dir, 'vm-dep-source'));
  return rig;
}

/** Top-level host assignments that name the physical rig, in a real script. */
function physicalHostVars(source: string): string[] {
  const names = new Set<string>();
  for (const line of source.split('\n')) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m && PHYSICAL_HOST_MARKERS.test(m[2])) names.add(m[1]);
  }
  return [...names].sort();
}

describe('rig-profile.sh — one profile owns every host value', () => {
  const scenario = readFileSync(scenarioPath, 'utf8');
  const probe = readFileSync(probePath, 'utf8');
  const hostVars = [...new Set([...physicalHostVars(scenario), ...physicalHostVars(probe)])].sort();

  it('finds the physical host variables it must cover (calibration)', () => {
    // If this ever reads empty, the drift guard below would pass vacuously.
    expect(hostVars).toEqual(expect.arrayContaining(['VM', 'VM_NODE', 'VM_REPO', 'VM_IDENTITY_DIR']));
  });

  it('same-box retargets every physical host variable of the real probe and scenario at the stub rig', () => {
    const rig = stubRig();
    const seed = hostVars.map((v) => `${v}='${PHYSICAL_SEED}'`).join('; ');
    const dump = hostVars.map((v) => `printf '%s=%s\\n' ${v} "\${${v}}"`).join('; ');
    const r = spawnSync('bash', ['-c', `set -u; ${seed}; . ${JSON.stringify(profileLib)}; rig_profile_apply >/dev/null || exit 9; ${dump}`], {
      encoding: 'utf8',
      env: cleanEnv({ HIVE_GIT_RIG: 'same-box', HIVE_GIT_SAME_BOX_RIG: rig.dir }),
    });
    expect(r.status, r.stderr).toBe(0);
    const values = Object.fromEntries(r.stdout.trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    for (const v of hostVars) {
      expect(values[v], `${v} still names the physical rig`).not.toMatch(PHYSICAL_HOST_MARKERS);
      expect(values[v], `${v} was not reassigned by the same-box profile`).not.toContain(PHYSICAL_SEED);
    }
    expect(values.VM).toBe('same-box-vm');
    expect(values.VM_REPO).toBe(join(rig.vmHome, '.papercusp/pot-git/same-box-pot/gh-1296269.git'));
  });

  it('routes git-sync to the pot member while the pot-git store stays keyed by the pot', () => {
    // A create-from-repo pot is a pot home plus a member checkout. Targeting git-sync at the
    // pot home fires a routine that commits nothing, so every phase would wait on a store
    // that never moves.
    const rig = stubRig();
    const dump = ['TOWER_GIT_SYNC_SLUG', 'VM_GIT_SYNC_SLUG', 'TOWER_REPO', 'HIVE_GIT_DRILL_TARGET_GIT_SYNC_SLUG']
      .map((v) => `printf '%s=%s\\n' ${v} "\${${v}}"`)
      .join('; ');
    const r = spawnSync(
      'bash',
      ['-c', `set -u; TOWER_GIT_SYNC_SLUG=hello-world-3-pot; VM_GIT_SYNC_SLUG=hello-world-3-pot; . ${JSON.stringify(profileLib)}; rig_profile_apply >/dev/null || exit 9; ${dump}`],
      { encoding: 'utf8', env: cleanEnv({ HIVE_GIT_RIG: 'same-box', HIVE_GIT_SAME_BOX_RIG: rig.dir }) },
    );
    expect(r.status, r.stderr).toBe(0);
    const values = Object.fromEntries(r.stdout.trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    expect(values.TOWER_GIT_SYNC_SLUG).toBe('same-box-member');
    expect(values.VM_GIT_SYNC_SLUG).toBe('same-box-member');
    expect(values.HIVE_GIT_DRILL_TARGET_GIT_SYNC_SLUG).toBe('same-box-member');
    expect(values.TOWER_REPO).toBe(join(rig.towerHome, '.papercusp/pot-git/same-box-pot/gh-1296269.git'));
  });

  // Same-box run 20260930T050610Z failed phase A in 40s: the profile rewrote the status query
  // to the pot home while the readiness gate matched rows on the git-sync member slug. The
  // query is now built from that slug, so the two cannot disagree on either rig.
  it('the phase A status query targets the harness its readiness gate matches, on both rigs', () => {
    const fn = /\nphase_a_status_args\(\) \{\n[\s\S]*?\n\}\n/.exec(scenario)?.[0];
    expect(fn, 'phase_a_status_args must exist in the scenario').toBeTruthy();
    const rig = stubRig();
    const emit = `for s in "$TOWER_GIT_SYNC_SLUG" "$VM_GIT_SYNC_SLUG"; do phase_a_status_args "$s"; echo; done; printf '%s %s\\n' "$TOWER_GIT_SYNC_SLUG" "$VM_GIT_SYNC_SLUG"`;
    const cases = [
      ['same-box', { HIVE_GIT_RIG: 'same-box', HIVE_GIT_SAME_BOX_RIG: rig.dir }, 'same-box-member'],
      ['physical', {}, 'hello-world-3-pot'],
    ] as const;
    for (const [rigName, env, want] of cases) {
      const r = spawnSync(
        'bash',
        ['-c', `set -u; TOWER_GIT_SYNC_SLUG=hello-world-3-pot; VM_GIT_SYNC_SLUG=hello-world-3-pot\n${fn}\n. ${JSON.stringify(profileLib)}; rig_profile_apply >/dev/null || exit 9; ${emit}`],
        { encoding: 'utf8', env: cleanEnv(env) },
      );
      expect(r.status, `${rigName}: ${r.stderr}`).toBe(0);
      const [tower, vm, slugs] = r.stdout.trim().split('\n');
      expect(slugs, rigName).toBe(`${want} ${want}`);
      expect(JSON.parse(tower).targetHarness.harnessSlug, rigName).toBe(want);
      expect(JSON.parse(vm).targetHarness.harnessSlug, rigName).toBe(want);
    }
    // The gate matches rows on the same variables the query is built from.
    expect(scenario).toContain('phase_a_status_args "$VM_GIT_SYNC_SLUG"');
    expect(scenario).toContain('phase_a_status_args "$TOWER_GIT_SYNC_SLUG"');
    expect(scenario).toMatch(/phase_a_host_substrate_readiness vm "\$VM_GIT_SYNC_SLUG"/);
    expect(scenario).toMatch(/phase_a_host_substrate_readiness tower "\$TOWER_GIT_SYNC_SLUG"/);
    // No phase record or status query names a git-sync slug as a literal; the record writers
    // read the applied slugs, which the scenario exports after the profile.
    expect(scenario).not.toMatch(/installSlug: '[^']+'/);
    expect(scenario).not.toMatch(/"harnessSlug":"[a-z0-9-]+"/);
    expect(scenario.indexOf('\nexport TOWER_GIT_SYNC_SLUG VM_GIT_SYNC_SLUG\n')).toBeGreaterThan(scenario.indexOf('\nrig_profile_apply '));
  });

  it('every helper the profile hands the probe and scenario is executable', () => {
    // The scenario runs "$DEPLOY" and PATH-resolves the transports directly, so a helper that
    // lost its executable bit fails with "Permission denied" only once a rig is up (measured:
    // same-box-deploy.sh at mode 0644 killed `same-box-rig.sh up` after pot create + join).
    // Derived from the profile's own $RIG_PROFILE_LIB_DIR references plus the transport dir.
    const profile = readFileSync(profileLib, 'utf8');
    const referenced = [...profile.matchAll(/\$RIG_PROFILE_LIB_DIR\/([A-Za-z0-9._/-]+)/g)]
      .map((m) => join(dirname(profileLib), m[1]))
      .filter((p) => existsSync(p) && statSync(p).isFile());
    const transports = readdirSync(transportDir).map((f) => join(transportDir, f));
    const helpers = [...new Set([...referenced, ...transports])];
    // Calibration: the profile names the deploy helper and the tower tsx, so an empty set
    // would mean the derivation broke, not that everything is fine.
    expect(helpers.map((p) => p.split('/').pop())).toEqual(expect.arrayContaining(['same-box-deploy.sh', 'tower-tsx', 'ssh']));
    const notExecutable = helpers.filter((p) => (statSync(p).mode & 0o111) === 0);
    expect(notExecutable, 'rig helpers without an executable bit').toEqual([]);
  });

  it('refuses a rig.env without the git-sync member slug', () => {
    const rig = stubRig({ SB_GIT_SYNC_SLUG: '' });
    const r = spawnSync('bash', ['-c', `. ${JSON.stringify(profileLib)}; rig_profile_apply`], {
      encoding: 'utf8',
      env: cleanEnv({ HIVE_GIT_RIG: 'same-box', HIVE_GIT_SAME_BOX_RIG: rig.dir }),
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/does not set SB_GIT_SYNC_SLUG/);
  });

  it('points the rig preflight at the rig owners (same-box) and adds nothing on the physical rig', () => {
    const args = (env: NodeJS.ProcessEnv) =>
      spawnSync('bash', ['-c', `. ${JSON.stringify(profileLib)}; rig_profile_apply >/dev/null || exit 9; rig_profile_preflight_args`], {
        encoding: 'utf8',
        env,
      });
    const physical = args(cleanEnv());
    expect(physical.status, physical.stderr).toBe(0);
    expect(physical.stdout).toBe('');
    // same-box: hosts-answering must read the throwaway owners, never the live :3070.
    const rig = stubRig();
    const sameBox = args(cleanEnv({ HIVE_GIT_RIG: 'same-box', HIVE_GIT_SAME_BOX_RIG: rig.dir }));
    expect(sameBox.status, sameBox.stderr).toBe(0);
    expect(sameBox.stdout.trim().split('\n')).toEqual([
      '--check', 'drill-source-committed', '--check', 'hosts-answering', '--tower-port', '41001', '--vm-port', '41002',
    ]);
    expect(sameBox.stderr).toMatch(/skipped=canary-mode-baseline,vm-trust-hold-ready,vm-payload-current/);
    // The real probe hands those arguments to rig-preflight.
    expect(probe).toMatch(/mapfile -t rig_preflight_args < <\(rig_profile_preflight_args\)/);
    expect(probe).toMatch(/rig-preflight \\\n[^\n]*\n\s*\$\{rig_preflight_args\[@\]\+"\$\{rig_preflight_args\[@\]\}"\}/);
  });

  it('the physical profile (the default) changes nothing', () => {
    const r = spawnSync('bash', ['-c', `VM=aviweiss@172.31.44.2; PATH_BEFORE="$PATH"; . ${JSON.stringify(profileLib)}; rig_profile_apply || exit 9; echo "$VM"; [ "$PATH" = "$PATH_BEFORE" ] && echo same-path`], {
      encoding: 'utf8',
      env: cleanEnv(),
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim().split('\n')).toEqual(['aviweiss@172.31.44.2', 'same-path']);
  });

  it('refuses a rig.env that carries code, reuses a home or a port, or points at the real $HOME', () => {
    const cases: [ReturnType<typeof stubRig>, RegExp][] = [
      [stubRig({ SB_NODE: '$(touch /tmp/rig-profile-pwned)' }), /not an allowed SB_\* assignment/],
      [stubRig({}, ['PATH=/tmp/evil']), /not an allowed SB_\* assignment/],
      [stubRig({ SB_VM_PORT: '41001' }), /same port/],
      [stubRig({ SB_VM_HOME: process.env.HOME ?? '/root' }), /real \$HOME/],
      [stubRig({ SB_VM_PG_PORT: '' }), /does not set SB_VM_PG_PORT/],
      [stubRig({ SB_VM_PG_PORT: '41101' }), /same PG port/],
      [stubRig({ SB_TOWER_PG_PORT: '5432' }), /live operator's PG port 5432/],
    ];
    for (const [rig, message] of cases) {
      const r = spawnSync('bash', ['-c', `. ${JSON.stringify(profileLib)}; rig_profile_apply`], {
        encoding: 'utf8',
        env: cleanEnv({ HIVE_GIT_RIG: 'same-box', HIVE_GIT_SAME_BOX_RIG: rig.dir }),
      });
      expect(r.status, readFileSync(join(rig.dir, 'rig.env'), 'utf8')).toBe(2);
      expect(r.stderr).toMatch(message);
    }
    expect(existsSync('/tmp/rig-profile-pwned')).toBe(false);
  });
});

describe('same-box transport — the rig can never reach another machine', () => {
  function transport(tool: 'ssh' | 'scp', args: string[], vmHome: string, input?: string) {
    return spawnSync(join(transportDir, tool), args, {
      encoding: 'utf8',
      input,
      env: cleanEnv({
        SAME_BOX_VM_HOME: vmHome,
        SAME_BOX_VM_PORT: '41002',
        SAME_BOX_VM_PG_PORT: '41102',
        SAME_BOX_RIG_DIR: scratch,
      }),
    });
  }

  it('ssh refuses every host but the sentinel with status 255 and runs nothing', () => {
    const rig = stubRig();
    const marker = join(rig.dir, 'ran');
    for (const target of ['aviweiss@172.31.44.2', '172.31.44.2', 'mac-vm', 'same-box-vm.evil', 'root@localhost']) {
      const r = transport('ssh', ['-o', 'BatchMode=yes', target, `touch ${marker}`], rig.vmHome);
      expect(r.status, target).toBe(255);
      expect(r.stderr, target).toMatch(/refusing host/);
    }
    expect(existsSync(marker)).toBe(false);
  });

  it('ssh to the sentinel runs the command as the VM instance, with its stdin', () => {
    const rig = stubRig();
    const r = transport(
      'ssh',
      ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'aviweiss@same-box-vm', 'echo "$PWD|$HOME|$PAPERCUSP_HONO_PORT|$PCUSP_MCP_CALL"; cat'],
      rig.vmHome,
      'from-stdin\n',
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe(`${rig.vmHome}|${rig.vmHome}|41002|${join(scratch, 'mcp-call.mjs')}\nfrom-stdin\n`);
    const n = transport('ssh', ['-n', 'same-box-vm', 'cat'], rig.vmHome, 'must-not-arrive\n');
    expect(n.stdout).toBe('');
  });

  it('scp copies to and from the sentinel only', () => {
    const rig = stubRig();
    const src = join(rig.dir, 'payload');
    writeFileSync(src, 'bytes\n');
    expect(transport('scp', ['-q', '-o', 'ConnectTimeout=10', src, 'same-box-vm:copied'], rig.vmHome).status).toBe(0);
    expect(readFileSync(join(rig.vmHome, 'copied'), 'utf8')).toBe('bytes\n');
    const back = join(rig.dir, 'back');
    expect(transport('scp', [`same-box-vm:${join(rig.vmHome, 'copied')}`, back], rig.vmHome).status).toBe(0);
    expect(readFileSync(back, 'utf8')).toBe('bytes\n');
    const foreign = transport('scp', [src, 'aviweiss@172.31.44.2:/tmp/x'], rig.vmHome);
    expect(foreign.status).toBe(1);
    expect(foreign.stderr).toMatch(/refusing host '172\.31\.44\.2'/);
  });
});

describe('rig-profile.sh — the same-box paths are checked before the slow run', () => {
  function pathsReady(rig: ReturnType<typeof stubRig>) {
    return spawnSync('bash', ['-c', `. ${JSON.stringify(profileLib)}; rig_profile_same_box_paths_ready`], {
      encoding: 'utf8',
      env: cleanEnv({ HIVE_GIT_RIG: 'same-box', HIVE_GIT_SAME_BOX_RIG: rig.dir }),
    });
  }
  it('names every missing path on an unconverged rig and exits 1', () => {
    const r = pathsReady(stubRig());
    expect(r.status).toBe(1);
    for (const v of ['TOWER_CACHE', 'TOWER_REPO', 'VM_CACHE', 'VM_IDENTITY_DIR', 'VM_REPO', 'VM_CALL', 'VM_DEP_SOURCE']) {
      expect(r.stderr).toMatch(new RegExp(`RIG_PROFILE_PATH_MISSING ${v}=`));
    }
  });

  it('accepts the layout a same-box owner writes (<home>/.papercusp), not the physical .shared layout', () => {
    const rig = stubRig();
    converge(rig);
    const r = pathsReady(rig);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toBe('');
  });

  it('the drill entry refuses a rig with a missing profile path before any work', () => {
    const rig = stubRig();
    const r = spawnSync('bash', [drillPath, '--rig', 'same-box', '--only-phase', 'A'], {
      encoding: 'utf8',
      env: cleanEnv({ HIVE_GIT_SAME_BOX_RIG: rig.dir, HIVE_GIT_PHYSICAL_PROBE_CMD: '/bin/false' }),
      timeout: 30_000,
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/RIG_PROFILE_PATH_MISSING TOWER_CACHE=/);
    expect(r.stdout).not.toMatch(/VH_RUN/);
  });
});

describe('same-box transport — a rig producer never reaches the live operator database', () => {
  // r4 rig finding (2026-09-30): once an owner is down its embedded-pg.json is gone, and the
  // real resolver (embedded-pg-discovery.ts) falls back to the native :5432 — the LIVE
  // operator database. A converge run after the owners died reached it. Both transports pin
  // the fallback to the rig instance's own PG port, so a down owner fails closed.
  const LIVE_DB = 'postgresql://harness_admin:live@localhost:5432/papercusp';
  function resolverProbe(): string {
    const probe = join(scratch, 'resolve-db.mts');
    const lib = pathToFileURL(join(root, 'packages', 'operator-core', 'lib', 'embedded-pg-discovery.ts')).href;
    writeFileSync(
      probe,
      `const m = await import(${JSON.stringify(lib)});\n` +
        `const r = m.getHarnessAdminUrlWithSource();\n` +
        `console.log((/:(\\d+)\\//.exec(r.url)?.[1] ?? 'no-port') + '|' + r.source);\n`,
    );
    return probe;
  }
  function towerTsx(rig: ReturnType<typeof stubRig>, extra: Record<string, string>) {
    return spawnSync(join(transportDir, 'tower-tsx'), [resolverProbe()], {
      encoding: 'utf8',
      cwd: root,
      env: cleanEnv({
        SAME_BOX_TOWER_HOME: rig.towerHome,
        SAME_BOX_TOWER_PORT: '41001',
        SAME_BOX_TSX: tsx,
        SAME_BOX_NODE: process.execPath,
        DATABASE_URL: LIVE_DB,
        ...extra,
      }),
    });
  }

  it('calibration: the real resolver with no DB variables and no discovery file DOES reach :5432', () => {
    const rig = stubRig();
    const r = spawnSync(process.execPath, [tsx, resolverProbe()], {
      encoding: 'utf8',
      cwd: root,
      env: { ...cleanEnv(), HOME: rig.towerHome, DATABASE_URL: '', HARNESS_ADMIN_DATABASE_URL: '', PAPERCUSP_PG_URL: '', PAPERCUSP_HOME: '' },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe('5432|native-fallback');
  });

  it('tower-tsx scrubs the caller database and pins the fallback to the tower instance PG port', () => {
    const r = towerTsx(stubRig(), { SAME_BOX_TOWER_PG_PORT: '41101' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe('41101|native-fallback');
  });

  it('tower-tsx refuses to run without a rig PG port, or with the live :5432', () => {
    const refusals: Record<string, string>[] = [{}, { SAME_BOX_TOWER_PG_PORT: '5432' }, { SAME_BOX_TOWER_PG_PORT: 'x' }];
    for (const extra of refusals) {
      const r = towerTsx(stubRig(), extra);
      expect(r.status, JSON.stringify(extra)).toBe(2);
      expect(r.stdout).toBe('');
      expect(r.stderr).toMatch(/SAME_BOX_TOWER_PG_PORT/);
    }
  });

  it('ssh runs the VM producer against the VM instance PG port, never the caller database', () => {
    const rig = stubRig();
    const env = cleanEnv({
      SAME_BOX_VM_HOME: rig.vmHome,
      SAME_BOX_VM_PORT: '41002',
      SAME_BOX_VM_PG_PORT: '41102',
      DATABASE_URL: LIVE_DB,
    });
    const cmd = `'${process.execPath}' '${tsx}' '${resolverProbe()}'`;
    const r = spawnSync(join(transportDir, 'ssh'), ['same-box-vm', cmd], { encoding: 'utf8', env });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe('41102|native-fallback');
    const marker = join(rig.dir, 'ran');
    const refused = spawnSync(join(transportDir, 'ssh'), ['same-box-vm', `touch ${marker}`], {
      encoding: 'utf8',
      env: { ...env, SAME_BOX_VM_PG_PORT: '5432' },
    });
    expect(refused.status).toBe(255);
    expect(refused.stderr).toMatch(/SAME_BOX_VM_PG_PORT/);
    expect(existsSync(marker)).toBe(false);
  });
});

describe('hive-git-drill.sh --rig same-box — the same entry point, never evidence', () => {
  it('refuses an unusable same-box request before any work (exit 2, no work dir)', () => {
    const rig = stubRig();
    const cases: [string[], Record<string, string>, RegExp][] = [
      [['--rig', 'bogus'], {}, /is not a rig profile/],
      [['--rig', 'same-box'], {}, /needs HIVE_GIT_SAME_BOX_RIG/],
      [['--rig=same-box'], { HIVE_GIT_SAME_BOX_RIG: rig.dir, REQUIRE_ZERO_SKIPS: '1' }, /same-box rehearsal can never satisfy it/],
    ];
    for (const [args, extra, message] of cases) {
      const work = join(scratch, `early-work-${seq++}`);
      const r = spawnSync('bash', [drillPath, ...args], {
        encoding: 'utf8',
        env: cleanEnv({ PAPERCUSP_DRILL_WORK: work, HIVE_GIT_DRILL_EVIDENCE_ROOT: join(work, 'ev'), ...extra }),
        timeout: 60_000,
      });
      expect(r.status, args.join(' ')).toBe(2);
      expect(`${r.stdout}${r.stderr}`, args.join(' ')).toMatch(message);
      expect(existsSync(work), args.join(' ')).toBe(false);
    }
  });

  it('with no selection it hands the checked-in probe every phase under the same-box profile, and is not evidence', () => {
    const rig = converge(stubRig());
    const t = join(scratch, `tree-${seq++}`);
    mkdirSync(join(t, 'desk', 'bin', 'vm-rig'), { recursive: true });
    mkdirSync(join(t, 'libs', 'generic'), { recursive: true });
    copyFileSync(drillPath, join(t, 'desk', 'bin', 'hive-git-drill.sh'));
    symlinkSync(join(desktopBin, 'lib'), join(t, 'desk', 'bin', 'lib'));
    symlinkSync(join(vmRig, 'lib'), join(t, 'desk', 'bin', 'vm-rig', 'lib'));
    symlinkSync(join(root, 'libs', 'generic', 'verification-harness'), join(t, 'libs', 'generic', 'verification-harness'));
    const saw = join(t, 'probe-saw');
    // The stub sits at the canonical probe path; HIVE_GIT_PHYSICAL_PROBE_CMD is NOT set, so the
    // drill must pick the checked-in probe itself (the same entry point as the physical rig).
    const stub = join(t, 'desk', 'bin', 'vm-rig', 'hive-git-physical-probe.sh');
    writeFileSync(
      stub,
      `#!/usr/bin/env bash\nprintf '%s|%s|%s|%s\\n' "\${HIVE_GIT_RIG:-}" "\${HIVE_GIT_SAME_BOX_RIG:-}" "\${HIVE_GIT_PHYSICAL_PHASES:-}" "\${0}" >${JSON.stringify(saw)}\nprintf '{"schemaVersion":"hive-git-physical-partial/v1","phases":"%s","releaseEvidence":false}\\n' "$HIVE_GIT_PHYSICAL_PHASES"; exit 0\n`,
      { mode: 0o755 },
    );
    const r = spawnSync('bash', [join(t, 'desk', 'bin', 'hive-git-drill.sh'), '--rig', 'same-box'], {
      encoding: 'utf8',
      env: cleanEnv({
        PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID: 'stub-task',
        HIVE_GIT_SAME_BOX_RIG: rig.dir,
        HIVE_GIT_PHYSICAL_RUNS_DIR: join(t, 'runs'),
        PAPERCUSP_DRILL_WORK: join(t, 'work'),
        HIVE_GIT_DRILL_EVIDENCE_ROOT: join(t, 'ev'),
        PAPERCUSP_REPO_DIR: root,
        VH_TSX: tsx,
        KEEP_UP: '1',
      }),
      timeout: 120_000,
    });
    const all = spawnSync('bash', ['-c', `. ${JSON.stringify(selectLib)}; physical_phase_select from-phase A`], { encoding: 'utf8' }).stdout.trim();
    expect(all).toMatch(/^A,B,C,D,E,F,G,H,I,J/);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    const probeSaw = readFileSync(saw, 'utf8').trim().split('|');
    expect(probeSaw).toEqual(['same-box', rig.dir, all, stub]);
    expect(r.stdout).toMatch(/SAME_BOX_REHEARSAL phases=A,B,C/);
    expect(r.stdout).not.toMatch(/=== extract /); // the local single-box legs never ran
    expect(r.stdout).toMatch(/NOT release evidence/);
    expect(r.stdout).not.toMatch(/physical evidence accepted/);
  });
});

describe('the real probe and scenario apply the profile on the one path they share', () => {
  const probe = readFileSync(probePath, 'utf8');
  const scenario = readFileSync(scenarioPath, 'utf8');

  it('the probe refuses a physical-only phase in a same-box run before its first ssh', () => {
    const rig = stubRig();
    const run = join(scratch, `probe-run-${seq++}`);
    mkdirSync(run, { recursive: true });
    const r = spawnSync('bash', [probePath, join(run, 'hive-git-physical-evidence.json'), join(run, 'trust.json')], {
      encoding: 'utf8',
      env: cleanEnv({
        HIVE_GIT_RIG: 'same-box',
        HIVE_GIT_SAME_BOX_RIG: rig.dir,
        HIVE_GIT_PHYSICAL_PHASES: 'D,E',
        HIVE_GIT_PHYSICAL_PLAN: 'p2p-git-live-activation-2026-07-09', // what the drill exports
        PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID: 'stub-task',
      }),
      timeout: 60_000,
    });
    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toMatch(/RIG_PROFILE rig=same-box vm=same-box-vm/);
    expect(r.stderr).toMatch(/phase E needs the physical rig \(needs the GitHub remote only the physical rig owns\)/);
    const apply = probe.indexOf('rig_profile_apply');
    const firstSsh = probe.indexOf('ssh "${SSH_OPTS[@]}"');
    expect(apply).toBeGreaterThan(-1);
    expect(apply).toBeLessThan(firstSsh);
  });

  it('a same-box probe run is never full, so it takes the partial exit before anything is signed', () => {
    const forced = probe.indexOf('if rig_profile_is_diagnostic; then physical_full_run=0; fi');
    expect(forced).toBeGreaterThan(probe.indexOf('physical_phase_is_full "$physical_phases" && physical_full_run=1'));
    expect(forced).toBeLessThan(probe.indexOf('PARTIAL-RUN-EXIT'));
  });

  it('the scenario applies the profile after its last host constant and before the first host access', () => {
    const apply = scenario.indexOf('\nrig_profile_apply ');
    expect(apply).toBeGreaterThan(-1);
    for (const v of physicalHostVars(scenario)) {
      const def = scenario.lastIndexOf(`\n${v}=`);
      expect(def, `${v} is defined after the profile is applied`).toBeLessThan(apply);
    }
    for (const firstAccess of ['\nverify_physical_vm_source\n', '\nensure_vm_driver_current\n', '\nrun_all_phases\n']) {
      expect(scenario.indexOf(firstAccess), firstAccess.trim()).toBeGreaterThan(apply);
    }
    const tail = scenario.slice(apply, scenario.indexOf('\nrun_all_phases\n'));
    expect(tail).toMatch(/if rig_profile_is_diagnostic; then SCENARIO_FULL_RUN=0; fi/);
  });

  // Found live, twice (same-box runs 20260930T044642Z and 20260930T045352Z): both owners run
  // on ONE machine by construction, so a two-machine check on the shared path kills every
  // same-box run before its first phase. The producer preflight is pinned behaviourally in
  // physical-drill-target.test.ts; this pins the scenario's own identity contract.
  it('the scenario demands two machines only on the physical rig, and two owners always', () => {
    const sourced = scenario.indexOf('\n. "$HERE/lib/rig-profile.sh"\n');
    const machineFail = scenario.indexOf("fail 'tower and vm identities resolve to the same physical machine'");
    expect(sourced, 'the profile library must be sourced before the identity contract').toBeGreaterThan(-1);
    expect(machineFail).toBeGreaterThan(sourced);
    const gate = scenario.lastIndexOf('\nif ! rig_profile_is_diagnostic; then\n', machineFail);
    expect(gate, 'the two-machine check sits inside a physical-rig-only block').toBeGreaterThan(sourced);
    expect(scenario.indexOf('\nfi\n', gate)).toBeGreaterThan(machineFail);
    // The owner check stays unconditional (column 0, not inside the gate).
    expect(scenario).toMatch(
      /\n\[ "\$tower_device" != "\$vm_device" \] \\\n {2}\|\| fail 'tower and vm identities resolve to the same device key'\n/,
    );
    // Exactly one two-machine refusal on the shared path, so a new one cannot slip in ungated.
    expect(scenario.split('same physical machine').length - 1).toBe(1);
    expect(probe).not.toMatch(/same physical machine|distinct machineFingerprint/);
  });
});
