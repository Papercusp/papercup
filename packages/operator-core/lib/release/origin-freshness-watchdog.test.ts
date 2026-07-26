/**
 * WI-5791 — coverage tests for `checkOriginFreshness`, the DB/registry WIRING.
 *
 * Why this file exists at all: `origin-freshness.test.ts` already covered the
 * pure verdict functions thoroughly, and every one of those tests passed for the
 * entire time this watchdog was completely blind. The untested half was never
 * "is the verdict right" — it was "does the sweep ever reach an entry to judge".
 * It did not: the sweep loaded ONE hard-coded workspace (`'default'`, which holds
 * only scratch pots) while every real bridged pot lives in another, so it
 * returned `checked: 0` on every pass and reported that as a clean bill of health.
 *
 * So these tests pin the two properties the pure tests structurally cannot:
 *   1. COVERAGE — the sweep reaches bridged entries in NON-default workspaces.
 *   2. SELF-REPORT — a sweep that covers nothing says so, instead of passing
 *      silently. That is the guard for the whole class (see
 *      agent-insights/absorbing-state-guards-and-self-report-detectors).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const registries = vi.hoisted(() => ({ byWorkspace: new Map<string, unknown[]>() }));
const gitModes = vi.hoisted(() => ({ byPotHome: new Map<string, string>() }));

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  existsSync: () => true, // the bare store is always "present" for these tests
}));
vi.mock('../harness-registry', () => ({
  loadHarnessRegistry: async (workspaceId?: string) => ({
    projects: registries.byWorkspace.get(String(workspaceId)) ?? [],
  }),
}));
vi.mock('../harness/git-sync/hive-git-mode', () => ({
  POT_GIT_MODE_SETTING_KEY: 'hiveGit.mode',
  getPotGitMode: async (_ws: string, potHomeSlug: string) => gitModes.byPotHome.get(potHomeSlug) ?? 'legacy',
}));
vi.mock('../sync/pot-git/repo-identity', () => ({ canonicalRepoKey: () => 'repo-key' }));
vi.mock('../sync/pot-git/github-ingress', () => ({ githubOriginDevicePubkey: () => 'pubkey' }));
vi.mock('../sync/pot-git/github-bridge-tick', () => ({ BRIDGE_CANONICAL_REF: 'refs/hive/staging' }));
vi.mock('../sync/pot-git/storage', () => ({
  hiveGitRepoPath: (potHome: string) => `/fake/${potHome}`,
  readNamespaceRef: async () => null,
  defaultRunGit: async () => ({ code: 0, stdout: '', stderr: '' }),
}));
// vitest 4 infers a vi.fn mock's Parameters from its initial implementation —
// a zero-arg arrow made `.mock.calls[N]` the empty tuple `[]`, so indexing
// `[0]` below (the event-payload assertions) failed to typecheck (TS2493)
// even though the real broadcast fns are always called with a payload. Rest
// params keep the mock bodies identical while giving `.mock.calls[N][0]` a
// real (unknown) element type for the existing `as {...}` casts to narrow.
const broadcasts = vi.hoisted(() => ({
  alarm: vi.fn(async (..._args: unknown[]) => true),
  resolved: vi.fn(async (..._args: unknown[]) => undefined),
}));
vi.mock('../severe-event-broadcast', () => ({
  broadcastSevereEvent: broadcasts.alarm,
  broadcastSevereEventResolvedMany: broadcasts.resolved,
}));

import { checkOriginFreshness } from './origin-freshness-watchdog';

/**
 * A postgres-template-tag stand-in that routes on the statement text. Records
 * every write so a test can assert what the sweep actually persisted.
 */
function makeSql(opts: { workspaceIds: string[]; bridgedPots: number; routineRow?: Record<string, unknown> }) {
  const writes: string[] = [];
  const sql = (strings: TemplateStringsArray, ...vals: unknown[]) => {
    const text = strings.join(' ? ');
    if (/^\s*(UPDATE|INSERT|DELETE)/i.test(text)) {
      writes.push(text.replace(/\s+/g, ' ').trim() + ' :: ' + JSON.stringify(vals));
      return Promise.resolve(Object.assign([], { count: 1 }));
    }
    if (/FROM harness_shared\.harness_registry/i.test(text)) {
      return Promise.resolve(opts.workspaceIds.map((workspace_id) => ({ workspace_id })));
    }
    if (/FROM harness_shared\.pot_settings/i.test(text)) {
      return Promise.resolve([{ n: opts.bridgedPots }]);
    }
    if (/FROM harness_shared\.routines/i.test(text)) {
      return Promise.resolve(opts.routineRow ? [opts.routineRow] : []);
    }
    return Promise.resolve([]);
  };
  return { sql: sql as never, writes };
}

const BRIDGED_ENTRY = { slug: 'papercusp', self_repo: true, github_remote: 'git@github.com:x/y.git' };

beforeEach(() => {
  registries.byWorkspace.clear();
  gitModes.byPotHome.clear();
  broadcasts.alarm.mockClear();
  broadcasts.resolved.mockClear();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

/**
 * The blindness broadcast is edge-triggered off MODULE-level state, so these
 * tests take a FRESH module instance each time — otherwise they'd silently
 * depend on execution order and stop testing the edge at all.
 */
async function freshWatchdog() {
  vi.resetModules();
  return (await import('./origin-freshness-watchdog')).checkOriginFreshness;
}

describe('WI-5791 — coverage: the sweep must reach every workspace, not just the default', () => {
  it('checks a bridged pot living in a NON-default workspace (the five-day blind spot)', async () => {
    registries.byWorkspace.set('papercusp-workspace', [BRIDGED_ENTRY]);
    registries.byWorkspace.set('default', []); // scratch workspace, as in production
    gitModes.byPotHome.set('papercusp', 'bridged');
    const { sql, writes } = makeSql({
      workspaceIds: ['default', 'papercusp-workspace'],
      bridgedPots: 1,
      routineRow: { egress_head: 'a'.repeat(40), of_origin_sha: null, of_origin_since_ms: null, of_alerted: false },
    });

    const res = await checkOriginFreshness(sql, {});

    expect(res.checked).toBe(1);
    expect(res.blind).toBeUndefined();
    // The watchdog's OWN watermark must actually persist — a detector whose
    // clock never lands can never age a tip, so it could never alarm.
    expect(writes.some((w) => w.includes('of_origin_sha'))).toBe(true);
  });

  it('a single unreadable workspace does not abort the sweep of the others', async () => {
    registries.byWorkspace.set('papercusp-workspace', [BRIDGED_ENTRY]);
    gitModes.byPotHome.set('papercusp', 'bridged');
    const { sql } = makeSql({
      workspaceIds: ['broken', 'papercusp-workspace'],
      bridgedPots: 1,
      routineRow: { egress_head: 'a'.repeat(40), of_origin_sha: null, of_origin_since_ms: null, of_alerted: false },
    });

    // 'broken' has no registry entry in the map → resolves to [], the same
    // shape an unreadable workspace degrades to.
    const res = await checkOriginFreshness(sql, {});
    expect(res.checked).toBe(1);
  });

  it('honours an explicit workspaceId (test/caller injection) instead of enumerating', async () => {
    registries.byWorkspace.set('only-this', [BRIDGED_ENTRY]);
    registries.byWorkspace.set('papercusp-workspace', [BRIDGED_ENTRY]);
    gitModes.byPotHome.set('papercusp', 'bridged');
    const { sql } = makeSql({
      workspaceIds: ['only-this', 'papercusp-workspace'],
      bridgedPots: 2,
      routineRow: { egress_head: 'a'.repeat(40), of_origin_sha: null, of_origin_since_ms: null, of_alerted: false },
    });

    const res = await checkOriginFreshness(sql, { workspaceId: 'only-this' });
    expect(res.checked).toBe(1); // not 2 — the explicit scope wins
  });
});

describe('WI-5791 — self-report: a sweep that covers nothing must not read as healthy', () => {
  it('flags itself BLIND when it checks zero entries while bridged pots exist', async () => {
    registries.byWorkspace.set('default', []); // exactly the production misconfiguration
    const { sql } = makeSql({ workspaceIds: ['default'], bridgedPots: 3 });

    const res = await checkOriginFreshness(sql, {});

    expect(res.checked).toBe(0);
    expect(res.blind).toBe(true);
  });

  it('does NOT flag blind when there are genuinely no bridged pots to watch', async () => {
    registries.byWorkspace.set('default', []);
    const { sql } = makeSql({ workspaceIds: ['default'], bridgedPots: 0 });

    const res = await checkOriginFreshness(sql, {});

    expect(res.checked).toBe(0);
    expect(res.blind).toBeUndefined(); // an empty install is not a broken watchdog
  });

  it('flags blind when workspace enumeration itself yields nothing', async () => {
    const { sql } = makeSql({ workspaceIds: [], bridgedPots: 2 });

    const res = await checkOriginFreshness(sql, {});

    expect(res.blind).toBe(true);
  });
});

describe('WI-5791 — the blindness alarm reaches a surface someone reads, without storming', () => {
  it('broadcasts a severe event the first time it goes blind', async () => {
    const check = await freshWatchdog();
    const { sql } = makeSql({ workspaceIds: ['default'], bridgedPots: 3 });

    await check(sql, {});

    expect(broadcasts.alarm).toHaveBeenCalledTimes(1);
    const ev = broadcasts.alarm.mock.calls[0][0] as { conditionKey: string; summary: string };
    expect(ev.conditionKey).toBe('origin-freshness:watchdog-blind');
    expect(ev.summary).toContain('BLIND');
  });

  it('does NOT re-broadcast on every subsequent blind sweep (15-min storm guard)', async () => {
    const check = await freshWatchdog();
    const { sql } = makeSql({ workspaceIds: ['default'], bridgedPots: 3 });

    // broadcastSevereEvent messages EVERY agent and does not dedupe on
    // conditionKey — so an un-edge-triggered alarm would page the whole fleet
    // every sweep, forever.
    await check(sql, {});
    await check(sql, {});
    await check(sql, {});

    expect(broadcasts.alarm).toHaveBeenCalledTimes(1);
  });

  it('retracts the alarm when coverage comes back', async () => {
    const check = await freshWatchdog();
    const blind = makeSql({ workspaceIds: ['default'], bridgedPots: 3 });
    await check(blind.sql, {});
    expect(broadcasts.alarm).toHaveBeenCalledTimes(1);

    registries.byWorkspace.set('papercusp-workspace', [BRIDGED_ENTRY]);
    gitModes.byPotHome.set('papercusp', 'bridged');
    const covered = makeSql({
      workspaceIds: ['papercusp-workspace'],
      bridgedPots: 3,
      routineRow: { egress_head: 'a'.repeat(40), of_origin_sha: null, of_origin_since_ms: null, of_alerted: false },
    });

    const res = await check(covered.sql, {});

    expect(res.blind).toBeUndefined();
    expect(broadcasts.resolved).toHaveBeenCalledTimes(1);
    const resolved = broadcasts.resolved.mock.calls[0][0] as { conditionKeys: string[] };
    expect(resolved.conditionKeys).toEqual(['origin-freshness:watchdog-blind']);
  });

  it('never broadcasts on a healthy covering sweep', async () => {
    const check = await freshWatchdog();
    registries.byWorkspace.set('papercusp-workspace', [BRIDGED_ENTRY]);
    gitModes.byPotHome.set('papercusp', 'bridged');
    const { sql } = makeSql({
      workspaceIds: ['papercusp-workspace'],
      bridgedPots: 1,
      routineRow: { egress_head: 'a'.repeat(40), of_origin_sha: null, of_origin_since_ms: null, of_alerted: false },
    });

    await check(sql, {});

    expect(broadcasts.alarm).not.toHaveBeenCalled();
    expect(broadcasts.resolved).not.toHaveBeenCalled();
  });
});
