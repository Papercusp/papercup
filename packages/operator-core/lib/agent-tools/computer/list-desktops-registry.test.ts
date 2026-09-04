/**
 * list-desktops-registry.test.ts — `computer:list_desktops` over the DesktopSession
 * REGISTRY, as opposed to the in-process lease Map that desktop-admin.test.ts covers.
 *
 * WHY THIS FILE EXISTS. The plan's A-bar ship clause reads "DesktopSession registry live
 * with xvfb-local + frame-slot kinds enumerable via computer:list_desktops". Two halves,
 * and only one of them had evidence:
 *
 *   - The registry half IS proven, against a real Postgres:
 *     desktop-session-registry.integration.test.ts's "enumerates EVERY kind" registers all
 *     five and asserts listDesktopSessions returns exactly that set.
 *   - The TOOL half had none. The only list_desktops test drove the LEASE fallback path
 *     (two pot leases, registry unavailable), so nothing anywhere asserted that the tool
 *     actually surfaces a registry row of a kind this process does not hold a handle for
 *     — which is the entire point of the clause. A frame-slot display lives in another
 *     process by definition, so if the mapper dropped it, every existing test would still
 *     pass and the clause would read as met while being false.
 *
 * It is a separate file rather than more cases in desktop-admin.test.ts because `vi.mock`
 * is file-scoped and hoisted: mocking the registry there would silently convert that
 * file's existing tests from "registry threw, degrade to local" to "registry returned
 * nothing", which is a different path than the one they were written to pin.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

// Hoisted so the vi.mock factory below can close over it without a TDZ error.
const { listDesktopSessions } = vi.hoisted(() => ({ listDesktopSessions: vi.fn() }));

vi.mock('../../desktop/desktop-session-registry', () => ({ listDesktopSessions }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-under-test' }));

import listTool from './list-desktops';

type Tool = { handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }> };
const list = listTool as unknown as Tool;
const CTX = {} as never;
const parse = (r: { content: Array<{ text: string }> }): Record<string, unknown> =>
  JSON.parse(r.content[0].text);

interface Row {
  kind: string;
  scopeRef: string;
  hostRef: string | null;
}
type Listed = Array<{
  kind: string;
  scopeRef: string;
  hostRef: string | null;
  registered: boolean;
  liveHandleInThisProcess: boolean;
  state: string;
}>;

/** A registry row with only the fields the tool's mapper actually reads. */
function row({ kind, scopeRef, hostRef }: Row): Record<string, unknown> {
  return {
    id: `id-${scopeRef}`,
    kind,
    scope: 'agent',
    scopeRef,
    hostRef,
    display: ':7',
    displayGeometry: { width: 1920, height: 1080 },
    captureGeometry: { width: 1024, height: 768 },
    state: 'ready',
    capabilities: {},
    lastActiveAt: null,
  };
}

afterEach(() => {
  listDesktopSessions.mockReset();
});

describe('computer:list_desktops — enumerating the DesktopSession registry (A-bar clause 1)', () => {
  it('surfaces BOTH xvfb-local and frame-slot rows from the registry', async () => {
    listDesktopSessions.mockResolvedValue([
      row({ kind: 'xvfb-local', scopeRef: 'sc-local', hostRef: null }),
      row({ kind: 'frame-slot', scopeRef: 'sc-frame', hostRef: 'frame-lat-1' }),
    ]);

    const r = parse(await list.handler({}, CTX));
    const desktops = r.desktops as Listed;

    expect(r.count).toBe(2);
    expect(desktops.map((d) => d.kind).sort()).toEqual(['frame-slot', 'xvfb-local']);
    // No `registryError`/`degraded` key: this list is the full inventory, not a fallback.
    expect(r.degraded).toBeUndefined();
  });

  it('passes through EVERY kind the registry returns, not a hardcoded subset', async () => {
    // The registry's kind set is open (vm-guest, bwrap, microvm, kasmvnc). A mapper that
    // filtered to the kinds this process can hold would pass the test above and still
    // hide a VM guest, so assert the whole set survives the hop.
    const kinds = ['xvfb-local', 'frame-slot', 'vm-guest', 'bwrap', 'microvm', 'kasmvnc'];
    listDesktopSessions.mockResolvedValue(
      kinds.map((kind) => row({ kind, scopeRef: `sc-${kind}`, hostRef: null })),
    );

    const r = parse(await list.handler({}, CTX));
    expect(new Set((r.desktops as Listed).map((d) => d.kind))).toEqual(new Set(kinds));
  });

  it('keeps workspace/harness scope in the outer envelope, not tool args', () => {
    const args = (listTool as unknown as { args: { safeParse: (value: unknown) => { success: boolean } } }).args;
    expect(args.safeParse({}).success).toBe(true);
    expect(args.safeParse({ workspace: 'papercusp-workspace', harness: 'papercusp' }).success).toBe(false);
  });

  it('marks a registry row this process holds no handle for as registered but NOT live', async () => {
    // D-004's invariant, made checkable: a row is a CLAIM about a process, not proof of
    // one. A frame-slot lives in another process by construction, so reporting it as live
    // here would be exactly the false-liveness reading the registry doc warns against.
    listDesktopSessions.mockResolvedValue([
      row({ kind: 'frame-slot', scopeRef: 'sc-frame', hostRef: 'frame-lat-1' }),
    ]);

    const [d] = parse(await list.handler({}, CTX)).desktops as Listed;
    expect(d.registered).toBe(true);
    expect(d.liveHandleInThisProcess).toBe(false);
    expect(d.hostRef).toBe('frame-lat-1');
  });

  it('CONTROL: says so loudly when the registry is unavailable, instead of reporting an empty inventory', async () => {
    // The failure this guards is a SHORT LIST read as "no desktops exist". Without this
    // case, a mapper that swallowed the error would look identical to a healthy empty
    // registry — and the three tests above would all still pass.
    listDesktopSessions.mockRejectedValue(new Error('no operator database'));

    const r = parse(await list.handler({}, CTX));
    expect(r.degraded).toBe('local-only');
    expect(r.registryError).toContain('no operator database');
  });
});
