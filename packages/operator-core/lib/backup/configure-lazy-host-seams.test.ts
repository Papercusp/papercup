/**
 * Recurrence guard for WI-40369.
 *
 * `./configure` is imported for its SIDE EFFECT (`configureBackup({...})` runs
 * at module-eval time), and it is reachable from the agent-tools registry
 * import graph — which unrelated prompt/registry suites pull in transitively.
 * Those suites routinely install a PARTIAL mock of `../workspace-registry`:
 *
 *     vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: ... }));
 *
 * Under vitest, reading a property the mock factory does not define is a HARD
 * throw ("No \"workspacesRoot\" export is defined on the ... mock"), not
 * `undefined`. So passing an imported binding straight into the config object
 * literal dereferences it during that evaluation and fails the ENTIRE
 * unrelated suite file at import — which is exactly what red-pinned
 * lib/agent-tools/oracle/prompts.test.ts and the three
 * lib/agent-tools/operator/__tests__/converse-prompt-*.test.ts files in the
 * green-checkpoint operator-core lane (each passed when run solo).
 *
 * The fix is that every host seam handed to `configureBackup` is a THUNK, so
 * the source module is not dereferenced until the seam is actually called —
 * which a unit suite that merely loads the registry never does.
 *
 * FALSIFIABILITY: revert `workspacesRoot: () => workspacesRoot()` in
 * ./configure.ts back to the bare shorthand `workspacesRoot,` and this test
 * fails at the dynamic import below.
 */
import { describe, it, expect, vi } from 'vitest';

// The exact partial mock the stranded suites install: `activeWorkspaceId` only.
// Every OTHER export of ../workspace-registry is undefined-and-throwing here.
vi.mock('../workspace-registry', () => ({
  activeWorkspaceId: vi.fn(() => 'ws-test'),
}));

describe('backup host binding — lazy host seams (WI-40369)', () => {
  it('evaluates ./configure under a PARTIAL ../workspace-registry mock without throwing', async () => {
    await expect(import('./configure')).resolves.toBeDefined();
  });

  it('does not read `workspacesRoot` off the module at import time', async () => {
    // Positive control: the mock really is partial, so a direct property read
    // DOES throw. If this control stops throwing, the guard above proves
    // nothing and must be re-derived rather than trusted.
    const mod = (await import('../workspace-registry')) as Record<string, unknown>;
    // The OLD eager form — `workspacesRoot,` shorthand in the config literal —
    // is exactly this property read, and it throws.
    expect(() => (mod as { workspacesRoot: unknown }).workspacesRoot).toThrow();
    // The CURRENT lazy form defers the same read into a thunk, so building the
    // config object is safe; only CALLING the seam would touch the mock.
    expect(() => ({
      workspacesRoot: () => (mod as { workspacesRoot: () => string }).workspacesRoot(),
    })).not.toThrow();
  });
});
