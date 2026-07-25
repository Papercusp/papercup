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
vi.mock('../severe-event-broadcast', () => ({
  broadcastSevereEvent: async () => undefined,
  broadcastSevereEventResolvedMany: async () => undefined,
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
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

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
