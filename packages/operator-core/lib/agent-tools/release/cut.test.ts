/**
 * cut.test.ts — the release:cut TOOL routing + safety gates (P-5 Unit B). Mocks the cut
 * primitives (launch / status / handoff / preflight) + PG/identity I/O so it asserts the
 * decision logic — preflight, dry-run vs fire, the operator role gate, the cut-in-flight
 * refusal, LOCAL-only invariants — without spawning a real build or touching PG.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/release/cut.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreflightResult, CutStatus, HandoffResult, ReleaseGate } from '../../release-cut-launch';

// Partial-mock: keep the REAL pure helpers the handler uses (isValidVersion, buildCutArgv,
// desktopRoot, CHANNELS, CUT_UNIT, cutUnitFor, legsForPlatform, ...) and override only the
// functions that do real I/O.
vi.mock('../../release-cut-launch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../release-cut-launch')>()),
  launchDetachedCut: vi.fn(),
  readCutStatus: vi.fn(),
  collectHandoff: vi.fn(),
  preflightCut: vi.fn(),
  abortLeg: vi.fn(),
  readOrCreateGate: vi.fn(),
}));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: { unsafe: vi.fn() } }) as never,
}));
vi.mock('../../workspace-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../workspace-registry')>()),
  activeWorkspaceId: () => 'test-ws',
}));
vi.mock('../locks/identity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../locks/identity')>()),
  readIdentity: () => ({ ownerId: 'o', ownerLabel: 'tester', coordinationDomain: 'd' }) as never,
}));

import { launchDetachedCut, readCutStatus, collectHandoff, preflightCut, abortLeg, readOrCreateGate } from '../../release-cut-launch';
const launchM = vi.mocked(launchDetachedCut);
const statusM = vi.mocked(readCutStatus);
const handoffM = vi.mocked(collectHandoff);
const preflightM = vi.mocked(preflightCut);
const abortLegM = vi.mocked(abortLeg);
const gateM = vi.mocked(readOrCreateGate);
const tool = (await import('./cut')).default;

type Out = { content: { text: string }[] };
const body = (o: unknown) => JSON.parse((o as Out).content[0]!.text);

function mkPreflight(over: Partial<PreflightResult> = {}, inFlight = false): PreflightResult {
  return {
    go: !inFlight,
    desktopRoot: '/root/papercusp-desktop',
    checks: [
      { name: 'cutter', ok: true, detail: 'ok' },
      { name: 'signing-key', ok: true, detail: 'ok' },
      { name: 'no-cut-in-flight', ok: !inFlight, detail: inFlight ? 'a cut is already running' : 'no cut in flight' },
    ],
    blockers: inFlight ? ['no-cut-in-flight: a cut is already running'] : [],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  preflightM.mockReturnValue(mkPreflight());
  launchM.mockResolvedValue({
    launched: true,
    unit: 'papercup-release-cut',
    version: '0.0.8',
    channel: 'alpha',
    legs: {},
    argv: [],
    logPath: '/tmp/papercup-release-cut.log',
    donePath: '/tmp/papercup-release-cut.done',
  });
});

describe('release:cut — preflight (read-only)', () => {
  it('returns the go/no-go, never launches', async () => {
    preflightM.mockReturnValue(mkPreflight());
    const b = body(await tool.handler({ op: 'preflight' } as never, { role: 'cup' } as never));
    expect(b).toMatchObject({ ok: true, op: 'preflight', go: true });
    expect(launchM).not.toHaveBeenCalled();
  });
  it('surfaces blockers when not ready', async () => {
    preflightM.mockReturnValue(mkPreflight({ go: false, blockers: ['signing-key: missing'] }));
    const b = body(await tool.handler({ op: 'preflight' } as never, { role: 'operator' } as never));
    expect(b.go).toBe(false);
    expect(b.note).toMatch(/signing-key: missing/);
  });
});

describe('release:cut — status (read-only)', () => {
  it('reports an in-flight cut without launching', async () => {
    const running: CutStatus = {
      state: 'running',
      running: true,
      exitCode: null,
      logTail: 'building…',
      logPath: '/tmp/papercup-release-cut.log',
      donePath: '/tmp/papercup-release-cut.done',
    };
    statusM.mockReturnValue(running);
    const b = body(await tool.handler({ op: 'status' } as never, { role: 'cup' } as never));
    expect(b).toMatchObject({ ok: true, op: 'status', state: 'running' });
    expect(b.note).toMatch(/in flight/);
    expect(launchM).not.toHaveBeenCalled();
  });
});

describe('release:cut — handoff (LOCAL deliverable)', () => {
  const found: HandoffResult = {
    version: '0.0.8',
    targetRoot: '/root/papercusp-desktop/src-tauri/target',
    scannedRoots: ['/root/papercusp-desktop/src-tauri/target'],
    found: true,
    artifacts: [
      { path: '/a/x.AppImage', name: 'x.AppImage', bytes: 1, sha256: 'deadbeef', signed: true },
    ],
    manifests: ['/a/latest.json'],
    provenance: ['/a/build-provenance.json'],
    unsignedNames: [],
    unsignedInfoNames: [],
  };

  it('rejects a malformed version before touching the fs', async () => {
    const b = body(await tool.handler({ op: 'handoff', version: 'v1.2' } as never, { role: 'cup' } as never));
    expect(b.refused).toBe(true);
    expect(b.reason).toMatch(/bad_version/);
    expect(handoffM).not.toHaveBeenCalled();
  });
  it('returns local paths + sha256 and the ship-gate reminder when all signed', async () => {
    handoffM.mockReturnValue(found);
    const b = body(await tool.handler({ op: 'handoff', version: '0.0.8' } as never, { role: 'cup' } as never));
    expect(b).toMatchObject({ ok: true, op: 'handoff', found: true });
    expect(b.artifacts[0]).toMatchObject({ sha256: 'deadbeef', signed: true });
    expect(b.shipGate).toMatch(/release-verify-provenance/);
    expect(b.note).toMatch(/Never publish to GitHub/i);
  });
  it('loudly blocks hand-off when an UPDATER artifact is unsigned', async () => {
    handoffM.mockReturnValue({ ...found, unsignedNames: ['x.AppImage'], artifacts: [{ ...found.artifacts[0]!, signed: false }] });
    const b = body(await tool.handler({ op: 'handoff', version: '0.0.8' } as never, { role: 'operator' } as never));
    expect(b.shipGate).toMatch(/UNSIGNED/);
    expect(b.shipGate).toMatch(/x\.AppImage/);
  });
  it('an unsigned NON-updater artifact (dmg) is informational, NOT a blocker (WI-4243)', async () => {
    handoffM.mockReturnValue({
      ...found,
      unsignedInfoNames: ['y_0.0.8.dmg'],
      artifacts: [
        ...found.artifacts,
        { path: '/a/y_0.0.8.dmg', name: 'y_0.0.8.dmg', bytes: 1, sha256: 'cafef00d', signed: false },
      ],
    });
    const b = body(await tool.handler({ op: 'handoff', version: '0.0.8' } as never, { role: 'operator' } as never));
    expect(b.shipGate).toMatch(/All updater artifacts are signed/);
    expect(b.shipGate).not.toMatch(/Do NOT hand these over/);
    expect(b.shipGate).toMatch(/y_0\.0\.8\.dmg/); // still disclosed, as info
    expect(b.shipGate).toMatch(/not a blocker/);
  });
  it('found:false when nothing was cut for that version', async () => {
    handoffM.mockReturnValue({ version: '0.0.9', targetRoot: '/t', scannedRoots: ['/t', '/cargo-t'], found: false, artifacts: [], manifests: [], provenance: [], unsignedNames: [], unsignedInfoNames: [] });
    const b = body(await tool.handler({ op: 'handoff', version: '0.0.9' } as never, { role: 'cup' } as never));
    expect(b.ok).toBe(false);
    expect(b.reason).toMatch(/no 0\.0\.9 artifacts/);
    expect(b.reason).toMatch(/\/cargo-t/); // every scanned root is named, not just src-tauri/target
  });
});

describe('release:cut — run (operator-gated write)', () => {
  const runArgs = { op: 'run', version: '0.0.8', channel: 'alpha' };

  it('is role-gated: a cup cannot cut, and no build fires', async () => {
    const b = body(await tool.handler({ ...runArgs, confirm: true } as never, { role: 'cup' } as never));
    expect(b.refused).toBe(true);
    expect(b.reason).toMatch(/role_forbidden/);
    expect(launchM).not.toHaveBeenCalled();
  });

  it('rejects a malformed version even for an operator', async () => {
    const b = body(await tool.handler({ op: 'run', version: 'bogus', channel: 'alpha', confirm: true } as never, { role: 'operator' } as never));
    expect(b.refused).toBe(true);
    expect(b.reason).toMatch(/bad_version/);
    expect(launchM).not.toHaveBeenCalled();
  });

  it('refuses to start a second cut when one is already in flight', async () => {
    preflightM.mockReturnValue(mkPreflight({}, /* inFlight */ true));
    const b = body(await tool.handler({ ...runArgs, confirm: true } as never, { role: 'operator' } as never));
    expect(b.refused).toBe(true);
    expect(b.reason).toMatch(/cut_in_flight/);
    expect(launchM).not.toHaveBeenCalled();
  });

  it('dry-run (no confirm) previews the exact LOCAL command and does NOT launch', async () => {
    const b = body(await tool.handler(runArgs as never, { role: 'operator' } as never));
    expect(b.dry_run).toBe(true);
    expect(b.localOnly).toBe(true);
    expect(b.wouldRun).toMatch(/systemd-run/);
    expect(b.wouldRun).toMatch(/release-local\.sh '0\.0\.8' 'alpha'/);
    expect(b.wouldRun).toContain("PAPERCUSP_PUBLISH_GITHUB='0'");
    expect(b.wouldRun).not.toMatch(/gh release|push origin/);
    expect(launchM).not.toHaveBeenCalled();
  });

  it('confirm:true fires the detached LOCAL cut', async () => {
    const b = body(await tool.handler({ ...runArgs, confirm: true, mac: true } as never, { role: 'operator' } as never));
    expect(b).toMatchObject({ ok: true, op: 'run', launched: true, localOnly: true });
    expect(launchM).toHaveBeenCalledWith({ version: '0.0.8', channel: 'alpha', legs: { mac: true, windows: undefined, arm64: undefined } });
  });
});

describe('release:cut — status (per-leg, WI-4233)', () => {
  it('passes platform through to readCutStatus and surfaces it in the reply', async () => {
    statusM.mockReturnValue({
      state: 'done',
      running: false,
      exitCode: 0,
      logTail: 'mac build ok',
      logPath: '/tmp/papercup-release-cut-mac.log',
      donePath: '/tmp/papercup-release-cut-mac.done',
    });
    const b = body(await tool.handler({ op: 'status', platform: 'mac' } as never, { role: 'cup' } as never));
    expect(statusM).toHaveBeenCalledWith({ platform: 'mac' });
    expect(b).toMatchObject({ ok: true, op: 'status', platform: 'mac', state: 'done' });
    expect(b.note).toMatch(/leg 'mac'/);
  });
});

describe('release:cut — gate-status (BUILD_SHA gate, WI-4233)', () => {
  const gate: ReleaseGate = {
    version: '0.0.8',
    channel: 'alpha',
    buildSha: 'abc1234',
    dirty: false,
    derivedAt: '2026-07-11T00:00:00.000Z',
    derivedBy: 'tester (role:cup)',
  };

  it('rejects a malformed version before touching the gate store', async () => {
    const b = body(await tool.handler({ op: 'gate-status', version: 'v1.2', channel: 'alpha' } as never, { role: 'cup' } as never));
    expect(b.refused).toBe(true);
    expect(b.reason).toMatch(/bad_version/);
    expect(gateM).not.toHaveBeenCalled();
  });
  it('open to any role (read/establish, not a heavy write) and reports created:true for the first caller', async () => {
    gateM.mockReturnValue({ gate, created: true });
    const b = body(await tool.handler({ op: 'gate-status', version: '0.0.8', channel: 'alpha' } as never, { role: 'cup' } as never));
    expect(b).toMatchObject({ ok: true, op: 'gate-status', created: true, buildSha: 'abc1234' });
    expect(b.note).toMatch(/Gate established/);
  });
  it('a later caller reading the existing gate gets created:false and a mismatch warning in the note', async () => {
    gateM.mockReturnValue({ gate, created: false });
    const b = body(await tool.handler({ op: 'gate-status', version: '0.0.8', channel: 'alpha' } as never, { role: 'cup' } as never));
    expect(b.created).toBe(false);
    expect(b.note).toMatch(/STOP/);
  });
});

describe('release:cut — abort-leg (operator-gated)', () => {
  it('is role-gated: a cup cannot abort a leg', async () => {
    const b = body(await tool.handler({ op: 'abort-leg', platform: 'mac' } as never, { role: 'cup' } as never));
    expect(b.refused).toBe(true);
    expect(b.reason).toMatch(/role_forbidden/);
    expect(abortLegM).not.toHaveBeenCalled();
  });
  it('an operator can stop a leg\'s unit', async () => {
    abortLegM.mockReturnValue({ stopped: true, unit: 'papercup-release-cut-mac' });
    const b = body(await tool.handler({ op: 'abort-leg', platform: 'mac' } as never, { role: 'operator' } as never));
    expect(b).toMatchObject({ ok: true, op: 'abort-leg', platform: 'mac', stopped: true, unit: 'papercup-release-cut-mac' });
    expect(abortLegM).toHaveBeenCalledWith('mac');
  });
  it('a failed stop reports ok:false with the reason, not a throw', async () => {
    abortLegM.mockReturnValue({ stopped: false, unit: 'papercup-release-cut-mac', reason: 'not loaded' });
    const b = body(await tool.handler({ op: 'abort-leg', platform: 'mac' } as never, { role: 'operator' } as never));
    expect(b.ok).toBe(false);
    expect(b.reason).toMatch(/not loaded/);
  });
});

describe('release:cut — run-leg (fleet-split, operator-gated write)', () => {
  const legArgs = { op: 'run-leg', platform: 'mac', version: '0.0.8', channel: 'alpha' };

  it('is role-gated: a cup cannot fire a leg', async () => {
    const b = body(await tool.handler({ ...legArgs, confirm: true } as never, { role: 'cup' } as never));
    expect(b.refused).toBe(true);
    expect(b.reason).toMatch(/role_forbidden/);
    expect(launchM).not.toHaveBeenCalled();
  });
  it('rejects a malformed version even for an operator', async () => {
    const b = body(await tool.handler({ ...legArgs, version: 'bogus', confirm: true } as never, { role: 'operator' } as never));
    expect(b.refused).toBe(true);
    expect(b.reason).toMatch(/bad_version/);
    expect(launchM).not.toHaveBeenCalled();
  });
  it('refuses to start a leg already in flight (checks its OWN unit, via preflightCut)', async () => {
    preflightM.mockReturnValue(mkPreflight({}, /* inFlight */ true));
    const b = body(await tool.handler({ ...legArgs, confirm: true } as never, { role: 'operator' } as never));
    expect(b.refused).toBe(true);
    expect(b.reason).toMatch(/cut_in_flight/);
    expect(preflightM).toHaveBeenCalledWith({ mac: true }, { platform: 'mac' });
    expect(launchM).not.toHaveBeenCalled();
  });
  it('dry-run (no confirm) previews the command scoped to just this leg and does NOT launch', async () => {
    const b = body(await tool.handler(legArgs as never, { role: 'operator' } as never));
    expect(b.dry_run).toBe(true);
    expect(b.platform).toBe('mac');
    expect(b.legs).toEqual({ mac: true });
    expect(b.unit).toBe('papercup-release-cut-mac');
    expect(b.wouldRun).toMatch(/--unit=papercup-release-cut-mac/);
    expect(launchM).not.toHaveBeenCalled();
  });
  it('confirm:true fires the detached LOCAL leg with only that platform\'s flag set', async () => {
    launchM.mockResolvedValue({
      launched: true,
      unit: 'papercup-release-cut-mac',
      version: '0.0.8',
      channel: 'alpha',
      legs: { mac: true },
      argv: [],
      logPath: '/tmp/papercup-release-cut-mac.log',
      donePath: '/tmp/papercup-release-cut-mac.done',
    });
    const b = body(await tool.handler({ ...legArgs, confirm: true } as never, { role: 'operator' } as never));
    expect(b).toMatchObject({ ok: true, op: 'run-leg', platform: 'mac', launched: true, localOnly: true, unit: 'papercup-release-cut-mac' });
    expect(launchM).toHaveBeenCalledWith({ version: '0.0.8', channel: 'alpha', legs: { mac: true }, platform: 'mac' });
  });
  it('a linux leg needs no WITH_* flag at all', async () => {
    launchM.mockResolvedValue({
      launched: true,
      unit: 'papercup-release-cut-linux',
      version: '0.0.8',
      channel: 'alpha',
      legs: {},
      argv: [],
      logPath: '/tmp/papercup-release-cut-linux.log',
      donePath: '/tmp/papercup-release-cut-linux.done',
    });
    const b = body(await tool.handler({ ...legArgs, platform: 'linux', confirm: true } as never, { role: 'operator' } as never));
    expect(b.legs).toEqual({});
    expect(launchM).toHaveBeenCalledWith({ version: '0.0.8', channel: 'alpha', legs: {}, platform: 'linux' });
  });
});
