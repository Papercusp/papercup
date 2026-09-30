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
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
    'SAME_BOX_RIG_DIR',
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
    SB_VM_HOME: vmHome,
    SB_VM_PORT: '41002',
    SB_NODE: process.execPath,
    SB_TSX: tsx,
    SB_POT_HOME: 'same-box-pot',
    SB_REPO_KEY: 'gh-1296269',
    SB_WORKSPACE: 'same-box-ws',
    SB_PHYSICAL_ONLY_PHASES: "'E:needs the GitHub remote only the physical rig owns'",
    ...overrides,
  };
  const body = [...Object.entries(env).map(([k, v]) => `${k}=${v}`), ...extraLines].join('\n');
  writeFileSync(join(dir, 'rig.env'), `${body}\n`);
  return { dir, towerHome, vmHome };
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
      env: cleanEnv({ SAME_BOX_VM_HOME: vmHome, SAME_BOX_VM_PORT: '41002', SAME_BOX_RIG_DIR: scratch }),
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
    const rig = stubRig();
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
});
