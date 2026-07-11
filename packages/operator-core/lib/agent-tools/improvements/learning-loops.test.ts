/**
 * learning-loops.test.ts — the improvements:learning_loops HANDLER (the health composer +
 * the routines query mocked). Demonstrates the DUAL sql mock: the routines read uses sql
 * both as a tagged template (the query) AND as an IN-clause helper (sql([...]) / sql(names))
 * — one mock fn branches on `first.raw`. Pins the handler's genuine logic: the workspace
 * resolution and the row→routine mapping (snake→camel, active coercion, Date→ISO|null) fed
 * to computeLearningLoopHealth, plus the { ok, workspaceId, summary, loops } projection. A
 * regression in that mapping (e.g. a Date not ISO-ified, or active left raw) is what this
 * catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/improvements/learning-loops.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: vi.fn(() => ({
    // One fn serves both shapes: a tagged-template call (first arg has .raw) resolves the
    // rows; an sql([...]) IN-clause helper call returns an opaque fragment.
    sql: (first: unknown) =>
      first && (first as { raw?: unknown }).raw ? Promise.resolve(h.rows) : { __frag: first },
  })),
}));
vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: vi.fn(() => ({})) }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'default') }));
vi.mock('../../harness/operator-home-harness', () => ({ operatorHomeHarnessSlug: vi.fn(() => 'acme-home') }));
vi.mock('../../blueprint/seed-learning-singletons', () => ({
  LEARNING_SINGLETONS: [{ blueprintId: 'calibration', legacyRoutine: 'calib-legacy' }],
}));
vi.mock('../../blueprint/learning-loop-health', () => ({
  computeLearningLoopHealth: vi.fn(() => [{ loop: 'calibration', state: 'firing' }]),
  computeActivityLaneHealth: vi.fn((lane: { blueprintId: string; lastActivityAt: string | null; source: string }) => ({
    ...lane,
    status: lane.lastActivityAt ? 'firing' : 'dark-by-design',
  })),
  summarizeLearningLoopHealth: vi.fn(() => ({ firing: 1, dark: 0 })),
  singletonRoutineName: vi.fn((id: string) => `sg:${id}`),
  SINGLETON_HOST_SLUG: '@singleton',
}));

import { computeLearningLoopHealth } from '../../blueprint/learning-loop-health';
const computeM = vi.mocked(computeLearningLoopHealth);
const tool = (await import('./learning-loops')).default;

type Out = { content: { text: string }[] };
const body = (o: Out) => JSON.parse(o.content[0]!.text);

beforeEach(() => {
  vi.clearAllMocks();
  h.rows = [
    { install_slug: '@singleton', name: 'sg:calibration', active: true, last_fired_at: new Date('2026-01-01T00:00:00Z'), next_fire_at: null },
  ];
});

describe('improvements:learning_loops handler', () => {
  it('maps routine rows (snake→camel, Date→ISO|null) and projects the health', async () => {
    const b = body(await tool.handler({} as never, { workspaceId: 'ws-1' } as never) as Out);
    expect(b).toMatchObject({
      ok: true,
      workspaceId: 'ws-1',
      summary: { firing: 1, dark: 0 },
      loops: [
        { loop: 'calibration' },
        { blueprintId: 'su-ideation', status: 'dark-by-design' },
      ],
    });
    // the row→routine mapping fed to the composer
    const routines = computeM.mock.calls[0]![1] as unknown as Array<Record<string, unknown>>;
    expect(routines[0]).toEqual({
      installSlug: '@singleton', name: 'sg:calibration', active: true,
      lastFiredAt: '2026-01-01T00:00:00.000Z', nextFireAt: null,
    });
    expect(computeM.mock.calls[0]![2]).toMatchObject({ homeSlug: 'acme-home' });
  });

  it('coerces a null/absent active and falls back to the active workspace', async () => {
    h.rows = [{ install_slug: 'acme-home', name: 'calib-legacy', active: null, last_fired_at: null, next_fire_at: new Date('2026-02-01T00:00:00Z') }];
    const b = body(await tool.handler({} as never, {} as never) as Out);
    expect(b.workspaceId).toBe('default'); // no ctx workspace → activeWorkspaceId()
    const routines = computeM.mock.calls[0]![1] as unknown as Array<Record<string, unknown>>;
    expect(routines[0]).toMatchObject({ active: false, lastFiredAt: null, nextFireAt: '2026-02-01T00:00:00.000Z' });
  });
});
