/**
 * list-overrides.test.ts — the override-concern registry + the config:list-overrides TOOL
 * (live-configurability-audit-2026-06-20 P-024, reviewer gap #1 / D-005).
 *
 * Registry is the real singleton (we register fakes); getOrgPg + workspace-registry are mocked
 * so the audit lookup needs no PG. Asserts:
 *   • registry register/list/get round-trips + is idempotent by name.
 *   • the tool reports a concern's overrides (effective/layer/default).
 *   • the `concern` filter scopes to one concern.
 *   • the latest audit row is attached as lastChange (who/when).
 *   • failed reads remain unknown, preserve successful concerns and support a scoped retry.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/config/list-overrides.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Override ONLY getOrgPg / activeWorkspaceId, preserving the rest of each module — agent-mcp's
// bootstrap imports `generated` from @papercusp/db-org at load time, so a wholesale mock breaks it.
const { sqlMock } = vi.hoisted(() => ({ sqlMock: vi.fn(async () => [] as unknown[]) }));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOrgPg: () => ({ sql: sqlMock }),
}));
vi.mock('../../workspace-registry', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  activeWorkspaceId: () => 'default',
}));

import {
  registerOverrideConcern,
  listOverrideConcerns,
  getOverrideConcern,
  type OverrideConcern,
} from '../../config-overrides/registry';

const mod = await import('./list-overrides');
const tool = mod.default;

type Out = { content: { text: string }[] };
const body = (o: unknown) => JSON.parse((o as Out).content[0]!.text);

const fakeConcern = (over: Partial<OverrideConcern> = {}): OverrideConcern => ({
  name: 'fake-concern',
  description: 'a test concern',
  auditAction: 'demo:set',
  diff: async () => [{ key: 'x', effective: 5, default: 1, layer: 'pg-settings' }],
  capture: async () => ({}),
  reset: async () => ({}),
  restore: async () => {},
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  sqlMock.mockResolvedValue([]);
  registerOverrideConcern(fakeConcern());
});

describe('override-concern registry', () => {
  it('registers, lists, and gets a concern (idempotent by name)', () => {
    registerOverrideConcern(fakeConcern({ description: 'v2' }));
    expect(getOverrideConcern('fake-concern')?.description).toBe('v2');
    // same name registered twice => one entry
    expect(listOverrideConcerns().filter((c) => c.name === 'fake-concern')).toHaveLength(1);
  });
});

describe('config:list-overrides', () => {
  it('reports a concern\'s overrides (effective / layer / default)', async () => {
    const b = body(await tool.handler({ concern: 'fake-concern' } as never, {} as never));
    const c = b.concerns.find((x: { concern: string }) => x.concern === 'fake-concern');
    expect(c).toMatchObject({
      concern: 'fake-concern',
      status: 'measured',
      overrideCount: 1,
      overrides: [{ key: 'x', effective: 5, default: 1, layer: 'pg-settings' }],
    });
    expect(b).toMatchObject({ complete: true, totalOverrides: 1, measuredOverrides: 1, unmeasuredConcerns: [] });
  });

  it('scopes to one concern via the filter', async () => {
    registerOverrideConcern(fakeConcern({ name: 'other-concern' }));
    const b = body(await tool.handler({ concern: 'fake-concern' } as never, {} as never));
    expect(b.concerns).toHaveLength(1);
    expect(b.concerns[0].concern).toBe('fake-concern');
  });

  it('attaches the latest audit row as lastChange (who/when)', async () => {
    sqlMock.mockResolvedValue([{ actor: 'role:operator', ts: '1718900000000' }]);
    const b = body(await tool.handler({ concern: 'fake-concern' } as never, {} as never));
    expect(b.concerns[0].lastChange).toEqual({ actor: 'role:operator', ts: 1718900000000 });
  });

  it('distinguishes a successful empty read from an unavailable concern', async () => {
    registerOverrideConcern(fakeConcern({ diff: async () => [] }));
    const b = body(await tool.handler({ concern: 'fake-concern' } as never, {} as never));
    expect(b).toMatchObject({ complete: true, totalOverrides: 0, measuredOverrides: 0, unmeasuredConcerns: [] });
    expect(b.concerns[0]).toMatchObject({ status: 'measured', overrideCount: 0, overrides: [], recheck: null });
  });

  it('keeps failed reads unknown and recovers through the returned scoped recheck', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {}); // the fail-soft warn is expected here
    registerOverrideConcern(
      fakeConcern({ name: 'boom', auditAction: undefined, diff: async () => { throw new Error('kaboom'); } }),
    );
    try {
      const b = body(await tool.handler({ concern: 'boom' } as never, {} as never));
      expect(b).toMatchObject({ complete: false, totalOverrides: null, measuredOverrides: 0, unmeasuredConcerns: ['boom'] });
      expect(b.concerns[0]).toMatchObject({ concern: 'boom', status: 'unavailable', overrideCount: null,
        overrides: null, recheck: { tool: 'config:list-overrides', args: { concern: 'boom' } } });
      expect(warnSpy).toHaveBeenCalled();
      registerOverrideConcern(fakeConcern({ name: 'boom', auditAction: undefined }));
      const recovered = body(await tool.handler(b.concerns[0].recheck.args, {} as never));
      expect(recovered).toMatchObject({ complete: true, totalOverrides: 1, unmeasuredConcerns: [] });
      expect(recovered.concerns[0]).toMatchObject({ status: 'measured', overrideCount: 1,
        overrides: [{ key: 'x', effective: 5, default: 1, layer: 'pg-settings' }] });
    } finally { warnSpy.mockRestore(); }
  });

  it('retains healthy concerns when another concern fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    registerOverrideConcern(fakeConcern({ name: 'boom', diff: async () => { throw new Error('unavailable'); } }));
    try {
      const b = body(await tool.handler({} as never, {} as never));
      expect(b).toMatchObject({ complete: false, totalOverrides: null, unmeasuredConcerns: ['boom'] });
      expect(b.concerns.find((c: { concern: string }) => c.concern === 'fake-concern')).toMatchObject({
        status: 'measured', overrideCount: 1, overrides: [{ key: 'x', effective: 5, default: 1, layer: 'pg-settings' }],
      });
      expect(b.concerns.find((c: { concern: string }) => c.concern === 'boom')).toMatchObject({
        status: 'unavailable', overrideCount: null, overrides: null,
      });
    } finally { warnSpy.mockRestore(); }
  });

  it('distinguishes a failed audit lookup from a measured absence of audit history', async () => {
    sqlMock.mockRejectedValueOnce(new Error('audit unavailable'));
    const failed = body(await tool.handler({ concern: 'fake-concern' } as never, {} as never));
    expect(failed).toMatchObject({ complete: true, totalOverrides: 1, auditComplete: false });
    expect(failed.concerns[0]).toMatchObject({ lastChange: null, auditStatus: 'unavailable' });
    expect(failed.concerns[0].recheck).toEqual({ tool: 'config:list-overrides', args: { concern: 'fake-concern' } });
    const recovered = body(await tool.handler(failed.concerns[0].recheck.args, {} as never));
    expect(recovered).toMatchObject({ complete: true, auditComplete: true });
    expect(recovered.concerns[0]).toMatchObject({ lastChange: null, auditStatus: 'measured' });
  });
});
