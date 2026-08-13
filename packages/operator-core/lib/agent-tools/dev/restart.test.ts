/**
 * dev:restart — target dispatch (dev/staging) + the WI-4221 staging
 * debounce/coalescing logic. `guardResource` (the drain+restart primitive)
 * is mocked — it already has its own coverage via
 * locks/__tests__/resource-lock-guard.integration.test.ts; this file's job
 * is the NEW behavior layered on top: target→{unit,resource} dispatch, the
 * cooldown-marker acquire-before-drain short-circuit, and releasing the
 * cooldown marker when a real restart attempt aborts after claiming it.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/dev/restart.test.ts
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('../locks/identity', () => ({
  readIdentity: vi.fn(() => ({ ownerId: 'me', ownerLabel: 'Me', coordinationDomain: 'dom' })),
}));
vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: vi.fn(() => ({ ownerId: 'me' })) }));
vi.mock('../locks/in-workspace-txn', () => ({
  inWorkspaceTxn: vi.fn(async (_d: string, _o: string, fn: (tx: unknown) => unknown) => fn({})),
}));
vi.mock('../locks/su-lock-store', () => ({
  tryAcquireResource: vi.fn(),
  tryReleaseResource: vi.fn(async () => ({ released: 1, releasedModes: ['exclusive'], exclusiveResources: [], waiters: {} })),
}));
vi.mock('../locks/resource-lock-guard', () => ({ guardResource: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(() => ({ unref: vi.fn() })) };
});
// EI-11137: the systemd truth-check that decides genuine-vs-phantom coalesce.
vi.mock('./systemd-service-probe', () => ({ probeServiceStart: vi.fn() }));
// EI-18661647550414959: the pre-kill "can this tree actually boot?" check. Mocked so
// the suite never shells out to systemctl; its own logic is covered in
// restart-preflight.test.ts. The default (set in beforeEach) is a clean tree.
vi.mock('./restart-preflight', () => ({ preflightRestartTarget: vi.fn() }));
// EI-18198340374286980: the audit_log writer — asserted directly in the new
// authorize-arg tests below, and must never make a real restart fail if it
// throws (fire-and-forget), so every OTHER test gets a working no-op stub.
// Partial mock (importOriginal): @papercusp/agent-mcp's own bootstrap imports
// OTHER exports (e.g. `generated`) from this same package — a full replacement
// breaks that unrelated import chain.
vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/db-org')>();
  return { ...actual, getOrgPg: vi.fn() };
});

import { tryAcquireResource, tryReleaseResource } from '../locks/su-lock-store';
import { guardResource } from '../locks/resource-lock-guard';
import { spawn } from 'node:child_process';
import { probeServiceStart } from './systemd-service-probe';
import { preflightRestartTarget } from './restart-preflight';
import { getOrgPg } from '@papercusp/db-org';

const acquireM = vi.mocked(tryAcquireResource);
const releaseM = vi.mocked(tryReleaseResource);
const guardM = vi.mocked(guardResource);
const spawnM = vi.mocked(spawn);
const probeM = vi.mocked(probeServiceStart);
const preflightM = vi.mocked(preflightRestartTarget);
/** A boot-integrity verdict. Defaults to an inspected, clean tree. */
const bootVerdict = (over: Record<string, unknown> = {}) =>
  ({
    target: 'dev',
    unit: 'papercup-dev-api.service',
    checked: true,
    ok: true,
    requestedRoot: '/tree/apps/operator',
    lockRoot: '/tree',
    missing: [],
    extraneous: [],
    note: 'clean',
    ...over,
  }) as never;
const orgPgM = vi.mocked(getOrgPg);
const auditUnsafeM = vi.fn(async (_query: string, _params: unknown[]) => undefined);

const restartModule = await import('./restart');
const tool = restartModule.default;
const { RESTART_TARGETS } = restartModule;

type Out = { content: { text: string }[] };
type Fence = { assertCurrent: () => Promise<{ current: boolean; reason?: string; live_fence_seq?: number }>; seq?: number };
const body = (o: Out) => JSON.parse(o.content[0]!.text);
const call = (args: Record<string, unknown>) => tool.handler(args as never, {} as never) as Promise<Out>;
/** Drive guardResource's mock as `(spec, run) => run(fence)` — a thin,
 *  explicitly-typed stand-in for the real drain+fence primitive (which has
 *  its own coverage elsewhere) so `run` never infers to `never` through the
 *  generic mock. */
const runGuard = (fence: Fence) => async (_spec: unknown, run: (f: Fence) => Promise<unknown>) => ({
  acquired: true,
  result: await run(fence),
  lock_id: 'L-test',
});
const fenceOk = (seq = 1): Fence => ({ assertCurrent: async () => ({ current: true }), seq });
const fenceStale = (seq = 1): Fence => ({ assertCurrent: async () => ({ current: false, reason: 'superseded', live_fence_seq: 2 }), seq });

const ORIGINAL_ENV = process.env.PAPERCUSP_ALLOW_DEV_RESTART;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.PAPERCUSP_ALLOW_DEV_RESTART;
  releaseM.mockResolvedValue({ released: 1, releasedModes: ['exclusive'], exclusiveResources: [], waiters: {} } as never);
  // Benign default: no live main process to report. Individual tests that care
  // about the coalesce-truth check or the restartedFromPid surfacing override it.
  probeM.mockResolvedValue({ ok: true, mainPid: 0 } as never);
  preflightM.mockResolvedValue(bootVerdict());
  auditUnsafeM.mockClear();
  orgPgM.mockReturnValue({ sql: { unsafe: auditUnsafeM } } as never);
});

afterAll(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.PAPERCUSP_ALLOW_DEV_RESTART;
  else process.env.PAPERCUSP_ALLOW_DEV_RESTART = ORIGINAL_ENV;
});

describe('dev:restart dry run', () => {
  it('registers every target resource and cooldown marker in the locks migration ledger', () => {
    const sqlDir = new URL('../../../../../libs/papercusp/packages/locks/src/sql/', import.meta.url).pathname;
    const migrations = readdirSync(sqlDir)
      .filter((name) => /^\d{3}-.*\.sql$/.test(name))
      .map((name) => readFileSync(join(sqlDir, name), 'utf8'))
      .join('\n');

    for (const { resource, cooldownResource } of Object.values(RESTART_TARGETS)) {
      expect(migrations, `missing agent_resource_registry seed for ${resource}`).toContain(`('${resource}',`);
      if (cooldownResource) {
        expect(migrations, `missing agent_resource_registry seed for ${cooldownResource}`).toContain(`('${cooldownResource}',`);
      }
    }
  });

  it('defaults target to dev and reports the dev unit', async () => {
    const b = body(await call({}));
    expect(b).toMatchObject({ ok: true, dry_run: true, target: 'dev', would_run: 'systemctl --user restart papercup-dev-api.service' });
    expect(b.note).not.toMatch(/coalesced/);
    expect(acquireM).not.toHaveBeenCalled();
  });

  it('chaining guidance includes both gates for a real restart', () => {
    expect(tool.guidance?.chaining).toMatch(/confirm:true/);
    expect(tool.guidance?.chaining).toMatch(/authorize:true/);
    expect(tool.guidance?.chaining).toMatch(/reason:/);
  });

  it('generated tool catalog preserves the real-restart enablement gates', () => {
    const catalogPath = new URL('../../../../../.papercusp/tool-catalog.json', import.meta.url).pathname;
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8')) as {
      tools: Array<{ name: string; description?: string; guidance?: { chaining?: string } }>;
    };
    const projected = catalog.tools.find((entry) => entry.name === 'dev:restart');

    expect(projected).toBeDefined();
    expect(projected?.description).toMatch(/authorize:true/);
    expect(projected?.guidance?.chaining).toMatch(/confirm:true/);
    expect(projected?.guidance?.chaining).toMatch(/authorize:true/);
    expect(projected?.guidance?.chaining).toMatch(/reason:/);
  });

  it('target:staging reports the staging unit + mentions the coalescing window', async () => {
    const b = body(await call({ target: 'staging' }));
    expect(b).toMatchObject({ ok: true, dry_run: true, target: 'staging', would_run: 'systemctl --user restart papercup-staging-api.service' });
    expect(b.note).toMatch(/coalesced/);
    expect(b.note).toMatch(/~2min/);
  });

  // EI-13307: bg-host's coalesce window is tuned to its REAL cost (the ~13min
  // cross-machine peer-log rejoin freeze, EI-13317) — NOT the generic ~2min
  // window shared by gateway/embed-sidecar. The dry-run note must say so.
  it('target:bg-host advertises its OWN wider ~13min coalescing window (EI-13307), not the generic ~2min one', async () => {
    const b = body(await call({ target: 'bg-host' }));
    expect(b).toMatchObject({ ok: true, dry_run: true, target: 'bg-host', would_run: 'systemctl --user restart papercup-bg-host.service' });
    expect(b.note).toMatch(/coalesced/);
    expect(b.note).toMatch(/~13min/);
    expect(b.note).toMatch(/EI-13307/);
    expect(b.note).toMatch(/EI-13317/);
    expect(b.note).not.toMatch(/~2min/);
  });

  it('target:gateway and target:embed-sidecar keep the generic ~2min window (unaffected by the bg-host widening)', async () => {
    for (const target of ['gateway', 'embed-sidecar'] as const) {
      const b = body(await call({ target }));
      expect(b.note).toMatch(/~2min/);
      expect(b.note).not.toMatch(/~13min/);
    }
  });

  it('takes no lock and drains nobody on a dry run', async () => {
    await call({ target: 'staging' });
    expect(acquireM).not.toHaveBeenCalled();
    expect(guardM).not.toHaveBeenCalled();
  });

  // EI-10896: the gateway/bg-host/embed-sidecar had NO sanctioned restart path —
  // the enum was ['dev','staging'] only, so a gateway fix could ONLY be landed by
  // the raw `systemctl` this tool's own guidance forbids. Guard that every shared
  // unit dispatches to its real systemd unit, and that each cooldown-bearing
  // (shared, coalescing) target advertises the debounce in its dry-run note. If a
  // target is dropped from the enum/TARGETS map, `cfg.unit` throws here.
  it.each([
    ['dev', 'papercup-dev-api.service', false],
    ['staging', 'papercup-staging-api.service', true],
    ['gateway', 'papercup-inference-gateway.service', true],
    ['bg-host', 'papercup-bg-host.service', true],
    ['embed-sidecar', 'papercup-embed-sidecar.service', true],
  ] as const)('target:%s dispatches to %s (coalescing note: %s)', async (target, unit, coalesces) => {
    const b = body(await call({ target }));
    expect(b).toMatchObject({ ok: true, dry_run: true, target, would_run: `systemctl --user restart ${unit}` });
    if (coalesces) expect(b.note).toMatch(/coalesced/);
    else expect(b.note).not.toMatch(/coalesced/);
    expect(acquireM).not.toHaveBeenCalled();
  });
});

// EI-18643120769203916: a withheld restart is a REFUSAL, not a partial success.
// The old code ran this check INSIDE guardResource, so an un-enabled call
// drained the target (leaving it quiesced on old code) and returned ok:true —
// which reads as "the restart happened" to any caller that checks `ok`.
describe('dev:restart confirm with PAPERCUSP_ALLOW_DEV_RESTART unset', () => {
  it('target:dev REFUSES with ok:false and does NOT drain — no guard, no lock, no audit — and the note points at authorize:true', async () => {
    guardM.mockImplementation(runGuard(fenceOk()) as never);
    const b = body(await call({ confirm: true }));
    expect(b).toMatchObject({
      ok: false,
      target: 'dev',
      reason: 'restart_withheld',
      restarted: false,
      drained: false,
    });
    expect(b.note).toMatch(/authorize:\s*true/);
    // The whole point: the refusal happens BEFORE any side effect.
    expect(guardM).not.toHaveBeenCalled();
    // dev has no cooldownResource — the debounce path must never engage for it.
    expect(acquireM).not.toHaveBeenCalled();
    expect(auditUnsafeM).not.toHaveBeenCalled();
    expect(spawnM).not.toHaveBeenCalled();
  });

  it('target:staging is refused the same way — no drain, and the cooldown marker is never claimed (nothing real happened to debounce)', async () => {
    guardM.mockImplementation(runGuard(fenceOk()) as never);
    const b = body(await call({ confirm: true, target: 'staging' }));
    expect(b).toMatchObject({
      ok: false,
      target: 'staging',
      reason: 'restart_withheld',
      restarted: false,
      drained: false,
    });
    expect(guardM).not.toHaveBeenCalled();
    expect(acquireM).not.toHaveBeenCalled();
    expect(auditUnsafeM).not.toHaveBeenCalled();
    expect(spawnM).not.toHaveBeenCalled();
  });

  it('the refusal states plainly that nothing was done, so ok:false is not read as "drained but not restarted"', async () => {
    guardM.mockImplementation(runGuard(fenceOk()) as never);
    const b = body(await call({ confirm: true, target: 'bg-host' }));
    expect(b).toMatchObject({ ok: false, drained: false, restarted: false });
    expect(b.note).toMatch(/NOTHING was done/i);
    expect(b.note).toMatch(/papercup-bg-host\.service/);
  });
});

// EI-18198340374286980: an agent cannot set PAPERCUSP_ALLOW_DEV_RESTART on the
// already-running operator process — authorize:true is the in-band equivalent,
// still gated behind confirm:true (the deliberate-action + drain gate), and
// always audited (unlike the raw-systemctl bypass it exists to replace).
// EI-18661647550414959. Unit-testing the preflight proves nothing about whether
// dev:restart CALLS it — these are the call-site assertions. The failure being
// prevented: a restart that returns {ok:true, restarted:true} and then crash-loops
// the service on `[boot-integrity] FATAL` (exit 78), taking routines/git-sync down
// fleet-wide, which is exactly what happened on 2026-07-25.
describe('dev:restart boot-integrity preflight', () => {
  const inconsistent = bootVerdict({ ok: false, missing: ['hono', 'postgres'], note: '[boot-integrity] /tree is INCONSISTENT' });

  it('REFUSES an inconsistent tree and does NOT drain, lock, restart or audit', async () => {
    // guardResource is deliberately left UNARMED: if the refusal ever regressed, the
    // handler would call it and fail loudly rather than quietly restarting.
    preflightM.mockResolvedValue(inconsistent);

    const b = body(await call({ confirm: true, authorize: true, target: 'dev', reason: 'x' }));

    expect(b).toMatchObject({
      ok: false,
      target: 'dev',
      reason: 'boot_integrity_inconsistent',
      restarted: false,
      drained: false,
      boot_integrity: { checked: true, missing: ['hono', 'postgres'] },
    });
    // The whole point: the host is left UP on working code. Nothing was disturbed.
    expect(guardM).not.toHaveBeenCalled();
    expect(spawnM).not.toHaveBeenCalled();
    expect(acquireM).not.toHaveBeenCalled();
    expect(auditUnsafeM).not.toHaveBeenCalled();
  });

  it('runs the preflight BEFORE the drain, against the requested target', async () => {
    preflightM.mockResolvedValue(inconsistent);
    await call({ confirm: true, authorize: true, target: 'bg-host', reason: 'x' });
    expect(preflightM).toHaveBeenCalledWith('bg-host');
  });

  // The mirror of the refusal test above: reaching guardResource IS the proof that the
  // preflight did not block. Asserted that way (rather than by driving a full restart)
  // so this needs no `as never` on the generic guard signature — the lint:mock-cast-escape
  // ratchet is shrink-only, and these tests do not need to climb it.
  it('override_boot_integrity:true proceeds — the restart may itself be the remedy', async () => {
    preflightM.mockResolvedValue(inconsistent);
    await call({ confirm: true, authorize: true, target: 'dev', reason: 'x', override_boot_integrity: true }).catch(
      () => undefined,
    );
    expect(guardM).toHaveBeenCalled();
  });

  // Fails OPEN: a guard that cannot run must never be the reason a wedged host stays
  // wedged. `checked:false` is NOT a clean bill, but it is also not a blocker.
  it('proceeds when the tree could not be inspected (checked:false, ok:true)', async () => {
    preflightM.mockResolvedValue(bootVerdict({ checked: false, lockRoot: null, reason: 'no package-lock.json' }));
    await call({ confirm: true, authorize: true, target: 'dev', reason: 'x' }).catch(() => undefined);
    expect(guardM).toHaveBeenCalled();
  });

  it('previews the verdict in the DRY RUN, where the decision is actually made', async () => {
    preflightM.mockResolvedValue(inconsistent);
    const b = body(await call({ target: 'dev' }));
    expect(b).toMatchObject({
      ok: true,
      dry_run: true,
      boot_integrity: { checked: true, would_block: true, tree: '/tree', missing: ['hono', 'postgres'] },
    });
  });
});

describe('dev:restart confirm:true + authorize:true, PAPERCUSP_ALLOW_DEV_RESTART unset', () => {
  it('fires a real restart on authorize:true alone (no env var needed) and writes an audit_log row tagged viaAuthorizeArg', async () => {
    guardM.mockImplementation(runGuard(fenceOk(5)) as never);

    const b = body(await call({ confirm: true, authorize: true, reason: 'landing WI-5471 fix on bg-host', target: 'dev' }));

    expect(b).toMatchObject({ ok: true, target: 'dev', restarted: true, drained: true, enabledVia: 'authorize_arg', audited: true });
    expect(spawnM).toHaveBeenCalledWith('sh', ['-c', expect.stringContaining('papercup-dev-api.service')], expect.anything());
    expect(auditUnsafeM).toHaveBeenCalledTimes(1);
    const [, params] = auditUnsafeM.mock.calls[0]!;
    expect(params[3]).toBe('dev:restart'); // action
    expect(params[4]).toBe('dev'); // subject = target
    const details = JSON.parse(params[5] as string);
    expect(details).toMatchObject({ target: 'dev', viaEnv: false, viaAuthorizeArg: true, reason: 'landing WI-5471 fix on bg-host' });
  });

  it('confirm:true alone (authorize omitted, no env) still withholds — authorize does not implicitly follow from confirm', async () => {
    guardM.mockImplementation(runGuard(fenceOk()) as never);
    const b = body(await call({ confirm: true, target: 'dev' }));
    expect(b).toMatchObject({ ok: false, target: 'dev', reason: 'restart_withheld', restarted: false });
    expect(auditUnsafeM).not.toHaveBeenCalled();
  });

  it('authorize:true WITHOUT confirm:true stays a dry run — authorize never bypasses the drain gate', async () => {
    const b = body(await call({ authorize: true, target: 'dev' }));
    expect(b).toMatchObject({ ok: true, dry_run: true, target: 'dev' });
    expect(guardM).not.toHaveBeenCalled();
    expect(spawnM).not.toHaveBeenCalled();
    expect(auditUnsafeM).not.toHaveBeenCalled();
  });
});

describe('dev:restart confirm with PAPERCUSP_ALLOW_DEV_RESTART=1, target:staging', () => {
  beforeEach(() => {
    process.env.PAPERCUSP_ALLOW_DEV_RESTART = '1';
  });

  it('claims the cooldown marker, drains+restarts, and does NOT release the cooldown on success', async () => {
    acquireM.mockResolvedValue({ ok: true, mode: 'exclusive', status: 'held', lock_id: 'COOL1', expires_ts: new Date(), shared_holders: [], fence_seq: 1 } as never);
    guardM.mockImplementation(runGuard(fenceOk(9)) as never);
    // EI-11137: the pre-restart MainPID is captured so the caller can verify a real cycle.
    probeM.mockResolvedValue({ ok: true, mainPid: 4242, secondsSinceStart: 9999 } as never);

    const b = body(await call({ confirm: true, target: 'staging' }));

    expect(acquireM).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ resource: 'staging-server-cooldown', mode: 'exclusive', ttlSec: 120 }),
    );
    expect(b).toMatchObject({ ok: true, target: 'staging', restarted: true, drained: true, restartedFromPid: 4242, enabledVia: 'env', audited: true });
    expect(b.verifyWith).toMatch(/MainPID/);
    expect(b).not.toHaveProperty('phantomCoalesceBroken');
    expect(spawnM).toHaveBeenCalledWith('sh', ['-c', expect.stringContaining('papercup-staging-api.service')], expect.anything());
    // Left to expire, not released — the debounce depends on this.
    expect(releaseM).not.toHaveBeenCalled();
    // EI-18198340374286980: a real restart is ALWAYS audited, even via the env route.
    expect(auditUnsafeM).toHaveBeenCalledTimes(1);
    const details = JSON.parse(auditUnsafeM.mock.calls[0]![1][5] as string);
    expect(details).toMatchObject({ target: 'staging', viaEnv: true, viaAuthorizeArg: false, reason: null });
  });

  it('coalesces when the marker is held AND systemd confirms a genuine recent restart — no drain, no restart, no spawn', async () => {
    acquireM.mockResolvedValue({
      ok: false,
      reason: 'held_exclusive',
      holders: [{ owner: 'peer-1', owner_label: 'peer-one', mode: 'exclusive', status: 'held', reason: '', expires_ts: new Date() }],
    } as never);
    // EI-11137: the service really did restart 12s ago (< 120s window) — genuine coalesce.
    probeM.mockResolvedValue({ ok: true, mainPid: 555, secondsSinceStart: 12 } as never);

    const b = body(await call({ confirm: true, target: 'staging' }));

    expect(b).toMatchObject({ ok: true, target: 'staging', restarted: false, coalesced: true, verified: true, restartedSecondsAgo: 12, mainPid: 555 });
    expect(b.note).toMatch(/peer-one/);
    expect(guardM).not.toHaveBeenCalled();
    expect(spawnM).not.toHaveBeenCalled();
  });

  it('EI-11137: PHANTOM coalesce — marker held but systemd shows NO recent restart ⇒ refuses to coalesce and fires a real restart', async () => {
    // The reported wedge: a bg-host marker is held, but the service last started
    // long ago (older than the cooldown). Must NOT coalesce — must restart.
    acquireM.mockResolvedValue({
      ok: false,
      reason: 'held_exclusive',
      holders: [{ owner: 'stale-peer', owner_label: 'stale-one', mode: 'exclusive', status: 'held', reason: '', expires_ts: new Date() }],
    } as never);
    probeM.mockResolvedValue({ ok: true, mainPid: 909, secondsSinceStart: 6 * 3600 } as never); // 6h ago
    guardM.mockImplementation(runGuard(fenceOk(7)) as never);

    const b = body(await call({ confirm: true, target: 'bg-host' }));

    expect(b).toMatchObject({ ok: true, target: 'bg-host', restarted: true, restartedFromPid: 909 });
    expect(b.coalesced).toBeUndefined();
    // EI-13307: bg-host's cooldown is now the widened ~13min (780s) window, not the generic 120s one.
    expect(b.phantomCoalesceBroken).toMatchObject({ staleMarkerHolder: 'stale-one', serviceSecondsSinceStart: 6 * 3600, cooldownSec: 13 * 60 });
    expect(spawnM).toHaveBeenCalledWith('sh', ['-c', expect.stringContaining('papercup-bg-host.service')], expect.anything());
  });

  it('EI-11137: down service (MainPID 0) is NOT a recent restart ⇒ marker treated as phantom, restart fires', async () => {
    acquireM.mockResolvedValue({
      ok: false,
      reason: 'held_exclusive',
      holders: [{ owner: 'stale-peer', owner_label: 'stale-one', mode: 'exclusive', status: 'held', reason: '', expires_ts: new Date() }],
    } as never);
    probeM.mockResolvedValue({ ok: true, mainPid: 0 } as never); // no live main process
    guardM.mockImplementation(runGuard(fenceOk(1)) as never);

    const b = body(await call({ confirm: true, target: 'bg-host' }));

    expect(b).toMatchObject({ ok: true, target: 'bg-host', restarted: true });
    expect(b.phantomCoalesceBroken).toMatchObject({ serviceSecondsSinceStart: null });
    expect(spawnM).toHaveBeenCalled();
  });

  it('EI-11137: unverifiable (probe failed) falls back to trusting the marker, flagged verified:false', async () => {
    acquireM.mockResolvedValue({
      ok: false,
      reason: 'held_exclusive',
      holders: [{ owner: 'peer-1', owner_label: 'peer-one', mode: 'exclusive', status: 'held', reason: '', expires_ts: new Date() }],
    } as never);
    probeM.mockResolvedValue({ ok: false } as never); // no systemd / probe error

    const b = body(await call({ confirm: true, target: 'staging' }));

    expect(b).toMatchObject({ ok: true, target: 'staging', restarted: false, coalesced: true, verified: false });
    expect(b.note).toMatch(/could NOT be verified/i);
    expect(guardM).not.toHaveBeenCalled();
    expect(spawnM).not.toHaveBeenCalled();
  });

  it('releases the cooldown marker if the drain/restart step aborts after claiming it (stale fence)', async () => {
    acquireM.mockResolvedValue({ ok: true, mode: 'exclusive', status: 'held', lock_id: 'COOL2', expires_ts: new Date(), shared_holders: [], fence_seq: 1 } as never);
    guardM.mockImplementation(runGuard(fenceStale()) as never);

    const b = body(await call({ confirm: true, target: 'staging' }));

    expect(b).toMatchObject({ ok: false, target: 'staging', reason: 'stale_fence_superseded' });
    expect(releaseM).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ lockId: 'COOL2' }));
  });

  it('releases the cooldown marker if the drain-gate itself never grants (e.g. drain_timeout)', async () => {
    acquireM.mockResolvedValue({ ok: true, mode: 'exclusive', status: 'held', lock_id: 'COOL3', expires_ts: new Date(), shared_holders: [], fence_seq: 1 } as never);
    guardM.mockResolvedValue({ acquired: false, reason: 'drain_timeout', holders: [] } as never);

    const b = body(await call({ confirm: true, target: 'staging' }));

    expect(b).toMatchObject({ ok: false, target: 'staging', reason: 'resource_drain_timeout', resource: 'staging-server' });
    expect(releaseM).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ lockId: 'COOL3' }));
  });
});

describe('dev:restart confirm with PAPERCUSP_ALLOW_DEV_RESTART=1, target:bg-host (EI-13307 widened cooldown)', () => {
  beforeEach(() => {
    process.env.PAPERCUSP_ALLOW_DEV_RESTART = '1';
  });

  it('claims the bg-host cooldown marker with the WIDENED ~13min TTL (780s), not the generic 120s one', async () => {
    acquireM.mockResolvedValue({ ok: true, mode: 'exclusive', status: 'held', lock_id: 'COOL-BG', expires_ts: new Date(), shared_holders: [], fence_seq: 1 } as never);
    guardM.mockImplementation(runGuard(fenceOk(11)) as never);
    probeM.mockResolvedValue({ ok: true, mainPid: 7777, secondsSinceStart: 99999 } as never);

    const b = body(await call({ confirm: true, target: 'bg-host' }));

    expect(acquireM).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ resource: 'bg-host-cooldown', mode: 'exclusive', ttlSec: 13 * 60 }),
    );
    expect(b).toMatchObject({ ok: true, target: 'bg-host', restarted: true, drained: true, restartedFromPid: 7777 });
    // (b): the result states the rail-freeze cost explicitly, referencing EI-13317.
    expect(b.note).toMatch(/~13min/);
    expect(b.note).toMatch(/EI-13317/);
  });

  it('a restart request ~10min (600s) after a peer\'s real bg-host restart COALESCES under the widened window — the exact storm from EI-13307 (old 120s window would have fired a fresh restart here)', async () => {
    acquireM.mockResolvedValue({
      ok: false,
      reason: 'held_exclusive',
      holders: [{ owner: 'peer-2', owner_label: 'peer-two', mode: 'exclusive', status: 'held', reason: '', expires_ts: new Date() }],
    } as never);
    // 600s ago: outside the OLD 120s window (would have been a phantom / real
    // restart under the pre-fix code) but well inside the NEW 780s window.
    probeM.mockResolvedValue({ ok: true, mainPid: 8888, secondsSinceStart: 600 } as never);

    const b = body(await call({ confirm: true, target: 'bg-host' }));

    expect(b).toMatchObject({ ok: true, target: 'bg-host', restarted: false, coalesced: true, verified: true, restartedSecondsAgo: 600, mainPid: 8888 });
    expect(b.note).toMatch(/peer-two/);
    expect(guardM).not.toHaveBeenCalled();
    expect(spawnM).not.toHaveBeenCalled();
  });

  it('a restart request >13min (900s) after a peer\'s real bg-host restart is OUTSIDE even the widened window — fires a genuine restart', async () => {
    acquireM.mockResolvedValue({
      ok: false,
      reason: 'held_exclusive',
      holders: [{ owner: 'peer-3', owner_label: 'peer-three', mode: 'exclusive', status: 'held', reason: '', expires_ts: new Date() }],
    } as never);
    probeM.mockResolvedValue({ ok: true, mainPid: 4321, secondsSinceStart: 900 } as never);
    guardM.mockImplementation(runGuard(fenceOk(12)) as never);

    const b = body(await call({ confirm: true, target: 'bg-host' }));

    expect(b).toMatchObject({ ok: true, target: 'bg-host', restarted: true, restartedFromPid: 4321 });
    expect(b.coalesced).toBeUndefined();
    expect(b.phantomCoalesceBroken).toMatchObject({ staleMarkerHolder: 'peer-three', serviceSecondsSinceStart: 900, cooldownSec: 13 * 60 });
  });
});

describe('dev:restart confirm with PAPERCUSP_ALLOW_DEV_RESTART=1, target:dev (unaffected by the debounce)', () => {
  beforeEach(() => {
    process.env.PAPERCUSP_ALLOW_DEV_RESTART = '1';
  });

  it('never touches the cooldown machinery for dev', async () => {
    guardM.mockImplementation(runGuard(fenceOk(3)) as never);
    const b = body(await call({ confirm: true }));
    expect(b).toMatchObject({ ok: true, target: 'dev', restarted: true });
    expect(acquireM).not.toHaveBeenCalled();
    expect(releaseM).not.toHaveBeenCalled();
    expect(spawnM).toHaveBeenCalledWith('sh', ['-c', expect.stringContaining('papercup-dev-api.service')], expect.anything());
  });
});
