import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { CommsTrustEntry } from '../../trust/comms-trust';
import { PHASE_D_TIER_HOLD_NOTE_PREFIX } from './physical-drill-phase-d';
import {
  DRILL_PHASE_D_LOCK_OWNER_MARKER,
  PHYSICAL_DRILL_PREFLIGHT_CHECKS,
  PHYSICAL_DRILL_PREFLIGHT_FAILED,
  parseBuildStamp,
  parsePhysicalDrillPreflightArgs,
  parseVmPayloadProbe,
  physicalDrillPreflightMode,
  runPhysicalDrillPreflight,
  vmPayloadProbeCommand,
  type PhysicalDrillPreflightDeps,
  type VmPayloadProbe,
} from './physical-drill-preflight';

// physical-drill-iteration-speed-2026-09-29 P-003 (R-5): each P-505 guard-rail fact
// is an executable, read-only refusal that runs before the first rig ssh. Every
// dependency is stubbed — no real ssh, git, database or HTTP call happens here.

const NOW = Date.parse('2026-09-30T02:00:00Z');
const SERVE = 'a'.repeat(64);
const HARNESS = 'b'.repeat(64);
const VM_USER = 1567022;
const TOWER_USER = 279242982;

function trust(overrides: Partial<CommsTrustEntry> = {}): CommsTrustEntry {
  return {
    githubUserId: VM_USER,
    tier: 'steer',
    gate: false,
    note: 'Owner device identity — canary auto-integrate unblock',
    expiresAtMs: null,
    createdTs: NOW - 1_000,
    updatedTs: NOW - 1_000,
    ...overrides,
  };
}

function vmProbe(overrides: Partial<VmPayloadProbe> = {}): VmPayloadProbe {
  return {
    stampServeSha256: SERVE,
    stampHarnessSuSha256: HARNESS,
    serveSha256: SERVE,
    harnessSuSha256: HARNESS,
    ownerHealthStatus: '200',
    ...overrides,
  };
}

/** A healthy rig; each test breaks exactly one thing. */
function healthy(overrides: Partial<PhysicalDrillPreflightDeps> = {}): Required<PhysicalDrillPreflightDeps> {
  return {
    listTrust: vi.fn(async () => [trust(), trust({ githubUserId: TOWER_USER })]),
    readCanaryMode: vi.fn(async () => ({ mode: 'bridged', source: 'set' })),
    gitStatus: vi.fn(async () => [' M packages/operator-core/lib/sync/pot-git/physical-drill-phase-d.test.ts']),
    readHeadFile: vi.fn(async () => `const owner = \`${DRILL_PHASE_D_LOCK_OWNER_MARKER}\${runId}\`;`),
    probeVm: vi.fn(async () => vmProbe()),
    readTowerStamp: vi.fn(async () => ({ serveSha256: SERVE, harnessSuSha256: HARNESS, composedAt: '2026-09-29T01:12:18Z' })),
    towerHealthStatus: vi.fn(async () => 200),
    nowMs: () => NOW,
    ...overrides,
  } as Required<PhysicalDrillPreflightDeps>;
}

async function refusal(deps: PhysicalDrillPreflightDeps, vmGithubUserId: number | null = VM_USER) {
  const report = await runPhysicalDrillPreflight({ vmGithubUserId }, deps);
  expect(report.ok).toBe(false);
  return report.firstFailure!;
}

describe('runPhysicalDrillPreflight', () => {
  it('passes a healthy rig on every named check (test-file edits are not drill source)', async () => {
    const report = await runPhysicalDrillPreflight({ vmGithubUserId: VM_USER }, healthy());
    expect(report.ok).toBe(true);
    expect(report.firstFailure).toBeNull();
    expect(report.results.map((result) => result.check)).toEqual([...PHYSICAL_DRILL_PREFLIGHT_CHECKS]);
    expect(report.results.every((result) => result.ok)).toBe(true);
  });

  it('drill-source-committed: refuses uncommitted or untracked drill source, naming the files', async () => {
    const failure = await refusal(
      healthy({
        gitStatus: vi.fn(async () => [
          ' M packages/operator-core/lib/sync/pot-git/physical-drill-phase-e.ts',
          '?? packages/operator-core/lib/sync/pot-git/physical-drill-new.ts',
        ]),
      }),
    );
    expect(failure.check).toBe('drill-source-committed');
    expect(failure.reason).toContain('physical-drill-phase-e.ts');
    expect(failure.reason).toContain('physical-drill-new.ts');
    expect(failure.reason).toContain('git archive');
  });

  it('drill-source-committed: refuses a HEAD Phase D without the live dirt lock (WI-10003741)', async () => {
    const failure = await refusal(healthy({ readHeadFile: vi.fn(async () => 'export const nothing = 1;') }));
    expect(failure.check).toBe('drill-source-committed');
    expect(failure.reason).toContain(DRILL_PHASE_D_LOCK_OWNER_MARKER);
  });

  it('canary-mode-baseline: refuses a canary a crashed Phase E left in legacy', async () => {
    const failure = await refusal(healthy({ readCanaryMode: vi.fn(async () => ({ mode: 'legacy', source: 'set' })) }));
    expect(failure.check).toBe('canary-mode-baseline');
    expect(failure.reason).toContain("'legacy'");
    expect(failure.reason).toContain('phase-e-mode-ensure bridged');
  });

  it('vm-trust-hold-ready: refuses a never-restored below-steer hold, even after it lapsed', async () => {
    for (const expiresAtMs of [NOW + 60_000, NOW - 60_000]) {
      const failure = await refusal(
        healthy({
          listTrust: vi.fn(async () => [
            trust({
              tier: 'message',
              note: `${PHASE_D_TIER_HOLD_NOTE_PREFIX} p505-run-27; restore the prior row via phase-d-tier-restore`,
              expiresAtMs,
            }),
          ]),
        }),
      );
      expect(failure.check).toBe('vm-trust-hold-ready');
      expect(failure.reason).toContain('p505-run-27');
      expect(failure.reason).toContain(`github user ${VM_USER}`);
      expect(failure.reason).toContain(expiresAtMs > NOW ? 'expires' : 'lapsed');
    }
  });

  it('vm-trust-hold-ready: refuses a gate-only VM row the hold could not restore exactly', async () => {
    const failure = await refusal(healthy({ listTrust: vi.fn(async () => [trust({ tier: null, gate: true })]) }));
    expect(failure.check).toBe('vm-trust-hold-ready');
    expect(failure.reason).toContain('gate-only');
  });

  it('vm-trust-hold-ready: another user\'s gate-only row is irrelevant when the VM user is known, and refused when it is not', async () => {
    const deps = healthy({
      listTrust: vi.fn(async () => [trust(), trust({ githubUserId: 42, tier: null, gate: true })]),
    });
    expect((await runPhysicalDrillPreflight({ vmGithubUserId: VM_USER }, deps)).ok).toBe(true);
    const failure = await refusal(deps, null);
    expect(failure.reason).toContain('github user 42');
    expect(failure.reason).toContain('VM user unknown');
  });

  it('vm-payload-current: refuses a VM payload that is not the build the tower composed', async () => {
    const other = 'c'.repeat(64);
    const failure = await refusal(
      healthy({ probeVm: vi.fn(async () => vmProbe({ stampServeSha256: other, serveSha256: other })) }),
    );
    expect(failure.check).toBe('vm-payload-current');
    expect(failure.reason).toContain('not the build the tower last composed');
  });

  it('vm-payload-current: refuses current code against a stale harness (WI-10003486)', async () => {
    const failure = await refusal(healthy({ probeVm: vi.fn(async () => vmProbe({ harnessSuSha256: 'd'.repeat(64) })) }));
    expect(failure.check).toBe('vm-payload-current');
    expect(failure.reason).toContain('stale harness');
  });

  it('vm-payload-current: an unknown expected build is a refusal, not a pass', async () => {
    const failure = await refusal(healthy({ readTowerStamp: vi.fn(async () => null) }));
    expect(failure.check).toBe('vm-payload-current');
    expect(failure.reason).toContain('compose-rig-sidecar-current.sh');
  });

  it('hosts-answering: refuses when either owner does not answer health', async () => {
    const vmDown = await refusal(healthy({ probeVm: vi.fn(async () => vmProbe({ ownerHealthStatus: '000' })) }));
    expect(vmDown.check).toBe('hosts-answering');
    expect(vmDown.reason).toContain('VM owner');
    const towerDown = await refusal(healthy({ towerHealthStatus: vi.fn(async () => 0) }));
    expect(towerDown.check).toBe('hosts-answering');
    expect(towerDown.reason).toContain('tower');
  });

  it('a check whose gatherer throws FAILS — an unmeasured guard rail is not a pass', async () => {
    const failure = await refusal(
      healthy({ listTrust: vi.fn(async () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:5432'))) }),
    );
    expect(failure.check).toBe('vm-trust-hold-ready');
    expect(failure.reason).toContain('could not be evaluated');
    expect(failure.reason).toContain('ECONNREFUSED');
  });

  it('--check runs only the named checks and gathers nothing else (no ssh for a source-only check)', async () => {
    const deps = healthy();
    const report = await runPhysicalDrillPreflight({ checks: ['drill-source-committed'] }, deps);
    expect(report.results.map((result) => result.check)).toEqual(['drill-source-committed']);
    expect(deps.probeVm).not.toHaveBeenCalled();
    expect(deps.listTrust).not.toHaveBeenCalled();
    expect(deps.readCanaryMode).not.toHaveBeenCalled();
  });

  it('vm-payload-current and hosts-answering share ONE VM ssh round-trip', async () => {
    const deps = healthy();
    await runPhysicalDrillPreflight({}, deps);
    expect(deps.probeVm).toHaveBeenCalledTimes(1);
  });
});

describe('physicalDrillPreflightMode (producer rig-preflight)', () => {
  it('returns the report when every check passes', async () => {
    const report = await physicalDrillPreflightMode(['--vm-github-user-id', String(VM_USER)], healthy());
    expect(report.ok).toBe(true);
  });

  it('refuses with a first line naming the failed check, then every other failure', async () => {
    const run = physicalDrillPreflightMode(
      [],
      healthy({
        readCanaryMode: vi.fn(async () => ({ mode: 'legacy', source: 'set' })),
        towerHealthStatus: vi.fn(async () => 503),
      }),
    );
    await expect(run).rejects.toThrow(/^PHYSICAL_PREFLIGHT_FAILED canary-mode-baseline: /);
    const message = await run.then(
      () => '',
      (error: Error) => error.message,
    );
    const lines = message.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(new RegExp(`^${PHYSICAL_DRILL_PREFLIGHT_FAILED} hosts-answering: `));
  });

  it('parses --check/--vm-github-user-id and rejects anything else before gathering', () => {
    expect(parsePhysicalDrillPreflightArgs(['--check', 'canary-mode-baseline', '--check', 'hosts-answering'])).toEqual({
      checks: ['canary-mode-baseline', 'hosts-answering'],
      vmGithubUserId: null,
    });
    expect(parsePhysicalDrillPreflightArgs(['--vm-github-user-id', '1567022']).vmGithubUserId).toBe(1567022);
    for (const bad of [['--check', 'nope'], ['--check'], ['--vm-github-user-id', '0'], ['--force']]) {
      expect(() => parsePhysicalDrillPreflightArgs(bad)).toThrow(/usage: physical-drill-producer rig-preflight/);
    }
  });
});

describe('VM probe plumbing', () => {
  it('parses the single ssh output, treating a silent health curl as not answering', () => {
    expect(
      parseVmPayloadProbe(
        `stamp.serveSha256=${SERVE}\nstamp.harnessSuSha256=${HARNESS}\nserve=${SERVE}\nharness=${HARNESS}\nhealth=200\n`,
      ),
    ).toEqual(vmProbe());
    expect(parseVmPayloadProbe('serve=\nharness=\nhealth=\n')).toEqual({
      stampServeSha256: '',
      stampHarnessSuSha256: '',
      serveSha256: '',
      harnessSuSha256: '',
      ownerHealthStatus: '000',
    });
  });

  it('reads the tower compose stamp in the shape compose-rig-sidecar-current.sh writes', () => {
    expect(
      parseBuildStamp(
        `sha=aef4431553c9 dirty=1 composedAt=2026-09-29T01:12:18Z\nserveSha256=${SERVE}\nserveBytes=1\nharnessSuSha256=${HARNESS}\n`,
      ),
    ).toEqual({ serveSha256: SERVE, harnessSuSha256: HARNESS, composedAt: '2026-09-29T01:12:18Z' });
  });

  it('defaults the VM payload dir to the VM\'s own $HOME and is read-only', () => {
    const command = vmPayloadProbeCommand();
    expect(command).toContain('"$HOME/rig-sidecar-current"/BUILD-STAMP.txt');
    expect(command).not.toMatch(/\/Users\//);
    expect(command).not.toMatch(/\b(rm|mv|cp|tee|kill)\b|>\s*[^&/]/);
    expect(vmPayloadProbeCommand("/tmp/it's")).toContain(`'/tmp/it'\\''s'/serve.mjs`);
  });
});

describe('hold-note single source', () => {
  it('the hold Phase D writes carries the prefix the preflight recognises', () => {
    const phaseD = readFileSync(fileURLToPath(new URL('./physical-drill-phase-d.ts', import.meta.url)), 'utf8');
    expect(phaseD).toContain('note: `${PHASE_D_TIER_HOLD_NOTE_PREFIX} ${input.runId};');
  });
});
