/**
 * Recurrence guard for WI-40369 — second instance of the same class.
 *
 * `./switch` is imported for registration by
 * `endpoint-route/routes/index.ts`, so it evaluates inside ANY suite that
 * transitively pulls in the route registry. Many such suites install a PARTIAL
 * mock of the workspace registry — it is by a wide margin the most
 * partially-mocked module in operator-core:
 *
 *     vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: ... }));
 *
 * Under vitest, reading an export the mock factory does not define is a HARD
 * throw ("No \"workspacesRoot\" export is defined on the ... mock"), not
 * `undefined`. So the original
 *
 *     const REGISTRY_PATH = join(workspacesRoot(), 'registry.json');
 *
 * called the seam during module evaluation and stranded the ENTIRE unrelated
 * suite file at IMPORT — running zero tests, which is why this class lands in
 * vitest's "Failed Suites" block and never appears in the failed-TEST count.
 * Each stranded file passes when run SOLO (no co-resident mocker), so solo
 * reproduction cannot see this bug; only an in-lane run can.
 *
 * The fix defers the call into `registryPath()`, so only a request that
 * actually reaches the handler touches the seam.
 *
 * FALSIFIABILITY: restore the eager `const REGISTRY_PATH = join(...)` form in
 * ./switch.ts and the first test below fails at the dynamic import.
 */
import { describe, it, expect, vi } from 'vitest';

// The partial mock the stranding suites install: `activeWorkspaceId` only.
// Every OTHER export of the workspace registry is undefined-and-throwing here.
vi.mock('../../../workspace-registry', () => ({
  activeWorkspaceId: vi.fn(() => 'ws-test'),
}));

// Complete (not partial) — switch.ts uses exactly these two, so this mock
// keeps the test about the workspace-registry seam and nothing else.
vi.mock('@papercusp/agent-mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/agent-mcp')>()),
  defineTool: (def: unknown) => def,
  dispatchWorkspaceSwitch: vi.fn(),
}));

describe('workspaces/switch — lazy registry path (WI-40369)', () => {
  it('evaluates under a PARTIAL workspace-registry mock without throwing', async () => {
    await expect(import('./switch')).resolves.toBeDefined();
  });

  it('does not call `workspacesRoot` at module-eval time', async () => {
    // Positive control: the mock really IS partial, so a direct property read
    // throws. If this control ever stops throwing, the guard above proves
    // nothing and must be re-derived rather than trusted.
    const mod = (await import('../../../workspace-registry')) as Record<string, unknown>;
    expect(() => (mod as { workspacesRoot: unknown }).workspacesRoot).toThrow();
  });

  it('NEGATIVE CONTROL: the eager form really does die at import', async () => {
    // This is what makes the first test non-vacuous. `__fixtures__/eager-registry-path`
    // is a permanent, deliberately-wrong copy of the ORIGINAL switch.ts line —
    // `const X = join(workspacesRoot(), 'registry.json')` at module scope. Under
    // the same partial mock installed above, importing it MUST reject.
    //
    // Using a fixture rather than mutating switch.ts is deliberate: mutating a
    // tracked file on this shared tree races the git-sync sweep, which commits
    // the working tree on a schedule and can capture the mutant even when
    // nothing goes wrong. This control has no such window and cannot be skipped.
    //
    // If this test starts PASSING-BY-NOT-THROWING, the guard above is measuring
    // nothing — re-derive it before trusting a green run.
    await expect(import('./__fixtures__/eager-registry-path')).rejects.toThrow();
  });
});
