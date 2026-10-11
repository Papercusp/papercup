/**
 * resolveWorkspaceForHarnessSlugIn — EI-19286551248996972 recurrence guard.
 *
 * A registry READ FAILING (a dead pool, a statement timeout, a transient PG blip)
 * used to be indistinguishable from a registry read SUCCEEDING and genuinely
 * finding no carrier: both paths swallowed the failure into a bare `catch {}` and
 * returned the same `null`. Every downstream caller (fill_workspace_id_from_projects
 * → resolvePlanScope → plans:list's regex-keyed swallow) then treated that `null` as
 * authoritative proof of non-registration — so a transient fault silently became the
 * confident assertion "register the harness", and `plans:list`/`plans:get` returned
 * `ok:true` with an EMPTY result for a harness that in fact carried 960 live rows
 * (the incident that filed this).
 *
 * These tests pin the fix at its source: a genuine read FAILURE now throws
 * {@link RegistryReadUnavailableError} — distinguishable from the unchanged, genuine
 * "found nothing" `null` path — so it propagates loudly instead of being folded into
 * the same silent-absence handling every downstream caller already has in place
 * (`fill_workspace_id_from_projects` / `resolvePlanScope` do not catch around this
 * call, so no further code changes were needed there; `plans:list`'s regex swallow
 * only matches the OLD "not registered"/"not a Hive home" phrasing, which this new
 * error's message deliberately does not contain).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HarnessRegistry, ProjectEntry } from './harness-registry';

// In-memory per-workspace registries the mocked loadHarnessRegistry reads from,
// OR a thrown failure when a workspace id is present in `failing`.
let registries: Record<string, ProjectEntry[]>;
let failing: Set<string>;

vi.mock('./harness-registry', () => ({
  loadHarnessRegistry: vi.fn(async (ws?: string): Promise<HarnessRegistry> => {
    const id = ws ?? 'default';
    if (failing.has(id)) throw new Error(`simulated registry read failure for workspace '${id}'`);
    return { projects: [...(registries[id] ?? [])] };
  }),
}));

vi.mock('./workspace-registry', () => ({
  readRegistry: vi.fn(() => ({
    current: 'default',
    workspaces: [{ id: 'default' }, { id: 'papercusp-workspace' }, { id: 'scratch' }],
  })),
  activeWorkspaceId: vi.fn(() => 'default'),
}));

import { resolveWorkspaceForHarnessSlugIn, RegistryReadUnavailableError, resolvePhasedProject } from './harness-core';

const entry = (slug: string, path: string): ProjectEntry => ({ slug, path, harness_kind: 'coding' });

beforeEach(() => {
  registries = {
    default: [entry('sheets', '/home/u/sheets')],
    'papercusp-workspace': [entry('papercup', '/home/u/papercup')],
    scratch: [],
  };
  failing = new Set();
});

describe('resolvePhasedProject workspace pin', () => {
  it('rejects a target registered only in another workspace', async () => {
    await expect(resolvePhasedProject('papercup', undefined, 'default')).resolves.toBeNull();
  });

  it('resolves the selected workspace registration when the same slug exists elsewhere', async () => {
    registries['papercusp-workspace'].push(entry('sheets', '/repos/foreign-sheets'));
    await expect(resolvePhasedProject('sheets', 'staging', 'default')).resolves.toMatchObject({ path: '/home/u/sheets' });
    await expect(resolvePhasedProject('sheets', 'staging', 'papercusp-workspace')).resolves.toMatchObject({ path: '/repos/foreign-sheets' });
  });

  it('preserves the unpinned cross-workspace resolver for non-request callers', async () => {
    await expect(resolvePhasedProject('papercup', undefined)).resolves.toMatchObject({ path: '/home/u/papercup' });
  });
});
afterEach(() => vi.clearAllMocks());

describe('resolveWorkspaceForHarnessSlugIn (EI-19286551248996972 — a read FAILURE must not read as a confirmed absence)', () => {
  it('unchanged fast path: found in the preferred workspace — no reads fail', async () => {
    await expect(resolveWorkspaceForHarnessSlugIn('default', 'sheets')).resolves.toBe('default');
  });

  it('unchanged fast path: found via the cross-workspace fallback', async () => {
    await expect(resolveWorkspaceForHarnessSlugIn('default', 'papercup')).resolves.toBe('papercusp-workspace');
  });

  it('unchanged: BOTH reads succeed and genuinely find nothing → null (a real absence, not a fault)', async () => {
    await expect(resolveWorkspaceForHarnessSlugIn('default', 'nope-does-not-exist')).resolves.toBeNull();
  });

  it('FIX: preferred-workspace read fails, cross-ws scan succeeds but finds nothing → throws RegistryReadUnavailableError, never null', async () => {
    failing.add('default');
    await expect(resolveWorkspaceForHarnessSlugIn('default', 'nope')).rejects.toBeInstanceOf(
      RegistryReadUnavailableError,
    );
  });

  it('FIX: cross-ws scan fails, preferred read succeeds but does not carry the slug → throws, never null', async () => {
    failing.add('papercusp-workspace');
    await expect(resolveWorkspaceForHarnessSlugIn('default', 'nope')).rejects.toBeInstanceOf(
      RegistryReadUnavailableError,
    );
  });

  it('a read FAILURE never masks a REAL find on the other leg: preferred read fails, cross-ws scan still finds the carrier', async () => {
    failing.add('default');
    // 'papercup' only lives in papercusp-workspace, which the cross-ws scan (unaffected
    // by the preferred-leg failure) still reads successfully.
    await expect(resolveWorkspaceForHarnessSlugIn('default', 'papercup')).resolves.toBe('papercusp-workspace');
  });

  it('the thrown error message does NOT contain the phrases plans:list / isUnresolvablePlanScopeError key off of', async () => {
    failing.add('default');
    failing.add('papercusp-workspace');
    failing.add('scratch');
    try {
      await resolveWorkspaceForHarnessSlugIn('default', 'nope');
      expect.unreachable('expected a throw');
    } catch (e) {
      expect(e).toBeInstanceOf(RegistryReadUnavailableError);
      const msg = (e as Error).message;
      expect(msg).not.toMatch(/not registered/i);
      expect(msg).not.toMatch(/not a Hive home/i);
      // Names the slug and states plainly that the READ failed, not that the harness
      // was confirmed absent.
      expect(msg).toContain('nope');
      expect(msg).toMatch(/read itself failed/i);
    }
  });

  it('unchanged: an ambiguous cross-workspace collision (2+ carriers) still throws the ORIGINAL collision error, not the new one', async () => {
    registries['papercusp-workspace'] = [entry('dup', '/a')];
    registries['scratch'] = [entry('dup', '/b')];
    await expect(resolveWorkspaceForHarnessSlugIn('default', 'dup')).rejects.toThrow(
      /registered in 2 workspaces/,
    );
  });
});
