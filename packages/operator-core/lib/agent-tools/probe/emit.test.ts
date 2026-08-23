/**
 * emit.test.ts — probe:emit declares ONLY arguments it can actually honour.
 *
 * WI-35901: probe:emit used to declare an `expectedHops` argument that was
 * accepted, echoed back as `hopsExpected`, and then silently dropped — it was
 * never passed to stampProbe, never reached insertProbe, had no field on
 * StampedProbe, and had no `expected_hops` column in any migration. So a caller
 * who narrowed at emit and then read with `probe:get { probeKey }` got exactly
 * the false "stalled" verdict the argument claimed to prevent.
 *
 * Resolved by deleting the argument (route (b)) rather than persisting it:
 * nothing records the later hops in the first place (WI-3962 — zero
 * recordProbeHop callers, and the merged/memberGuard/projected hops are observed
 * on the RECEIVER, whose local federation_probes has no row for the key), so a
 * per-probe declaration of which of six hops to expect would be scaffolding for
 * an observation plane that is not wired. Narrowing is a READ-time concern and
 * lives on probe:get, which implements it correctly.
 *
 * What this guards: re-adding a decorative argument to probe:emit. The failure
 * being prevented is not "a wrong value" but "an argument that silently does
 * nothing", which type-checks, passes review, and is only discovered by someone
 * trusting it in an incident.
 *
 * In-tree (operator-core, pure — no DB).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/probe/emit.test.ts
 */
import { describe, expect, it, vi } from 'vitest';

// Import-time isolation only: keep this in the pure lane by stopping the store
// and registry modules from reaching for a database. The subject under test is
// the declared ARGUMENT SURFACE, not the handler's behaviour.
vi.mock('../../sync/pot-git/federation-probe-store', () => ({
  insertProbe: vi.fn(),
  insertRefusedProbe: vi.fn(),
}));
// Partial mocks: keep every real export so an unrelated consumer in the import
// graph does not fail collection, and override only the two calls that would
// otherwise reach a registry.
vi.mock('../../harness-registry', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isRegisteredHive: vi.fn(async () => true),
}));
vi.mock('../../workspace-registry', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  activeWorkspaceId: vi.fn(() => 'default'),
}));
vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: vi.fn(() => ({ ownerId: 'su-test', workspaceId: 'ws-1' })) }));

const emitTool = (await import('./emit')).default;
const getTool = (await import('./get')).default;

const argKeys = (tool: { args: unknown }): string[] => {
  const shape = (tool.args as { shape?: Record<string, unknown> }).shape;
  // Fail loudly rather than return [] — an empty list from a broken shape lookup
  // would make every absence assertion below pass vacuously.
  if (!shape || typeof shape !== 'object') {
    throw new Error('could not read the tool zod shape — this guard cannot assert an absence without it');
  }
  return Object.keys(shape);
};

describe('probe:emit argument surface (WI-35901)', () => {
  it('declares harnessSlug — the calibration case that proves the shape lookup works', () => {
    // Without this, "expectedHops is absent" could pass simply because the shape
    // read returned nothing. An absence claim needs a positive control.
    expect(argKeys(emitTool)).toContain('harnessSlug');
  });

  it('does NOT declare expectedHops — it cannot be persisted, so it must not be accepted', () => {
    expect(argKeys(emitTool)).not.toContain('expectedHops');
  });

  it('declares nothing beyond what it consumes', () => {
    // Deliberately exact, not a subset check: a new decorative argument should
    // fail here and be forced to justify itself, which is the whole defect class.
    expect(argKeys(emitTool).sort()).toEqual(['harnessSlug']);
  });

  it('keeps the read-time narrowing on probe:get, which is where it actually works', () => {
    // The other half of WI-35901: emit losing the argument is only correct
    // because get still has one. If this ever fails, narrowing has no home at
    // all and the verdict silently reads never-expected hops as stalled.
    expect(argKeys(getTool)).toContain('expectedHops');
  });
});
